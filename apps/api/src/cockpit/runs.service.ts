import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { UNRESOLVED } from '../escalations/escalations.service';
import {
  fromPrismaEventSource,
  fromPrismaEventType,
} from '../run-events/run-event.types';
import { PrismaService } from '../prisma/prisma.service';
import { toNumberOrNull } from '../common/decimal';
import {
  RUNS_DEFAULT_PAGE_SIZE,
  EVENTS_DEFAULT_PAGE_SIZE,
  type RunEventView,
  type RunSummary,
} from './dto/runs.dto';

/**
 * Runs, as the operator reads them.
 *
 * ## `needsAttention` is the escalation lifecycle, not a status list
 *
 * The obvious implementation is `status IN (stalled, failed, quarantined)`.
 * It is wrong, and the way it is wrong matters: **it never drains.** A run
 * that failed last Tuesday is still `failed` today, so the attention panel
 * fills with history and the one thing that needs a human right now is on
 * page three.
 *
 * #57 already built the mechanism for "a human has not dealt with this":
 * an escalation, with a lifecycle that ends at `acknowledged` or `resolved`.
 * That is what drains, and it is what the notification path already dedupes
 * on. So this filter reuses `UNRESOLVED` from `EscalationsService` rather
 * than declaring its own list — two lists would drift, and the two
 * disagreeing means the panel shows a run nobody will be told about, or hides
 * one somebody already was.
 *
 * ## The lag this accepts, and why it is bounded
 *
 * A run can carry `attentionReason` before any escalation exists for it — the
 * poller writes that field the moment it finds a run with no handle
 * (`run-poller.service.ts`), and the escalation is raised later. In that
 * window this filter does not list the run, which was worth checking rather
 * than assuming: a probe against real PostgreSQL confirmed the state is
 * reachable.
 *
 * It closes on its own. The watchdog sweeps `running` AND `stalled` runs, so
 * a lost-handle run is judged on the next tick and escalated once it has been
 * silent long enough — bounded by the tick interval plus the silence
 * threshold, not indefinite.
 *
 * Widening the filter to `attentionReason IS NOT NULL` would trade that
 * bounded lag for an unbounded one in the other direction: nothing clears
 * `attentionReason`, so an acknowledged run would sit in the panel forever and
 * the operator would learn to ignore it. A stale attention list is worse than
 * a slightly late one, because only one of them still means anything.
 */
@Injectable()
export class RunsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: {
    page?: number;
    pageSize?: number;
    needsAttention?: boolean;
    status?: string;
  }): Promise<{ items: RunSummary[]; total: number; page: number; pageSize: number }> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? RUNS_DEFAULT_PAGE_SIZE;

    const where: Prisma.RunWhereInput = {
      ...(query.status ? { status: query.status as Prisma.RunWhereInput['status'] } : {}),
      ...(query.needsAttention
        ? { escalations: { some: { status: { in: UNRESOLVED as never } } } }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.run.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        // Oldest SILENCE first when filtering for attention, because that is
        // the age the panel is about: a run happily working for six hours is
        // not the problem, one silent for six minutes is. `lastEventAt` nulls
        // first puts a run that has never reported anything at the very top —
        // which is the worst case, not a missing value to sort past.
        //
        // Unfiltered, newest first is what a list screen wants instead.
        orderBy: query.needsAttention
          ? [{ lastEventAt: { sort: 'asc', nulls: 'first' } }]
          : [{ startedAt: 'desc' }],
        select: RUN_SELECT,
      }),
      this.prisma.run.count({ where }),
    ]);

    return { items: rows.map(toRunSummary), total, page, pageSize };
  }

  async findById(id: string): Promise<RunSummary> {
    const row = await this.prisma.run.findUnique({ where: { id }, select: RUN_SELECT });
    if (!row) throw new NotFoundException(`Run ${id} not found`);
    return toRunSummary(row);
  }

  /**
   * One run's event timeline, paginated.
   *
   * #80 is explicit that `RunEvent` is high-volume (#39) and that *"a
   * run-detail endpoint that returns every event unpaginated will not survive
   * a real run"*. A single Claude Code run emits a `run.progress` per tool
   * call plus heartbeats — thousands of rows for a long one — so the timeline
   * is its own endpoint rather than an array hanging off the detail, which
   * makes the pagination impossible to forget rather than easy to.
   *
   * Newest first: an operator opening a run wants to know where it got to,
   * not how it started.
   */
  async events(
    runId: string,
    query: { page?: number; pageSize?: number },
  ): Promise<{ items: RunEventView[]; total: number; page: number; pageSize: number }> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? EVENTS_DEFAULT_PAGE_SIZE;

    // Confirms the run exists before reporting an empty timeline. A 404 and
    // "no events yet" are different answers, and returning the second for a
    // mistyped id sends somebody hunting for a runner that never started.
    const run = await this.prisma.run.findUnique({
      where: { id: runId },
      select: { id: true, workOrder: { select: { identity: true } } },
    });
    if (!run) throw new NotFoundException(`Run ${runId} not found`);

    const where: Prisma.RunEventWhereInput = { runId };

    const [rows, total] = await Promise.all([
      this.prisma.runEvent.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        // `occurredAt` then `recordedAt`: two events can share a reported
        // timestamp — a runner emitting several in the same millisecond — and
        // an unstable sort would shuffle them between pages, so a reader
        // paging through could see one twice and another never.
        orderBy: [{ occurredAt: 'desc' }, { recordedAt: 'desc' }],
        select: {
          id: true,
          type: true,
          source: true,
          occurredAt: true,
          runId: true,
          summary: true,
        },
      }),
      this.prisma.runEvent.count({ where }),
    ]);

    return {
      items: rows.map((row) => ({
        id: row.id,
        // Prisma's enum labels carry underscores because Postgres cannot hold
        // a dot in one. The cockpit — and `schemas/run-event.schema.json`, and
        // every runner — use dots. Returning the client's spelling would put
        // `run_started` in front of an operator looking for `run.started` in
        // the schema.
        type: fromPrismaEventType(row.type) as RunEventView['type'],
        source: fromPrismaEventSource(row.source) as RunEventView['source'],
        occurredAt: row.occurredAt.toISOString(),
        runId: row.runId,
        // The work order IDENTITY, not its row id. This is rendered to a
        // human in the mono token, and a uuid tells them nothing.
        workOrderId: run.workOrder.identity,
        summary: row.summary,
      })),
      total,
      page,
      pageSize,
    };
  }
}

