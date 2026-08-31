import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import type { QuotaPressure } from '../runners/runner.types';
import {
  QUOTA_EVENTS_DEFAULT_PAGE_SIZE,
  QUOTA_WINDOWS_DEFAULT_PAGE_SIZE,
  type ExhaustedWindowView,
  type RateLimitEpisodeView,
} from './dto/quota-history.dto';
import {
  RATE_LIMIT_REASONS,
  matchWindow,
  toEpisode,
  type EpisodeEscalation,
  type EpisodeFacts,
  type EpisodeWindow,
  type RateLimitReason,
} from './quota-history';

/**
 * The read side of rate-limit history (#476). **Writes nothing, ever.**
 *
 * ## Where the data comes from, and why no table was added
 *
 * `dto/quota-history.dto.ts` carries the full argument; the short version is
 * that `run_events` already owns "a run was blocked, for this reason, until
 * this instant" and `quota_windows` already owns "this vendor window reached
 * this peak". A `rate_limit_episodes` table would be a second expression of
 * both, which ADR-0018 §1 rules out. This class joins them and interprets the
 * result; `quota-history.ts` does the interpreting, purely, so the claims this
 * endpoint makes are testable without a database.
 *
 * ## The index this is shaped for
 *
 * `run_events_blocked_occurred_at_idx` is a PARTIAL index —
 * `(occurred_at) WHERE blocked_reason IS NOT NULL`. Every query below that
 * touches `run_events` therefore emits `blocked_reason IS NOT NULL`
 * explicitly, even where a `reason` filter would already imply it, and
 * compares `occurred_at` against plain bounds with no function wrapped around
 * the column. Getting either wrong turns the endpoint's whole reason for
 * existing into a sequential scan of the highest-volume table in the schema.
 *
 * ## Fixed query count, no N+1
 *
 * A page of episodes costs five queries at most, whatever the page size: the
 * page itself, its count, then one each for the page's runs' other blocks,
 * their escalations, and the windows those blocks name. Nothing is looked up
 * per row. That is the discipline `QuotaService.loadConsumption` adopted for
 * #301, and for the same reason — `run_events` is the table where an N+1 stops
 * being a style question.
 */
