import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

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
 * The statuses a run may still conclude FROM.
 *
 * The same three `dispatch.service.ts` counts as occupying a concurrency slot,
 * and that is not a coincidence: a run holding a slot is exactly a run that has
 * not finished, so every one of them has to be able to give the slot back.
 *
 * `quarantined` is excluded deliberately, and that exclusion is why this is a
 * named set rather than "anything not terminal" — VISION §8 says a run cannot
 * clear its own quarantine, and a runner-reported event concluding one would be
 * it doing precisely that.
 */
const CONCLUDABLE_STATUSES = ['running', 'stalled', 'blocked'] as const;

/**
 * The statuses a `run.blocked` event may write a park onto (#475).
 *
 * `succeeded` and `failed` are out because a park is not a state a finished
 * run can enter: nothing resumes a run that already ended, so a late
 * `run.blocked` must not put either a status or a resume time on one.
 * `quarantined` is out for VISION §8's reason — a runner-reported event must
 * not move a run a human has deliberately set aside.
 *
 * Which leaves the same three as {@link CONCLUDABLE_STATUSES}, and not by
 * coincidence: both answer one question, *may a runner-reported event still
 * move this run at all*. An alias rather than a second literal, because two
 * lists that must agree and are written twice are a list that will eventually
 * disagree.
 *
 * `blocked` is deliberately IN it, which was the harder call. A run already
 * parked does not need its status rewritten, but it may well need its reset
 * time rewritten: a runner that hits a five-hour wall and then a weekly one
 * reports a second, later `resetAt`, and holding the superseded one would make
 * the run resume early and re-block — the loop the jitter exists to prevent.
 * Nothing is lost by admitting it, because the idempotence never lived here:
 * see {@link RunEventsService.blockRun}.
 */
const BLOCKABLE_STATUSES = CONCLUDABLE_STATUSES;

/**
 * The statuses a reporting run returns to `running` FROM (#254, #475).
 *
 * Both describe a run that is not producing events — `stalled` because the
 * watchdog found it silent, `blocked` because its runner said it hit a wall —
 * and both are contradicted by the same evidence: an event arriving. See
 * {@link RunEventsService.resumeRun} for why one method serves both.
 */
