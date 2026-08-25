import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { DecisionLogService } from '../decision-log/decision-log.service';
import type {
  InvocationDraft,
  InvocationOutcome,
  ProposalDraft,
} from '../decision-log/decision-log.types';
import { renderSnapshot } from '../snapshot/render-snapshot';
import { SnapshotService } from '../snapshot/snapshot.service';
import { assessQuota, type QuotaGateConfig } from './quota-gate';
import { SupervisorSpendCeilingService } from './supervisor-spend-ceiling';
import { assessSupervisorSpend, withTickSpend } from './supervisor-spend-gate';
import {
  noSupervisorSpendTally,
  SupervisorSpendLedgerService,
  type SupervisorSpendTally,
} from './supervisor-spend-ledger.service';
import {
  SUPERVISOR_MODEL,
  UnavailableSupervisorModel,
  type SupervisorModel,
} from './supervisor-model.port';
import {
  SUPERVISOR_PROPOSERS,
  type SupervisorProposer,
} from './supervisor-proposer.port';

/**
 * One scheduled supervisor invocation (#89).
 *
 * VISION §7 names the trap this design exists to avoid: "a non-deterministic
 * supervisor that can itself stall, exhaust quota, and behave unpredictably,
 * supervising components that stall and exhaust quota — leaving a human to
 * supervise it."
 *
 * Four properties follow, and each is a separate thing this class does.
 *
 * **Scheduled, never per-event.** `SupervisorTask` is the only caller, and it
 * is a cron. Nothing on the dispatch path can reach this class — `run-events`,
 * `dispatch` and `watchdog` do not import it, and #94's governing test is
 * where that stops being a convention.
 *
 * **Off the hot path, and unable to affect it.** The service reads state and
 * writes the decision log. It holds a `SnapshotService`, a
 * `DecisionLogService`, a model that takes text and returns text, and a list
 * of proposers whose entire output is drafts. There is nothing here to
 * execute with.
 *
 * **Fails safe.** `invoke()` NEVER throws. A proposer that errors is recorded
 * and the others still run — the invocation ends `partial` rather than losing
 * four proposals to one bad one. An invocation that fails wholesale still
 * writes a row, because #90 requires the log have no gaps: a missing entry is
 * indistinguishable from one that silently failed.
 *
 * **Stands down when the work has stopped.** Before doing any work it asks
 * `assessQuota` whether workers are already parked, and skips the tick if they
 * are.
 *
 * **Refuses to spend without room, or without a ceiling** (#261, ADR-0017).
 * Checked TWICE, at two different resolutions, and deliberately not inside
 * `quota-gate.ts` — see `supervisor-spend-gate.ts` for why that file is not
 * the home for a budget check. Once before the tick begins, earlier than the
 * quota gate because it needs none of the snapshot state and refusing early
 * saves a query whose answer cannot change the outcome; then again between
 * proposers, because a supervisor tick is a short sequence of atomic calls
 * each priced synchronously on return, which is the one shape a mid-flight
 * budget check can actually act on. An unset ceiling refuses: ADR-0016
 * removed the only other spend-adjacent stand-down, and "unset means
 * unlimited" would be #261 itself restated as a default.
 *
 * This paragraph used to be headed "Yields quota" and cited VISION §7's "a
 * supervisor competing for the quota it is managing is a bad loop". ADR-0015
 * made that false: the supervisor calls a separately metered API key of its
 * own, so an invocation competes with a worker for nothing and yields nothing
 * by standing down. The withdrawn reason is recorded here rather than deleted
 * because a comment that used to be true is worse than no comment at all — a
 * reader who found the branch and the old justification together would take
 * one as the explanation of the other. VISION §7 still carries the original
 * sentence, and correcting a north-star document is not this file's call.
 *
 * What is true is a fact rather than a competition: a run parked on a rate
 * limit is evidence that everything the supervisor exists to advise about has
 * stopped moving, and a diagnosis nobody can act on will say the same thing
 * once runs resume. Since ADR-0016 that is the gate's only arm — the live-run
 * ceiling that sat beside it gated on a count that does not determine what a
 * tick spends, since every proposer below runs exactly once per invocation
 * regardless of how many runs are live.
 */
@Injectable()
export class SupervisorService {
  private readonly logger = new Logger(SupervisorService.name);
  private readonly model: SupervisorModel;
  private readonly proposers: readonly SupervisorProposer[];

  constructor(
    private readonly config: ConfigService,
    private readonly snapshots: SnapshotService,
    private readonly log: DecisionLogService,
    // Both REQUIRED, unlike the model and the proposers below. Those are
    // genuinely optional — the API boots with no supervisor configured — but
    // a tick that cannot check what it has spent must not run, so there is no
    // shape of this object that is allowed to be missing its ceiling.
    private readonly spendCeiling: SupervisorSpendCeilingService,
    private readonly spendLedger: SupervisorSpendLedgerService,
    @Optional()
    @Inject(SUPERVISOR_MODEL)
    model?: SupervisorModel,
    @Optional()
    @Inject(SUPERVISOR_PROPOSERS)
    proposers?: SupervisorProposer[],
  ) {
    // Optional with an explicit default rather than a required binding: the
    // API must boot with no supervisor configured, exactly as it boots with no
    // GitHub token. The default REFUSES rather than pretending, so a
    // deployment that thinks it has a supervisor and does not finds out from
    // the log rather than from a month of empty evidence.
    this.model = model ?? new UnavailableSupervisorModel();
    this.proposers = proposers ?? [];
  }