@Injectable()
export class QuotaHistoryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Rate-limit episodes, newest first.
   *
   * One episode per `run.blocked` event that named a subscription-level
   * reason, carrying what Opifex did about it. See `deriveDisposition` in
   * `quota-history.ts` for how "what Opifex did" is concluded and what it
   * refuses to guess.
   */
  async episodes(query: {
    page?: number;
    pageSize?: number;
    since?: string;
    until?: string;
    runnerKey?: string;
    reason?: RateLimitReason;
  }): Promise<{
    items: RateLimitEpisodeView[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  }> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? QUOTA_EVENTS_DEFAULT_PAGE_SIZE;

    const where: Prisma.RunEventWhereInput = {
      blockedReason: {
        // `not: null` is stated EVEN THOUGH `in` already implies it. It is what
        // matches the partial index's own predicate literally, so the planner
        // reaches for `run_events_blocked_occurred_at_idx` rather than relying
        // on proving the implication. The `in` then narrows to the two
        // subscription-level reasons — `awaiting-approval`,
        // `upstream-unavailable` and `unknown` are blocks about ONE RUN and are
        // not quota history (see `RATE_LIMIT_REASONS`).
        not: null,
        in: query.reason ? [query.reason] : [...RATE_LIMIT_REASONS],
      },
      // Plain bounds on the raw column, deliberately: any function around
      // `occurred_at` here would make the index above unusable.
      ...(query.since || query.until
        ? {
            occurredAt: {
              ...(query.since ? { gte: new Date(query.since) } : {}),
              ...(query.until ? { lte: new Date(query.until) } : {}),
            },
          }
        : {}),
      // The runner is a property of the RUN, not of the event — a block is
      // suffered by whichever runner was executing, and `run_events` has no
      // runner column of its own to duplicate it into.
      ...(query.runnerKey ? { run: { runnerKey: query.runnerKey } } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.runEvent.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        // Newest first, then two tiebreaks. Two events can share a reported
        // millisecond, and an unstable sort would shuffle them between pages so
        // a reader sees one twice and another never. `EventsService` stops at
        // `recordedAt`; `id` is added here because `recordedAt` can tie too on
        // a batch ingest, and a history endpoint that drops a row is worse than
        // one a microsecond out of order.
        orderBy: [
          { occurredAt: 'desc' },
          { recordedAt: 'desc' },
          { id: 'desc' },
        ],
        select: {
          id: true,
          occurredAt: true,
          blockedReason: true,
          blockedUntil: true,
          runId: true,
          run: {
            select: {
              runnerKey: true,
              status: true,
              resumesAt: true,
              endedAt: true,
              // Denormalized onto the run precisely so age questions are a
              // column read. See `boundedAt` for what it is used for here.
              lastEventAt: true,
              workOrder: {
                select: {
                  identity: true,
                  issueNumber: true,
                  repository: { select: { owner: true, name: true } },
                },
              },
            },
          },
        },
      }),
      this.prisma.runEvent.count({ where }),
    ]);

    if (rows.length === 0) {
      return {
        items: [],
        total,
        page,
        pageSize,
        totalPages: pages(total, pageSize),
      };
    }

    const runIds = [...new Set(rows.map((row) => row.runId))];
    const runnerKeys = [...new Set(rows.map((row) => row.run.runnerKey))];
    const resetInstants = distinctInstants(
      rows.map((row) => row.blockedUntil).filter(isDate),
    );

    const [blocksByRun, escalationsByRun, windows] = await Promise.all([
      this.blocksByRun(runIds),
      this.escalationsByRun(runIds),
      this.windowsFor(runnerKeys, resetInstants),
    ]);

    const items = rows.map((row) => {
      const blocks = blocksByRun.get(row.runId) ?? [];
      const facts: EpisodeFacts = {
        eventId: row.id,
        occurredAt: row.occurredAt,
        blockedUntil: row.blockedUntil,
        // Non-null and one of the two by the `where` above. The cast names
        // that rather than re-checking it: `blocked_reason` is a free TEXT
        // column, so the compiler cannot see the filter that narrowed it.
        reason: row.blockedReason as RateLimitReason,
        runId: row.runId,
        runnerKey: row.run.runnerKey,
        runStatus: row.run.status,
        runResumesAt: row.run.resumesAt,
        runEndedAt: row.run.endedAt,
        runLastEventAt: row.run.lastEventAt,
        workOrderIdentity: row.run.workOrder.identity,
        repository: `${row.run.workOrder.repository.owner}/${row.run.workOrder.repository.name}`,
        issueNumber: row.run.workOrder.issueNumber,
        nextBlockAt: nextBlockAfter(blocks, row.occurredAt),
        escalations: escalationsByRun.get(row.runId) ?? [],
        window: matchWindow(row.run.runnerKey, row.blockedUntil, windows),
      };
      return toEpisode(facts);
    });

    return { items, total, page, pageSize, totalPages: pages(total, pageSize) };
  }

  /**
   * Windows that ever hit the wall, newest reset first.
   *
   * The sibling half of #476, and the half `GET /api/quota/events`
   * structurally cannot answer: a window that reached `exhausted` while
   * nothing was dispatched against it blocks no run, writes no `run_events`
   * row, and is therefore invisible to an endpoint built on blocked events —
   * while still being a true answer to "when did we hit rate limits".
   * `blockedRuns: 0` is exactly that case, and #476's added acceptance
   * criterion is that it stays distinguishable from a window that did block
   * runs.
   *
   * `peakPressure` rather than `pressure` is the filter, for the reason
   * `QuotaWindow`'s own schema comment gives: `pressure` forgets the wall the
   * moment the vendor says `allowed` again, and this endpoint is read after
   * the fact by definition.
   */
  async exhaustedWindows(query: {
    page?: number;
    pageSize?: number;
    since?: string;
    until?: string;
    runnerKey?: string;
  }): Promise<{
    items: ExhaustedWindowView[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  }> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? QUOTA_WINDOWS_DEFAULT_PAGE_SIZE;

    const where: Prisma.QuotaWindowWhereInput = {
      peakPressure: 'exhausted',
      ...(query.runnerKey ? { runnerKey: query.runnerKey } : {}),
      // An OVERLAP test against the window's observation span, not a
      // comparison against a single instant: a window is a stretch of time,
      // and one first sighted before the range but still exhausted inside it
      // is exactly what the operator is looking for.
      ...(query.until
        ? { firstObservedAt: { lte: new Date(query.until) } }
        : {}),
      ...(query.since
        ? { lastObservedAt: { gte: new Date(query.since) } }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.quotaWindow.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        // Newest window first, with the runner and kind as stable tiebreaks:
        // two runners routinely report the same reset instant, and one runner
        // holds a `five_hour` and a `weekly` at once.
        orderBy: [{ resetsAt: 'desc' }, { runnerKey: 'asc' }, { kind: 'asc' }],
        select: {
          runnerKey: true,
          kind: true,
          resetsAt: true,
          pressure: true,
          peakPressure: true,
          firstObservedAt: true,
          lastObservedAt: true,
          observations: true,
        },
      }),
      this.prisma.quotaWindow.count({ where }),
    ]);

    if (rows.length === 0) {
      return {
        items: [],
        total,
        page,
        pageSize,
        totalPages: pages(total, pageSize),
      };
    }

    const blocked = await this.blocksAgainst(
      [...new Set(rows.map((row) => row.runnerKey))],
      distinctInstants(rows.map((row) => row.resetsAt)),
    );

    return {
      items: rows.map((row) => {
        const tally = blocked.get(windowKey(row.runnerKey, row.resetsAt));
        return {
          runnerKey: row.runnerKey,
          kind: row.kind,
          resetsAt: row.resetsAt.toISOString(),
          pressure: row.pressure as QuotaPressure,
          peakPressure: row.peakPressure as QuotaPressure,
          firstObservedAt: row.firstObservedAt.toISOString(),
          lastObservedAt: row.lastObservedAt.toISOString(),
          observations: row.observations,
          blockedRuns: tally?.runs.size ?? 0,
          blockedEvents: tally?.events ?? 0,
        };
      }),
      total,
      page,
      pageSize,
      totalPages: pages(total, pageSize),
    };
  }

  /**
   * Every subscription-level block on the page's runs, oldest first.
   *
   * ALL of them, not only the ones on this page: `nextBlockAt` has to be the
   * run's actual next block, and a run's second block can easily sit on the
   * previous page or outside the `since`/`until` filter entirely. Bounded by
   * construction — a run blocks a handful of times, not once per tool call —
   * which is what makes loading them wholesale cheaper than asking per row.
   */
  private async blocksByRun(runIds: string[]): Promise<Map<string, Date[]>> {
    const rows = await this.prisma.runEvent.findMany({
      where: {
        runId: { in: runIds },
        // Same literal predicate as the page query, same partial index.
        blockedReason: { not: null, in: [...RATE_LIMIT_REASONS] },
      },
      orderBy: { occurredAt: 'asc' },
      select: { runId: true, occurredAt: true },
    });

    const byRun = new Map<string, Date[]>();
    for (const row of rows) {
      const seen = byRun.get(row.runId) ?? [];
      seen.push(row.occurredAt);
      byRun.set(row.runId, seen);
    }
    return byRun;
  }

  /**
   * Every escalation on the page's runs.
   *
   * Unfiltered by kind or time on purpose: which escalation belongs to which
   * episode is a rule (`episodeEscalation` in `quota-history.ts`), and a rule
   * expressed half in SQL and half in TypeScript is a rule nobody can read in
   * one place. Bounded for the same reason as the blocks above — escalations
   * are per incident, not per event.
   */
  private async escalationsByRun(
    runIds: string[],
  ): Promise<Map<string, EpisodeEscalation[]>> {
    const rows = await this.prisma.escalation.findMany({
      where: { runId: { in: runIds } },
      orderBy: { raisedAt: 'asc' },
      select: {
        runId: true,
        kind: true,
        status: true,
        raisedAt: true,
        summary: true,
      },
    });

    const byRun = new Map<string, EpisodeEscalation[]>();
    for (const row of rows) {
      if (!row.runId) continue;
      const seen = byRun.get(row.runId) ?? [];
      seen.push({
        kind: row.kind,
        status: row.status,
        raisedAt: row.raisedAt,
        summary: row.summary,
      });
      byRun.set(row.runId, seen);
    }
    return byRun;
  }

  /** The stored windows the page's blocks name. See `matchWindow`. */
  private async windowsFor(
    runnerKeys: string[],
    resetInstants: Date[],
  ): Promise<(EpisodeWindow & { runnerKey: string })[]> {
    if (resetInstants.length === 0) return [];

    const rows = await this.prisma.quotaWindow.findMany({
      where: { runnerKey: { in: runnerKeys }, resetsAt: { in: resetInstants } },
      select: {
        runnerKey: true,
        kind: true,
        resetsAt: true,
        pressure: true,
        peakPressure: true,
        firstObservedAt: true,
        lastObservedAt: true,
        observations: true,
      },
    });

    return rows.map((row) => ({
      ...row,
      pressure: row.pressure as QuotaPressure,
      peakPressure: row.peakPressure as QuotaPressure,
    }));
  }

  /**
   * How many runs and how many blocks landed against each of these windows.
   *
   * The same exact-instant join `matchWindow` makes, run in the other
   * direction. Keyed on `runnerKey` AND `resetsAt` because two runners
   * genuinely report the same reset instant, and counting one runner's blocks
   * against another's window would invent the very thing this endpoint exists
   * to report honestly.
   */
  private async blocksAgainst(
    runnerKeys: string[],
    resetInstants: Date[],
  ): Promise<Map<string, { runs: Set<string>; events: number }>> {
    const rows = await this.prisma.runEvent.findMany({
      where: {
        blockedReason: { not: null, in: [...RATE_LIMIT_REASONS] },
        blockedUntil: { in: resetInstants },
        run: { runnerKey: { in: runnerKeys } },
      },
      select: {
        runId: true,
        blockedUntil: true,
        run: { select: { runnerKey: true } },
      },
    });

    const tally = new Map<string, { runs: Set<string>; events: number }>();
    for (const row of rows) {
      if (!row.blockedUntil) continue;
      const key = windowKey(row.run.runnerKey, row.blockedUntil);
      const seen = tally.get(key) ?? { runs: new Set<string>(), events: 0 };
      seen.runs.add(row.runId);
      seen.events += 1;
      tally.set(key, seen);
    }
    return tally;
  }
}

