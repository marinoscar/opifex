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
 * **Yields quota.** Before doing any work it asks `assessQuota` whether
 * workers are already parked, and stands down if they are. That is VISION §7's
 * "a supervisor competing for the quota it is managing is a bad loop", made
 * into a branch.
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
    let tokensInput: number | null = null;
    let tokensOutput: number | null = null;

    const metered = meter(this.model, (response) => {
      costUsd = add(costUsd, response.costUsd);
      tokensInput = add(tokensInput, response.tokensInput);
      tokensOutput = add(tokensOutput, response.tokensOutput);
    });

    for (const proposer of this.proposers) {
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
      outcome: anyFailed ? 'partial' : 'completed',
      model: this.model.name,
      snapshotText: rendered.text,
      snapshotGeneratedAt: state.generatedAt,
      snapshotTruncated: rendered.truncated,
      snapshotCharacters: rendered.characters,
      costUsd,
      tokensInput,
      tokensOutput,
      failureReason: anyFailed ? 'At least one proposer failed.' : null,
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
      'skipped_disabled' | 'skipped_quota' | 'failed'
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
 */
function add(total: number | null, value: number | null): number | null {
  if (value === null) return total;
  return (total ?? 0) + value;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
