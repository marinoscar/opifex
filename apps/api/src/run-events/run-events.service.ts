import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import { toNumberOrNull } from '../common/decimal';
import { PrismaService } from '../prisma/prisma.service';
import { FactoryMetrics } from '../telemetry/factory-metrics.service';
import {
  RunEventValidator,
  type ValidationFailure,
} from './run-event-validator';
import {
  toPrismaEventSource,
  toPrismaEventType,
  type RunEventPayload,
} from './run-event.types';

export interface IngestResult {
  /** Events stored for the first time. */
  accepted: number;
  /** Events recognised as already delivered. Not an error. */
  duplicates: number;
}

export interface RejectedEvent {
  index: number;
  eventId: string | null;
  failures: ValidationFailure[];
}

/**
 * Accepts runner-reported events, validates them against the contract, and
 * persists them.
 *
 * VISION §9 defines a common floor of six types that every runner maps into.
 * This is the door that floor is enforced at: anything else is rejected with a
 * message naming what was wrong, rather than stored as an event nothing can
 * interpret.
 */
@Injectable()
export class RunEventsService {
  private readonly logger = new Logger(RunEventsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly validator: RunEventValidator,
    private readonly metrics: FactoryMetrics,
  ) {}

  /**
   * Ingest a batch.
   *
   * Batches are validated WHOLLY before anything is written. A partial write
   * would leave a runner unable to tell which of its events landed, and its
   * only recovery would be to resend all of them — which works only because
   * ingestion is idempotent, so relying on that as the happy path would be
   * building on the safety net.
   */
  async ingest(runId: string, candidates: unknown[]): Promise<IngestResult> {
    if (candidates.length === 0) {
      throw new BadRequestException('No events supplied');
    }

    const run = await this.prisma.run.findUnique({
      where: { id: runId },
      select: { id: true, workOrder: { select: { identity: true } } },
    });
    if (!run) {
      throw new NotFoundException(`Run ${runId} not found`);
    }

    const events: RunEventPayload[] = [];
    const rejected: RejectedEvent[] = [];

    candidates.forEach((candidate, index) => {
      const result = this.validator.check(candidate);
      if (!result.valid) {
        rejected.push({
          index,
          eventId: readEventId(candidate),
          failures: result.failures,
        });
        return;
      }

      // Checked here rather than in the schema, which cannot know it: an event
      // claiming a different run than the URL is either a routing bug or a
      // runner reaching for a run it was not given, and both should be loud.
      if (result.event.runId !== runId) {
        rejected.push({
          index,
          eventId: result.event.eventId,
          failures: [
            {
              path: '/runId',
              message: `must match the run in the URL (${runId}), got ${result.event.runId}`,
            },
          ],
        });
        return;
      }

      // A runner may only ever report as itself. Accepting a `git-derived` or
      // `control-plane-synthesized` event here would let a runner manufacture
      // exactly the masquerade VISION §9 forbids — claiming the control plane
      // concluded something it did not.
      if (result.event.source !== 'runner-reported') {
        rejected.push({
          index,
          eventId: result.event.eventId,
          failures: [
            {
              path: '/source',
              message:
                `must be 'runner-reported' on this endpoint; ` +
                `'${result.event.source}' is produced by Opifex, not submitted to it`,
            },
          ],
        });
        return;
      }

      events.push(result.event);
    });

    if (rejected.length > 0) {
      throw new BadRequestException({
        message: `${rejected.length} of ${candidates.length} events were rejected`,
        rejected,
      });
    }

    return this.persist(runId, events, run.workOrder.identity);
  }

  /**
   * Write the batch, treating a duplicate as success.
   *
   * `skipDuplicates` against the unique `(runId, externalId)` is what makes a
   * retried delivery idempotent — the requirement in #53 — and it puts the
   * check where two concurrent deliveries cannot interleave past it.
   */
  private async persist(
    runId: string,
    events: RunEventPayload[],
    workOrderIdentity: string,
  ): Promise<IngestResult> {
    const created = await this.prisma.runEvent.createMany({
      data: events.map((event) => this.toRow(runId, event, workOrderIdentity)),
      skipDuplicates: true,
    });

    await this.advanceRun(runId, events);

    return {
      accepted: created.count,
      duplicates: events.length - created.count,
    };
  }