/**
 * The first block on this run strictly after `at`, or null when there is none.
 *
 * Null therefore means "this is the run's latest block", which is what
 * `deriveDisposition` keys its live-state verdicts on — see
 * `EPISODE_DISPOSITIONS`. Strictly after, so a block never bounds itself.
 */
function nextBlockAfter(blocks: readonly Date[], at: Date): Date | null {
  for (const block of blocks) {
    if (block.getTime() > at.getTime()) return block;
  }
  return null;
}

/**
 * De-duplicate instants by their epoch value.
 *
 * `Date` objects are compared by reference in a `Set`, so two rows carrying the
 * same instant would produce two entries and an `IN` list twice as long as it
 * needs to be.
 */
function distinctInstants(instants: readonly Date[]): Date[] {
  return [...new Map(instants.map((at) => [at.getTime(), at])).values()];
}

/** A window's identity for tallying: one runner, one reset instant. */
function windowKey(runnerKey: string, resetsAt: Date): string {
  return `${runnerKey} ${resetsAt.getTime()}`;
}

function isDate(value: Date | null): value is Date {
  return value !== null;
}

/** `totalPages` for the `flat` list shape. Zero rows is zero pages. */
function pages(total: number, pageSize: number): number {
  return Math.ceil(total / pageSize);
}