const RESUMABLE_STATUSES = ['stalled', 'blocked'] as const;

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
  /**
   * The return type is annotated on purpose. `createMany`'s `data:` is a
   * generic inference target, so its contents are not excess-property-checked
   * (#159); a concrete return type is a non-generic position, and there the
   * compiler does check every key against the model.
   */
  private toRow(
    runId: string,
    event: RunEventPayload,
    workOrderIdentity: string,
  ): Prisma.RunEventCreateManyInput {
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

    const terminal = terminalEventIn(events);

    // The block the batch ended on, and only when the batch does not also
    // conclude the run. Both halves of that are argued where they are decided:
    // {@link blockingEventIn} for why the LAST word rather than any block, and
    // the transition below for why a run that concludes never transits
    // `blocked` on the way there.
    const parking = terminal ? undefined : blockingEventIn(events);

    const advanced = await this.prisma.run.updateMany({
      // The guard is in the WHERE clause rather than a read-then-compare, so
      // two concurrent deliveries cannot both decide they are newest.
      where: {
        id: runId,
        OR: [{ lastEventAt: null }, { lastEventAt: { lt: newest } }],
      },
      // `lastEventAt` and the cost roll-up are the only things written
      // unguarded by status, and that is the whole of what belongs here: they
      // are facts about the event stream, true of a run whatever state it is
      // in. Everything that makes a CLAIM about the run — its status, and the
      // resume time that asserts something will happen to it — is written
      // below under a status guard. `resumesAt` used to ride along here and
      // landed on terminal rows (#475 review).
      data: { lastEventAt: newest },
    });

    await this.rollUpCost(runId);

    // Both status transitions hang off `advanced.count`, which is the same
    // monotonic guard `lastEventAt` uses rather than a second one derived
    // here: an event too old to move liveness forward must not move the status
    // either.
    //
    // A run that is about to conclude is neither parked nor un-stalled first:
    // the conclusion below already accepts a stalled or blocked run, and
    // writing `blocked` or `running` on the way past would put a state through
    // the row that never actually happened. #475 extends that existing rule to
    // the block rather than inventing a second one — a run that blocks and
    // fails in one delivery never sat parked, so nothing should record that it
    // did.
    if (!terminal && advanced.count > 0) {
      if (parking) {
        await this.blockRun(runId, parking);
      } else {
        await this.resumeRun(runId, newest);
      }
    }

    if (terminal) {
      await this.concludeRun(runId, terminal);
    }
  }

  /**
   * Park the run on the block its runner just reported (#475).
   *
   * ## Why this had to exist at all
   *
   * `RunStatus.blocked` is defined in the schema as *"parked with a reset
   * time; auto-resumes without a human"*, and until this method nothing in the
   * codebase ever wrote it. Both readers of that status —
   * `WatchdogService.loadBlockedRuns` and `DispatchService.loadQuotaBlocks` —
   * therefore matched zero rows forever. `sweepBlocked` never parked, never
   * escalated and never found a run to wake, so the whole of
   * `watchdog/blocked-parking.ts` was well-tested code that could not execute
   * in production, and VISION §1's second origin story — *"an agent hits a
   * rate limit at 2pm, I find out at 6pm; four hours dead"* — was the failure
   * the status existed to answer and the one it was silently not answering.
   *
   * This supplies the missing writer and nothing more. No schema change was
   * needed, and nothing here resumes anything: wiring the `park`/`resume`
   * actions to an executor is #477's, and this change only makes the status
   * truthful enough for that issue to have something to act on.
   *
   * ## A real behaviour change, visible from the first parked run
   *
   * Once runs actually reach `blocked`, `sweepBlocked` starts finding them —
   * which is the point, but it is not only the quiet half. A block whose
   * runner could not supply a reset time now escalates to a human after
   * `UNDATED_BLOCK_PATIENCE_MS` (30 minutes), where previously it was silent.
   * `decideParking` has always said so; it has never had a row to say it
   * about. That escalation is the designed behaviour of code that already
   * exists and #56 requires it, but it is new traffic in an operator's queue
   * and should be read as deliberate rather than discovered.
   *
   * ## This no longer writes `resumesAt`, and #477 is why
   *
   * It did, briefly, and the reasoning was sound as far as it went: a resume
   * time IS the park, so a single guarded write should decide both. What that
   * missed is that the value written here and the value the watchdog writes
   * are not the same quantity. This one is the VENDOR'S raw reset instant; the
   * watchdog's is that instant plus jitter — *our plan*. One column, two
   * meanings, two writers, and the first always won because `decideParking`
   * short-circuits to `waiting` the moment `resumesAt` is in the future. A
   * dated block therefore never reached `park` and `JITTER_FRACTION` was never
   * applied to one: every run parked against the same quota window would have
   * woken in the same instant, which is the thundering herd the jitter exists
   * to prevent (#477, finding 1).
   *
   * `blocked-parking.ts` states the resolution and argues it. The half of it
   * that lands here: **the vendor's reset stays on the event row as
   * `blockedUntil`**, which is where `WatchdogService.loadBlockedRuns` reads
   * `resetAt` from anyway and where `DispatchService.loadQuotaBlocks` reads it
   * for routing. Nothing is lost by not denormalizing it onto the run — both
   * readers already prefer the event — and the run's column is left free to
   * mean exactly one thing.
   *
   * The consequence, stated so it is not discovered: a just-blocked run has a
   * NULL `resumesAt` until the next watchdog tick plans one. The cockpit reads
   * that as "no resume is scheduled yet", which is true for those few seconds,
   * and `quotaPositions` in `dispatch.service.ts` already falls back to
   * `blockedUntil` when the run has no plan, so routing still sees the runner
   * as out of quota in the meantime.
   *
   * ## Where the idempotence comes from
   *
   * Not from the status set: {@link BLOCKABLE_STATUSES} admits `blocked`. It
   * comes from `advanced.count` in the caller, the same monotonic gate
   * `lastEventAt` uses. A run that reached `blocked` necessarily has
   * `lastEventAt` at the instant of the block that parked it, so a redelivery
   * of that same block cannot move liveness forward and never reaches this
   * method at all — while a genuinely NEWER block does, which is exactly the
   * one whose reset time is worth having.
   *
   * The guard that remains is in the WHERE clause, in the idiom of everything
   * else here: a read-then-compare would let a run that concluded in between
   * be dragged out of its terminal state by the comparison's own staleness.
   */
  private async blockRun(
    runId: string,
    parking: RunEventPayload,
  ): Promise<void> {
    const resetAt = parking.blocked?.resetAt;

    const blocked = await this.prisma.run.updateMany({
      where: { id: runId, status: { in: [...BLOCKABLE_STATUSES] } },
      // The status, and only the status. `resumesAt` is the watchdog's plan
      // and the watchdog is its only writer — see the comment above, and
      // `blocked-parking.ts` for the decision.
      data: { status: 'blocked' },
    });

    if (blocked.count > 0) {
      this.logger.log(
        `Run ${runId} reported blocked ` +
          `(${parking.blocked?.reason ?? 'reason not reported'}); ` +
          (resetAt
            ? `resets at ${resetAt}, and the next watchdog tick schedules the resume.`
            : 'no reset time, so #56 escalates rather than parking forever.'),
      );
    }
  }

  /**
   * Return a stalled or blocked run to `running` when it reports again
   * (#254, #475).
   *
   * ## The choice this makes, and why
   *
   * The alternative was to leave a resumed run `stalled` until it concluded,
   * on the grounds that the status then preserves the record that it was once
   * stuck. That reading loses on two counts.
   *
   * `Run.status` is present tense. The schema defines `running` as *"events are
   * flowing; nothing to do"* and `stalled` as *"silent or looping"*, so a run
   * whose events are flowing again satisfies the first sentence by definition
   * and leaving it `stalled` makes the column say something untrue. It is also
   * the column humans are shown: the daily brief tells the operator a stalled
   * run *"is spending nothing and finishing nothing"*
   * (`supervisor/brief/daily-brief.ts`), and the snapshot counts it under
   * `runsStalled`. Both would be false about a run that is mid-flight. A wrong
   * attention item is worse than a late one, because only one of them still
   * means anything.
   *
   * And nothing is lost — the part that had to be checked rather than assumed.
   * The stall survives in two durable places this does not touch: the
   * `Escalation` raised for it carries `progressStoppedAt` and
   * `detectLatencyMs`, and `run_events` is append-only, so the gap between two
   * consecutive `occurredAt` values stays computable forever. #232's stall
   * durations read exactly those, and this transition is what finally gives
   * them an END to measure to — pinning the status at `stalled` would leave
   * #232 with a start and no stop, which is the state it is filed against.
   *
   * ## Only on a batch that moved liveness forward
   *
   * `advanced.count` is the same monotonic guard `lastEventAt` uses, reused
   * rather than re-derived: an old or redelivered event that could not make a
   * live run look staler must not make a stalled one look alive either. The
   * same applies to a parked one: a redelivered event cannot unpark a run.
   *
   * The write is still guarded on {@link RESUMABLE_STATUSES} in the WHERE
   * clause, in the idiom of everything else here — a read-then-compare would
   * let a run that concluded in between be dragged back out of its terminal
   * state.
   *
   * ## Extended to `blocked`, rather than given a sibling (#475)
   *
   * One method, with a two-status guard. The alternative considered was a
   * separate `resumeBlockedRun`, and it loses on the only ground that matters
   * here: the argument above is not an argument about stalling. It is that
   * `Run.status` is present tense, so a run whose events are flowing must not
   * keep a status describing a state it has left — and `blocked` (*"parked
   * with a reset time"*) is as false of a reporting run as `stalled` is. A
   * sibling would restate that reasoning in a second place, perform the same
   * single write of the same value under the same monotonic gate, and differ
   * only in its WHERE clause. Two writers of one column whose agreement is a
   * matter of upkeep is how the two-sources-of-truth bug starts.
   *
   * What this is NOT is #477's auto-resume. Nothing here wakes a run; this
   * records that a run woke on its own, which is exactly the case the status
   * must stop claiming a park for.
   *
   * ## `resumesAt` is cleared, unlike `attentionReason` below
   *
   * A stale resume time is not merely untidy. `decideParking` short-circuits
   * to `waiting` whenever `resumesAt` is in the future, so a run that blocked,
   * resumed, and blocked again with no reset time would sit on the FIRST
   * park's schedule and never reach the patience check that escalates it —
   * silently, which is the failure mode #56 exists to remove. The watchdog
   * already takes care to date the CURRENT block from its own event; this is
   * the other half of that.
   *
   * Nothing is lost by clearing it. The reset time the runner reported is on
   * the event row as `blockedUntil`, which is where `loadBlockedRuns` reads
   * `resetAt` from in the first place, and `run_events` is append-only.
   *
   * Clearing is not a second WRITER of the column in the sense #477 rules out.
   * `blocked-parking.ts` states the invariant as: one component computes a
   * resume plan, and that is the watchdog. Anything that OBSERVES the park
   * ending erases the plan, because a plan that has been overtaken is not a
   * fact about anything. Both `RunExecutorService.resumeParkedRun` and this
   * method do that, and they cannot disagree — `null` has one meaning.
   *
   * ## `attentionReason` is deliberately left alone
   *
   * The poller writes it when it loses a run's handle, and *nobody is watching
   * this run* stays true whether or not the run is reporting. The cockpit is
   * explicit (`cockpit/runs.service.ts`) that the attention panel drains on the
   * escalation lifecycle rather than on this field, so clearing it here would
   * erase an operator's explanation without resolving anything.
   *
   * ## Runner-reported events only
   *
   * Git-derived liveness advances `lastEventAt` on its own path
   * (`liveness/git-liveness.service.ts`) and never reaches this method. Whether
   * a landing commit should also un-stall a run is that module's decision — it
   * exists to NOTICE disagreement between the two sources rather than to
   * reconcile them, and quietly reconciling one here would undo that.
   */
  private async resumeRun(runId: string, newest: Date): Promise<void> {
    const resumed = await this.prisma.run.updateMany({
      where: { id: runId, status: { in: [...RESUMABLE_STATUSES] } },
      data: { status: 'running', resumesAt: null },
    });

    if (resumed.count > 0) {
      this.logger.log(
        `Run ${runId} is reporting again as of ${newest.toISOString()}; ` +
          'returned to running.',
      );
    }
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
   * The guard is {@link CONCLUDABLE_STATUSES} in the WHERE clause. A
   * redelivered terminal event cannot drag a run back out of a terminal state,
   * and a late `run.failed` cannot overwrite a `succeeded` that already landed
   * — whichever conclusion arrives first wins, and the events remain the record
   * of why.
   *
   * ## Why the set, and not just `running` (#254)
   *
   * It WAS `status: 'running'`, and that was a permanent slot leak. A run the
   * watchdog or the poller had marked `stalled` matched nothing, so its
   * `run.completed` was a silent no-op and it stayed `stalled` forever — while
   * `stalled` still counts against `maxConcurrency`. Two recovered stalls wedge
   * a `maxConcurrency: 2` runner for the life of the deployment, presenting as
   * `capable-runners-are-at-capacity` with nothing visibly running. It does not
   * even take a real failure to get there: 90 seconds of silence is several
   * missed heartbeats for a full-streaming runner, so one slow tool call is
   * enough to strand a run whose work completed correctly. `blocked` is in the
   * set for the same reason — a parked run whose child is cancelled or exits
   * reports a terminal event and would otherwise wedge identically.
   *
   * Widening it does not weaken the idempotence the guard exists for, because
   * that idempotence never came from the value being exactly `running`: it
   * comes from the status CHANGING on the first write. `succeeded` and `failed`
   * are outside the set, so the second delivery of a terminal event matches
   * zero rows exactly as it did before.
   *
   * ## `result` is carried onto the run
   *
   * `run-event.schema.json` puts `branch`, `headCommit` and `pullRequestUrl` on
   * `run.completed`. #107 gates surfacing on the checks of `headCommit`, so
   * without this the gate has nothing to ask GitHub about.
   *
   * `branch` is deliberately NOT among them. There is no `Run.branch` column
   * and there should not be: the branch belongs to the work order, which
   * derives it deterministically, and every reader already takes it from
   * there (`run.workOrder.branch` in the liveness sweep and the cockpit
   * projection). The runner itself reads `run.workOrder.branch` to populate
   * the event, so writing it back would round-trip a value Opifex assigned.
   *
   * It used to be written here anyway, and Prisma REJECTS an unknown argument
   * rather than dropping it — so every successful claude-code-local run threw
   * out of `ingest` and was never concluded, wedging the concurrency slot this
   * very method exists to release. See #159: `data` is a generic inference
   * target, so the compiler never checks it.
   */
  private async concludeRun(
    runId: string,
    terminal: RunEventPayload,
  ): Promise<void> {
    const succeeded = terminal.type === 'run.completed';
    const result = terminal.result;

    const updated = await this.prisma.run.updateMany({
      // Only an unfinished run concludes. Redelivery is a no-op because the
      // first write moves the status OUT of this set, not because the set is
      // narrow.
      where: { id: runId, status: { in: [...CONCLUDABLE_STATUSES] } },
      data: {
        status: succeeded ? 'succeeded' : 'failed',
        endedAt: new Date(terminal.occurredAt),
        // Why it stopped, in the field the cockpit already reads. #67's run
        // summary needs the same fact and reads it from here.
        ...(succeeded
          ? {}
          : { attentionReason: terminal.failure?.reason ?? 'run failed' }),
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
      // The invocation ends with the run (#477). Guarded on `updated.count`
      // rather than run unconditionally, so a redelivered terminal event —
      // which matched zero rows above — cannot re-date an attempt that was
      // closed on the first delivery.
      //
      // `updateMany` over the open attempts rather than a targeted update: the
      // caller knows the run, not which attempt number is live, and a run with
      // two open rows is an upstream bug that must not be hidden behind a
      // table that merely looks populated. A run dispatched before attempts
      // were written has none, matches nothing, and is left alone.
      //
      // Why here at all, when `RunExecutorService` opens the rows: an attempt
      // row is written by whoever writes the corresponding `Run.status`
      // transition, so the two can never disagree. This method is the only
      // writer of a terminal run status, so it is the only place that can
      // truthfully close the last attempt.
      await this.prisma.runAttempt.updateMany({
        where: { runId, outcome: 'running' },
        data: {
          outcome: succeeded ? 'succeeded' : 'failed',
          endedAt: new Date(terminal.occurredAt),
          stopReason: succeeded
            ? (terminal.summary ?? null)
            : (terminal.failure?.reason ?? 'run failed'),
        },
      });

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
 * The terminal event a batch concludes on, or undefined.
 *
 * The LAST one by when it happened. A batch carrying both a completion and a
 * failure is malformed, but picking deterministically beats picking by array
 * order.
 *
 * Lifted out of `concludeRun` because both intermediate transitions need the
 * same answer: a run that is about to conclude must be neither un-stalled nor
 * parked on the way there.
 */
function terminalEventIn(
  events: RunEventPayload[],
): RunEventPayload | undefined {
  return events
    .filter(
      (event) => event.type === 'run.completed' || event.type === 'run.failed',
    )
    .sort(
      (a, b) =>
        new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime(),
    )
    .pop();
}

/**
 * The `run.blocked` event a batch ENDS on, or undefined.
 *
 * Deliberately not "the batch contained a block". A batch is a window of a
 * runner's stream, and a block followed by a heartbeat inside that same window
 * describes a run that hit a wall and got past it before the flush. Parking it
 * would be the wrong error of the two available: `stream-json-mapper.ts` makes
 * the same call about a `status: 'allowed'` rate-limit line, and for the same
 * reason — the watchdog eventually notices a real block through silence, but
 * it has nothing that notices a wrongly parked run.
 *
 * Stricter than {@link terminalEventIn}, which takes the last terminal event
 * even when something non-terminal follows it, and the asymmetry is the states
 * themselves rather than an oversight: a conclusion is absorbing, so nothing
 * reported after it can still be true, while a block is a state a run leaves
 * under its own power the moment it reports again.
 *
 * Equal `occurredAt` values fall to the runner's own ordering, because `sort`
 * is stable — whichever it put last in the batch is its last word.
 */
function blockingEventIn(
  events: RunEventPayload[],
): RunEventPayload | undefined {
  const last = [...events]
    .sort(
      (a, b) =>
        new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime(),
    )
    .pop();

  return last?.type === 'run.blocked' ? last : undefined;
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