// ---------------------------------------------------------------------------

const RUN_SELECT = {
  id: true,
  status: true,
  startedAt: true,
  lastEventAt: true,
  attentionReason: true,
  resumesAt: true,
  runnerKey: true,
  costUsd: true,
  pullRequestUrl: true,
  workOrder: {
    select: {
      identity: true,
      issueNumber: true,
      issueUrl: true,
      issueTitle: true,
      baseCommit: true,
      attempt: true,
      branch: true,
      repository: { select: { owner: true, name: true } },
    },
  },
} as const;

type RunRow = {
  id: string;
  status: string;
  startedAt: Date;
  lastEventAt: Date | null;
  attentionReason: string | null;
  resumesAt: Date | null;
  runnerKey: string;
  costUsd: { toNumber(): number } | null;
  pullRequestUrl: string | null;
  workOrder: {
    identity: string;
    issueNumber: number;
    issueUrl: string;
    issueTitle: string | null;
    baseCommit: string;
    attempt: number;
    branch: string;
    repository: { owner: string; name: string };
  };
};

function toRunSummary(row: RunRow): RunSummary {
  return {
    id: row.id,
    workOrder: {
      id: row.workOrder.identity,
      issueNumber: row.workOrder.issueNumber,
      repository: `${row.workOrder.repository.owner}/${row.workOrder.repository.name}`,
      // Shortened here, as on the queue: the cockpit's type says "already
      // shortened upstream", and a second opinion about identity downstream is
      // what #62 forbids.
      baseCommit: row.workOrder.baseCommit.slice(0, 7),
      attempt: row.workOrder.attempt,
      branch: row.workOrder.branch,
      title: row.workOrder.issueTitle ?? `Issue #${row.workOrder.issueNumber}`,
      issueUrl: row.workOrder.issueUrl || null,
    },
    status: row.status as RunSummary['status'],
    startedAt: row.startedAt.toISOString(),
    lastEventAt: row.lastEventAt?.toISOString() ?? null,
    // Carried SEPARATELY, never merged into one message. See the schema.
    attentionReason: row.attentionReason,
    resumesAt: row.resumesAt?.toISOString() ?? null,
    runner: row.runnerKey,
    // Prisma hands back a Decimal; the document wants a number or null. Left
    // unconverted it serializes as an object. Shared with the other read
    // models so the three cannot convert the same column three ways.
    costUsd: toNumberOrNull(row.costUsd),
    pullRequestUrl: row.pullRequestUrl,
  };
}