  /**
   * One row, and the span that goes with it.
   *
   * VISION §9 maps run events onto *"one trace per work order, one span per
   * turn or tool call, cost and tokens as span attributes"*. The span is
   * emitted here so the `traceId`/`spanId` columns hold the ids of a span
   * that actually exists — storing correlation ids for a span nobody emitted
   * would make the run detail link to nothing.
   *
   * A sender's own trace ids are preferred when it supplies them: a runner
   * that is already instrumented has the real parent context, and overwriting
   * it would sever its spans from ours.
   */
  private toRow(
    runId: string,
    event: RunEventPayload,
    workOrderIdentity: string,
  ) {
    const toolSignature = event.tool
      ? `${event.tool.name}:${event.tool.signature}`
      : null;

    const emitted = this.metrics.recordRunEvent({
      workOrderIdentity,
      type: event.type,
      source: event.source,
      occurredAt: new Date(event.occurredAt),
      summary: event.summary ?? null,
      toolSignature,
      costUsd: event.cost?.usd ?? null,
      tokensInput: event.cost?.tokensInput ?? null,
      tokensOutput: event.cost?.tokensOutput ?? null,
    });

    return {
      runId,
      externalId: event.eventId,
      type: toPrismaEventType(event.type) as never,
      source: toPrismaEventSource(event.source) as never,
      occurredAt: new Date(event.occurredAt),
      summary: event.summary ?? '',
      toolSignature,
      // Kept through normalization deliberately. #53: losing the reason and
      // reset time collapses park-and-auto-resume into kill-and-re-run,
      // which VISION §9 calls the most common supervision bug.
      blockedReason: event.blocked?.reason ?? null,
      blockedUntil: event.blocked?.resetAt
        ? new Date(event.blocked.resetAt)
        : null,
      costUsd: event.cost?.usd ?? null,
      tokensInput: event.cost?.tokensInput ?? null,
      tokensOutput: event.cost?.tokensOutput ?? null,
      traceId: event.trace?.traceId ?? emitted.traceId,
      spanId: event.trace?.spanId ?? emitted.spanId,
      payload: JSON.parse(JSON.stringify(event)),
    };
  }

  /**
   * Move the run's denormalized liveness forward.
   *
   * `lastEventAt` is what the watchdog measures age from (#54), and it is only
   * ever moved FORWARD: a late-arriving old event must not make a live run
   * look staler than it is.
   */
  private async advanceRun(
    runId: string,
    events: RunEventPayload[],
  ): Promise<void> {
    const newest = events
      .map((event) => new Date(event.occurredAt))
      .reduce((latest, at) => (at > latest ? at : latest));

    const blocked = events.find((event) => event.type === 'run.blocked');

    await this.prisma.run.updateMany({
      // The guard is in the WHERE clause rather than a read-then-compare, so
      // two concurrent deliveries cannot both decide they are newest.
      where: {
        id: runId,
        OR: [{ lastEventAt: null }, { lastEventAt: { lt: newest } }],
      },
      data: {
        lastEventAt: newest,
        // Carried onto the run so #56 can schedule a resume without re-reading
        // the event stream. Only set when the batch actually contained a block.
        ...(blocked?.blocked?.resetAt
          ? { resumesAt: new Date(blocked.blocked.resetAt) }
          : {}),
      },
    });

    await this.rollUpCost(runId);
    await this.concludeRun(runId, events);
  }

  /**
   * Move a run out of `running` when its terminal event arrives (#202).
   *
   * ## Why this was missing
   *
   * The poller stops polling on a terminal status and deliberately leaves the
   * status itself to ingestion — "a second writer deciding the same fact from a
   * different input is how two sources of truth appear" — and ingestion never
   * picked it up. So every run that ever executed stayed `running`, the
   * projection's review path (which reads `status === 'succeeded'`) could never
   * fire, and #107's green-CI gate sat behind a condition nothing reached.
   *
   * ## Monotonic, like `lastEventAt` and the cost roll-up
   *
   * The guard is `status: 'running'` in the WHERE clause. A redelivered
   * terminal event cannot drag a run back out of a terminal state, and a late
   * `run.failed` cannot overwrite a `succeeded` that already landed — whichever
   * conclusion arrives first wins, and the events remain the record of why.
   *
   * ## `result` is carried onto the run
   *
   * `run-event.schema.json` puts `branch`, `headCommit` and `pullRequestUrl` on
   * `run.completed` for exactly this. #107 gates surfacing on the checks of
   * `headCommit`, so without this the gate has nothing to ask GitHub about.
   */
  private async concludeRun(
    runId: string,
    events: RunEventPayload[],
  ): Promise<void> {
    // The last terminal event in the batch, by when it happened. A batch
    // carrying both is malformed, but picking deterministically beats picking
    // by array order.
    const terminal = events
      .filter(
        (event) =>
          event.type === 'run.completed' || event.type === 'run.failed',
      )
      .sort(
        (a, b) =>
          new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime(),
      )
      .pop();

    if (!terminal) return;

    const succeeded = terminal.type === 'run.completed';
    const result = terminal.result;

    const updated = await this.prisma.run.updateMany({
      // Only a live run concludes. This is what makes redelivery a no-op.
      where: { id: runId, status: 'running' },
      data: {
        status: succeeded ? 'succeeded' : 'failed',
        endedAt: new Date(terminal.occurredAt),
        // Why it stopped, in the field the cockpit already reads. #67's run
        // summary needs the same fact and reads it from here.
        ...(succeeded
          ? {}
          : { attentionReason: terminal.failure?.reason ?? 'run failed' }),
        ...(result?.branch ? { branch: result.branch } : {}),
        ...(result?.headCommit ? { headCommit: result.headCommit } : {}),
        ...(result?.pullRequestUrl
          ? {
              pullRequestUrl: result.pullRequestUrl,
              pullRequestNumber: pullNumberFrom(result.pullRequestUrl),
            }
          : {}),
      },
    });

    if (updated.count > 0) {
      this.logger.log(
        `Run ${runId} concluded ${succeeded ? 'succeeded' : 'failed'}` +
          (result?.pullRequestUrl ? ` with ${result.pullRequestUrl}` : ''),
      );
    }
  }

