import { Injectable } from '@nestjs/common';

import type { ProposalDraft } from '../decision-log/decision-log.types';
import type { SnapshotRun } from '../snapshot/snapshot.types';
import type {
  ProposerContext,
  SupervisorProposer,
} from '../invocation/supervisor-proposer.port';

/**
 * Failure diagnosis and root-cause narration (#92).
 *
 * VISION §7 puts this in the advisory column — judgement work "where rules
 * genuinely cannot compete". The deterministic watchdog knows a run went
 * silent; it cannot say why.
 *
 * ## It never blocks the deterministic response
 *
 * The watchdog has already acted by the time this runs. This proposer reads a
 * snapshot rendered from state the watchdog wrote, on an hourly schedule, and
 * writes to the decision log. There is no path from a diagnosis back to a run,
 * and #92's fourth criterion — "it never blocks or delays the deterministic
 * response" — is satisfied by there being nothing to block WITH.
 *
 * ## Every diagnosis is a hypothesis
 *
 * `HYPOTHESIS_PREFIX` is prepended by this class rather than requested from
 * the model, because a model asked to caveat itself will sometimes decline to.
 * #92: "a confident wrong diagnosis written into the permanent record is worse
 * than no diagnosis, because VISION §1's second motivation is that provenance
 * is unrecoverable once wrong."
 */
@Injectable()
export class RunDiagnosisProposer implements SupervisorProposer {
  readonly actionClass = 'run-diagnosis';
  readonly name = 'run-diagnosis';

  /**
   * How many runs one invocation will diagnose.
   *
   * A ceiling rather than "all of them": a bad day produces dozens of failed
   * runs, and an invocation that asks the model dozens of times spends the
   * quota VISION §7 says the workers should get first. The snapshot already
   * orders attention runs by longest silence, so the cap takes the worst.
   */
  static readonly MAX_PER_INVOCATION = 3;

  async propose(context: ProposerContext): Promise<ProposalDraft[]> {
    const candidates = diagnosable(context.state.attentionRuns).slice(
      0,
      RunDiagnosisProposer.MAX_PER_INVOCATION,
    );

    if (candidates.length === 0) {
      // A DECLINED row, not an empty array. #90: a class nothing proposes
      // must be distinguishable from one always proposed correctly, and "the
      // supervisor looked and every run was healthy" is evidence.
      return [
        {
          actionClass: 'run-diagnosis',
          outcome: 'declined',
          summary: 'No run needed diagnosis.',
          reasoning:
            'The snapshot showed no stalled, blocked or quarantined run, so there was ' +
            'nothing to explain.',
          targetKind: 'factory',
        },
      ];
    }

    const drafts: ProposalDraft[] = [];
    for (const run of candidates) {
      // Sequential rather than concurrent. Since ADR-0015 the spike would
      // land on the supervisor's own metered key rather than the workers'
      // quota, but it is still a burst against one rate limit, and a proposer
      // that fires n concurrent calls to diagnose n stalled runs is the shape
      // most likely to be throttled exactly when it has the most to say.
      const response = await context.model.ask({
        snapshot: context.snapshot,
        instruction: diagnosisInstruction(run),
        maxOutputTokens: 400,
      });

      drafts.push({
        actionClass: 'run-diagnosis',
        outcome: 'proposed',
        summary: `${HYPOTHESIS_PREFIX} ${firstLine(response.text)}`,
        reasoning: `${HYPOTHESIS_PREFIX}\n\n${response.text.trim()}`,
        targetKind: 'run',
        targetRef: run.id,
        details: {
          // #92: "it links to the evidence it reasoned from". Recorded as the
          // specific facts, so a reviewer can check the diagnosis against what
          // was actually known rather than re-reading the whole snapshot.
          evidence: {
            workOrderIdentity: run.workOrderIdentity,
            status: run.status,
            runnerKey: run.runnerKey,
            attemptCount: run.attemptCount,
            lastEventAt: run.lastEventAt?.toISOString() ?? null,
            attentionReason: run.attentionReason,
            stopReason: run.stopReason,
          },
        },
      });
    }

    return drafts;
  }
}

/**
 * The attribution, prepended verbatim wherever a diagnosis is surfaced.
 *
 * One constant, imported by the run-summary composer as well, so the wording
 * cannot drift between the decision log and the permanent GitHub record.
 */
export const HYPOTHESIS_PREFIX =
  'Supervisor hypothesis (not a determined cause):';

/**
 * Which runs are worth explaining.
 *
 * A `blocked` run is excluded: it is parked on a rate limit with a known cause
 * and a scheduled resume, and asking a model why it stopped would produce
 * narration of a fact the control plane already recorded exactly.
 */
export function diagnosable(runs: readonly SnapshotRun[]): SnapshotRun[] {
  return runs.filter(
    (run) => run.status === 'stalled' || run.status === 'quarantined',
  );
}

/** What the model is asked, for one run. */
export function diagnosisInstruction(run: SnapshotRun): string {
  return [
    `Diagnose run ${run.id} (${run.repository}#${run.issueNumber}, work order`,
    `${run.workOrderIdentity}, attempt ${run.attemptCount}, status ${run.status}).`,
    '',
    'Say what the run was doing, where it went wrong, and what would plausibly fix it.',
    'Reason only from the snapshot above — it is everything that is known.',
    'If the snapshot does not support a conclusion, say that instead of guessing:',
    'a confident wrong diagnosis is worse than none, because it goes into a permanent',
    'record that cannot be corrected later.',
    'Answer in at most three short paragraphs. Do not add a caveat about being an AI;',
    'the attribution is added automatically.',
  ].join('\n');
}

function firstLine(text: string): string {
  const line = text.trim().split('\n')[0]?.trim() ?? '';
  return line.length > 200
    ? `${line.slice(0, 199)}…`
    : line || 'no diagnosis text';
}
