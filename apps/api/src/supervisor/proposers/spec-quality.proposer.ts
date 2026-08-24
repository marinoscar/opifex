import { Injectable, Logger } from '@nestjs/common';

import type { ProposalDraft } from '../decision-log/decision-log.types';
import type {
  ProposerContext,
  SupervisorProposer,
} from '../invocation/supervisor-proposer.port';
import {
  correlateSpecQuality,
  formatRate,
  MIN_RUNS_FOR_SIGNAL,
  underSpecifiedQueue,
  type SpecQualityFinding,
} from './spec-quality';

/**
 * Spec-quality feedback (#111).
 *
 * #62 already enforces the deterministic floor — an issue without testable
 * acceptance criteria produces no work order — but #111 names the gap
 * precisely: "a gate is not feedback: it says no without saying what 'yes'
 * looks like". With this missing, spec quality improves only by the operator
 * guessing.
 *
 * ## The finding is computed; only the advice is judgement
 *
 * `correlateSpecQuality` buckets concluded runs by how specified their work
 * order was and reports first-pass merge rate per band. That arithmetic is
 * deterministic and lives outside the model, because a model asked "which
 * issue shapes worked" will answer confidently whether or not the data
 * supports one — and #90's approval rate cannot tell a plausible narrative
 * from a true one.
 *
 * ## It degrades to the fact
 *
 * If the model is unavailable or fails, the proposal is still written with the
 * measured finding and no narration. The correlation is the part an operator
 * can act on; losing the prose costs a paragraph, and losing the whole
 * proposal because the prose failed would throw away a real measurement. This
 * is the one proposer that has something true to say without a model, so it is
 * the one where swallowing the error is right rather than dishonest.
 *
 * ## Observe-only, and never in front of dispatch
 *
 * Flagged queue entries are listed in a proposal. Nothing here holds, blocks
 * or reorders anything — #62's deterministic gate is what refuses work, and
 * #111's last criterion is that this never does.
 */
@Injectable()
export class SpecQualityProposer implements SupervisorProposer {
  private readonly logger = new Logger(SpecQualityProposer.name);

  readonly actionClass = 'spec-quality-feedback';
  readonly name = 'spec-quality-feedback';

  async propose(context: ProposerContext): Promise<ProposalDraft[]> {
    const finding = correlateSpecQuality(context.state.recentRuns);
    const thin = underSpecifiedQueue(context.state.queuedWorkOrders);

    if (!finding.hasSignal && thin.length === 0) {
      return [
        {
          actionClass: 'spec-quality-feedback',
          outcome: 'declined',
          summary: 'Not enough evidence to say anything about spec quality.',
          reasoning:
            `No band reached ${MIN_RUNS_FOR_SIGNAL} concluded runs with a different ` +
            'first-pass rate from another band, and nothing in the queue looked thin. ' +
            'A correlation drawn from fewer runs than that is arithmetic, not evidence.',
          targetKind: 'factory',
        },
      ];
    }

    const narration = await this.narrate(context, finding, thin.length);

    return [
      {
        actionClass: 'spec-quality-feedback',
        outcome: 'proposed',
        summary: summarize(finding, thin.length),
        reasoning: [describe(finding, thin), narration]
          .filter(Boolean)
          .join('\n\n'),
        targetKind: 'factory',
        details: {
          buckets: finding.buckets,
          minimumRunsForSignal: MIN_RUNS_FOR_SIGNAL,
          // #111: "feedback cites the runs/PRs it reasons from." The ids, so a
          // reviewer can check the correlation rather than trust it.
          citedRuns: context.state.recentRuns.map((run) => ({
            runId: run.id,
            workOrderIdentity: run.workOrderIdentity,
            acceptanceCriteriaCount: run.acceptanceCriteriaCount,
            pullRequestNumber: run.pullRequestNumber,
            pullRequestState: run.pullRequestState,
          })),
          // Flagged BEFORE dispatch, which is the only version that saves
          // anything. The same observation after a failure is a post-mortem.
          underSpecifiedQueue: thin.map((order) => ({
            identity: order.identity,
            repository: order.repository,
            issueNumber: order.issueNumber,
            acceptanceCriteriaCount: order.acceptanceCriteriaCount,
          })),
          narrated: narration !== '',
        },
      },
    ];
  }

  /**
   * Ask the model what to do about the finding. Optional by design.
   *
   * Swallowed rather than propagated: the measurement is already worth
   * recording, and #111's value is the correlation more than the paragraph.
   */
  private async narrate(
    context: ProposerContext,
    finding: SpecQualityFinding,
    thinCount: number,
  ): Promise<string> {
    try {
      const response = await context.model.ask({
        snapshot: context.snapshot,
        instruction: specQualityInstruction(finding, thinCount),
        maxOutputTokens: 500,
      });
      return response.text.trim();
    } catch (error) {
      this.logger.warn(
        `Spec-quality narration unavailable; the measured finding is recorded ` +
          `without it: ${error instanceof Error ? error.message : String(error)}`,
      );
      return '';
    }
  }
}

function summarize(finding: SpecQualityFinding, thinCount: number): string {
  const parts: string[] = [];
  if (finding.hasSignal) {
    const best = [...finding.comparable].sort(
      (a, b) => (b.firstPassRate ?? 0) - (a.firstPassRate ?? 0),
    )[0];
    parts.push(
      `${best.label} merged first-pass ${formatRate(best.firstPassRate)}`,
    );
  }
  if (thinCount > 0) {
    parts.push(`${thinCount} queued order(s) look under-specified`);
  }
  return parts.join('; ');
}

function describe(
  finding: SpecQualityFinding,
  thin: readonly { identity: string; acceptanceCriteriaCount: number }[],
): string {
  const lines = ['First-pass acceptance by specification detail:', ''];
  for (const bucket of finding.buckets) {
    const rate =
      bucket.runs < MIN_RUNS_FOR_SIGNAL
        ? `${formatRate(null)} (only ${bucket.runs} run(s) — below the threshold)`
        : formatRate(bucket.firstPassRate);
    lines.push(`- ${bucket.label}: ${rate} of ${bucket.runs} concluded run(s)`);
  }

  if (thin.length > 0) {
    lines.push('', 'Queued and thin, before dispatch:');
    for (const order of thin) {
      lines.push(
        `- ${order.identity}: ${order.acceptanceCriteriaCount} acceptance criteria`,
      );
    }
  }

  return lines.join('\n');
}

export function specQualityInstruction(
  finding: SpecQualityFinding,
  thinCount: number,
): string {
  return [
    'The first-pass acceptance rates above were MEASURED, not inferred. Do not',
    'recompute or dispute them.',
    '',
    'Say what an operator should write differently in their issues, given those rates',
    `and the ${thinCount} queued order(s) flagged as thin. Be specific about the`,
    'acceptance-criteria patterns that are working: "state the HTTP status" beats',
    '"write better criteria".',
    '',
    finding.comparable.length < 2
      ? 'The evidence is thin. Say so rather than drawing a conclusion from it.'
      : 'Two or more bands have enough runs to compare.',
    '',
    'At most two short paragraphs. No preamble, no restating the numbers.',
  ].join('\n');
}