  /**
   * Carry the reported cost from the events onto the run (#183).
   *
   * ## Why this has to exist at all
   *
   * `RunEvent.costUsd` was written from the first day of ingestion and nothing
   * ever moved it onto the run, so `Run.costUsd` was `null` for every run that
   * had ever executed. Everything downstream reads the run, not the events:
   * `GET /api/cost`, VISION §10's metric 5, and the spend ledger's MEASURED
   * arm. All three were structurally empty and honestly reporting it, which is
   * why nothing looked broken.
   *
   * ## Summed from the stored rows, not from the batch
   *
   * `run-event.schema.json` defines `cost` as *"incremental cost and tokens
   * attributed to THIS event"*, so the run's figure is the sum of its events.
   * The subtlety is where that sum is computed.
   *
   * Summing the batch would be wrong: `advanceRun` receives every VALIDATED
   * event, including the ones `createMany({ skipDuplicates })` then skips --
   * `duplicates` is derived from the shortfall precisely because the insert
   * does not say which were skipped. A redelivered terminal event would be
   * correctly recognised at the event table and then summed a second time
   * here, silently doubling recorded spend.
   *
   * Aggregating over the stored rows sidesteps that entirely: a redelivered
   * event exists once, so it contributes once, whatever the batch contained.
   * It is idempotent by construction rather than by care.
   *
   * It is also correct for both reporting shapes the fleet can have. A runner
   * that reports incrementally sums to its true total; `claude-code-local`,
   * which reports once on its final `result` line, sums to that single figure.
   * Neither needs the control plane to know which it is.
   *
   * ## `null` and `0` stay distinct
   *
   * Postgres `SUM` over a column where every row is null returns null, not
   * zero -- which is exactly the distinction the capability manifest's
   * `reportsCost` exists to preserve. A runner that reported nothing must not
   * end up looking like one that spent nothing.
   *
   * ## Monotonic, like `lastEventAt`
   *
   * The guard is in the WHERE clause for the same reason: two concurrent
   * ingests can compute their sums and land out of order, and the older,
   * smaller figure must not win. A sum over an append-only table only ever
   * grows, so `lt` is the whole guard.
   */
  private async rollUpCost(runId: string): Promise<void> {
    const totals = await this.prisma.runEvent.aggregate({
      where: { runId },
      _sum: { costUsd: true, tokensInput: true, tokensOutput: true },
    });

    const costUsd = toNumberOrNull(totals._sum.costUsd);
    const { tokensInput, tokensOutput } = totals._sum;

    if (costUsd !== null) {
      await this.prisma.run.updateMany({
        where: {
          id: runId,
          OR: [{ costUsd: null }, { costUsd: { lt: costUsd } }],
        },
        data: { costUsd },
      });
    }

    if (tokensInput !== null && tokensInput !== undefined) {
      await this.prisma.run.updateMany({
        where: {
          id: runId,
          OR: [{ tokensInput: null }, { tokensInput: { lt: tokensInput } }],
        },
        data: { tokensInput },
      });
    }

    if (tokensOutput !== null && tokensOutput !== undefined) {
      await this.prisma.run.updateMany({
        where: {
          id: runId,
          OR: [{ tokensOutput: null }, { tokensOutput: { lt: tokensOutput } }],
        },
        data: { tokensOutput },
      });
    }
  }
}

/**
 * The number out of a pull-request URL, or null.
 *
 * `Run.pullRequestNumber` is what later reads join on, and deriving it here
 * keeps the two columns from disagreeing about which pull request a run
 * produced. A URL shaped differently than expected yields null rather than a
 * wrong number — a wrong join key is worse than a missing one.
 */
function pullNumberFrom(url: string): number | null {
  const match = /\/pull\/(\d+)(?:$|[/?#])/.exec(url);
  return match ? Number(match[1]) : null;
}

/** Best-effort id for an error body, from a candidate that failed validation. */
function readEventId(candidate: unknown): string | null {
  if (candidate && typeof candidate === 'object' && 'eventId' in candidate) {
    const id = (candidate as { eventId: unknown }).eventId;
    if (typeof id === 'string') return id;
  }
  return null;
}