  /**
   * Run once. Never throws.
   *
   * Returns the invocation id it wrote, or null if it could not even write
   * that — the one case where there is genuinely nothing to record against.
   */
  async invoke(now: Date = new Date()): Promise<string | null> {
    const startedAt = now;

    if (!this.enabled) {
      return this.recordSkip(
        startedAt,
        'skipped_disabled',
        'SUPERVISOR_ENABLED is not true.',
      );
    }

    // BEFORE `snapshots.collect()`, and so before the quota gate. The spend
    // check needs none of the state the snapshot carries, and a tick already
    // refused on dollars should not pay for the queries that would tell it
    // what it is not going to diagnose. The parked-run check still runs after
    // this one, unchanged — `decideSpendAdmission` sets the same precedent
    // that a budget-shaped refusal is checked before anything situational.
    const ceiling = this.spendCeiling.value;

    let tally: SupervisorSpendTally;
    if (ceiling.limitUsd === null) {
      // No ceiling, malformed or absent: the verdict is settled by the ceiling
      // alone, and the tally query could not change it.
      tally = noSupervisorSpendTally(ceiling.windowDays, startedAt);
    } else {
      try {
        tally = await this.spendLedger.tally(ceiling.windowDays, startedAt);
      } catch (error) {
        // Not a budget refusal — a failure to check one. Recorded as `failed`
        // rather than `skipped_budget` so the log never claims a ceiling was
        // reached when nobody could read what had been spent. Either way the
        // tick does not run: an unbounded action that cannot be checked does
        // not proceed.
        return this.recordSkip(
          startedAt,
          'failed',
          `Could not read supervisor spend: ${message(error)}`,
        );
      }
    }

    const spend = assessSupervisorSpend(ceiling, tally);
    if (!spend.admit) {
      return this.recordSkip(startedAt, 'skipped_budget', spend.reason);
    }

    let state;
    try {
      state = await this.snapshots.collect(startedAt);
    } catch (error) {
      return this.recordSkip(
        startedAt,
        'failed',
        `Could not read state: ${message(error)}`,
      );
    }

    const verdict = assessQuota(state.totals, this.quotaGate);
    if (verdict.standDown) {
      return this.recordSkip(startedAt, 'skipped_quota', verdict.reason);
    }

    // Rendered from the state already in hand rather than through
    // `snapshots.render()`, which would issue every query a second time. The
    // renderer being pure is what makes that substitution safe — and it also
    // guarantees the text stored on the invocation was rendered from exactly
    // the state the quota gate just judged.
    const rendered = renderSnapshot(state);

    const proposals: ProposalDraft[] = [];
    let anyFailed = false;
    let costUsd: number | null = null;
    let unpricedCalls = 0;
    let tokensInput: number | null = null;
    let tokensOutput: number | null = null;

    const metered = meter(this.model, (response) => {
      // Counted BEFORE the money, because it is what makes the money
      // readable: a call the price table has no rate for contributed real
      // spend that `costUsd` cannot include (#282).
      if (response.costUsd === null) unpricedCalls += 1;
      costUsd = add(costUsd, response.costUsd);
      tokensInput = add(tokensInput, response.tokensInput);
      tokensOutput = add(tokensOutput, response.tokensOutput);
    });

    let stoppedForSpend: string | null = null;
    let proposersRun = 0;

    for (const proposer of this.proposers) {
      // Not before the FIRST proposer: the pre-tick check above already
      // answered that question against the same figures, and asking twice
      // with nothing spent in between would only make the log say "stopped
      // after 0 of 4" where `skipped_budget` already says it better.
      if (proposersRun > 0) {
        const midTick = assessSupervisorSpend(
          ceiling,
          // `costUsd` is this tick's KNOWN spend so far; `unpricedCalls` is
          // what it could not price. Both are already accumulated by the
          // meter below, which is what makes this check cost nothing.
          withTickSpend(tally, costUsd ?? 0, unpricedCalls),
        );
        if (!midTick.admit) {
          stoppedForSpend =
            `Stopped after ${proposersRun} of ${this.proposers.length} proposer(s): ` +
            midTick.reason;
          this.logger.warn(stoppedForSpend);
          break;
        }
      }

      proposersRun += 1;

      try {
        const drafts = await proposer.propose({
          state,
          snapshot: rendered.text,
          model: metered,
        });
        proposals.push(...drafts);
      } catch (error) {
        // One proposer failing must not cost the others their proposals. The
        // invocation ends `partial`, which is a different fact from `failed`
        // and is recorded as one.
        anyFailed = true;
        this.logger.warn(
          `Supervisor proposer ${proposer.name} failed: ${message(error)}`,
        );
      }
    }

    const draft: InvocationDraft = {
      startedAt,
      finishedAt: new Date(),
      // `partial` covers both endings, because it already means "it ran, not
      // everything in it completed, and what did is recorded" — which is
      // exactly what a budget-stopped tick is. ADR-0017 declines to mint a
      // `partial_budget` value and grow this enum once per reason a tick can
      // end early; what it requires instead is that `failureReason` never
      // read the same for the two causes.
      outcome: anyFailed || stoppedForSpend !== null ? 'partial' : 'completed',
      model: this.model.name,
      snapshotText: rendered.text,
      snapshotGeneratedAt: state.generatedAt,
      snapshotTruncated: rendered.truncated,
      snapshotCharacters: rendered.characters,
      costUsd,
      unpricedCalls,
      tokensInput,
      tokensOutput,
      failureReason: describeEnding(stoppedForSpend, anyFailed),
    };

    try {
      const { invocationId } = await this.log.record(draft, proposals);
      return invocationId;
    } catch (error) {
      this.logger.error(`Could not write the decision log: ${message(error)}`);
      return null;
    }
  }

  /** Whether the supervisor is turned on at all. */
  get enabled(): boolean {
    return this.config.get<boolean>('supervisor.enabled') === true;
  }

  private get quotaGate(): QuotaGateConfig {
    return {
      standDownWhenBlocked:
        this.config.get<boolean>('supervisor.standDownWhenBlocked') !== false,
    };
  }

  /**
   * Write a row for an invocation that did not happen.
   *
   * A skipped invocation is still an entry, and the reason is stored. #90: a
   * log with gaps cannot be reviewed, because a missing entry is
   * indistinguishable from a tick that never ran.
   */
  private async recordSkip(
    startedAt: Date,
    outcome: Extract<
      InvocationOutcome,
      'skipped_disabled' | 'skipped_quota' | 'skipped_budget' | 'failed'
    >,
    reason: string | null,
  ): Promise<string | null> {
    try {
      const { invocationId } = await this.log.record({
        startedAt,
        finishedAt: new Date(),
        outcome,
        model: this.model.name,
        snapshotText: '',
        snapshotCharacters: 0,
        failureReason: reason,
      });
      return invocationId;
    } catch (error) {
      this.logger.error(
        `Could not record a ${outcome} invocation: ${message(error)}`,
      );
      return null;
    }
  }
}

/**
 * Wrap the model so every call's cost is counted.
 *
 * Counted HERE rather than trusted to each proposer, because a proposer that
 * forgot would make the supervisor look cheaper than it is — and #89 requires
 * supervisor cost be tracked so it never distorts metric 5. A proposer cannot
 * opt out of the meter, because it never sees the unwrapped model.
 */
function meter(
  model: SupervisorModel,
  onResponse: (response: {
    costUsd: number | null;
    tokensInput: number | null;
    tokensOutput: number | null;
  }) => void,
): SupervisorModel {
  return {
    name: model.name,
    async ask(request) {
      const response = await model.ask(request);
      onResponse(response);
      return response;
    },
  };
}

/**
 * Add a reported number to a running total, preserving "nothing reported".
 *
 * Null plus null is null, not zero. VISION §6 makes cost reporting a declared
 * capability, so an invocation whose adapter reports nothing must not appear
 * to have been free.
 *
 * ## What this function alone cannot say, and who says it (#282)
 *
 * A MIXED tick — one proposer's call priced, another's did not — leaves the
 * total holding only the known part. That is the right arithmetic and the
 * wrong claim on its own: the row would report a complete-looking figure that
 * silently omits whatever the unpriced call cost, which is precisely the
 * unpriced call being read as free. The case is not hypothetical; it is what
 * happens the day `SUPERVISOR_MODEL_NAME` moves to a dated snapshot
 * `model-pricing.ts` has not caught up with.
 *
 * The fix is not here. Summing a null as zero would be worse, and inventing a
 * rate would be worse still. It is `unpricedCalls`, counted beside this total
 * and stored beside it, which turns the figure into an explicit FLOOR — the
 * same shape `SpendLedgerService` gives the dispatch ceiling with
 * `unboundedRuns`. This function keeps doing the one honest thing it can:
 * add what was measured, and never invent what was not.
 */
function add(total: number | null, value: number | null): number | null {
  if (value === null) return total;
  return (total ?? 0) + value;
}

/**
 * Why the invocation ended early, in words a reader can act on.
 *
 * The two causes must never render alike. Before ADR-0017 there was one
 * `partial` reason and it was always the literal string "At least one proposer
 * failed."; a budget stoppage borrowing that sentence would put a reader back
 * where `quota-gate.spec.ts` was before ADR-0016 gave it a reason-string
 * assertion — reading a plausible sentence nobody can check against the fact
 * it claims. When BOTH happened, both are said, in that order: the budget
 * stoppage is the one that determined what did not run.
 */
function describeEnding(
  stoppedForSpend: string | null,
  anyFailed: boolean,
): string | null {
  if (stoppedForSpend !== null) {
    return anyFailed
      ? `${stoppedForSpend} At least one proposer also failed.`
      : stoppedForSpend;
  }
  return anyFailed ? 'At least one proposer failed.' : null;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
