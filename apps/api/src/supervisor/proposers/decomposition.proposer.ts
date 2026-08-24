import { Injectable } from '@nestjs/common';

import type { ProposalDraft } from '../decision-log/decision-log.types';
import type { SnapshotWorkOrder } from '../snapshot/snapshot.types';
import type {
  ProposerContext,
  SupervisorProposer,
} from '../invocation/supervisor-proposer.port';
import {
  parseModelJson,
  requireString,
  requireStringArray,
} from './model-json';

/**
 * Decomposition of oversized work orders (#110).
 *
 * VISION §7's advisory column lists it, and its expected promotion order puts
 * it second — after re-dispatch, before issue shaping. #55 punts loop
 * detection to this capability ("kill, re-plan") and #66's quarantine path is
 * where oversized orders pile up.
 *
 * ## Proposals only, and what that means after promotion
 *
 * Nothing here creates an issue, and the class is not promoted. #110 states
 * the constraint that applies when it is: the resulting issues are created
 * "only through the gated issue-creation adapter — the dedupe-and-template
 * gate — never directly". Recording that here rather than only in the issue,
 * because the person who promotes this class will read this file and may not
 * read #110.
 *
 * ## The prediction is the point
 *
 * #110 asks the proposal to "predict the improvement it expects so the
 * prediction is checkable". Success metric 4 is attempts per work order, and a
 * decomposition that does not reduce it did not help. Asking for the number up
 * front is what makes the review a measurement rather than an opinion about
 * whether the split looked sensible.
 */
@Injectable()
export class DecompositionProposer implements SupervisorProposer {
  readonly actionClass = 'decomposition';
  readonly name = 'decomposition';

  /** How many orders one invocation will try to split. */
  static readonly MAX_PER_INVOCATION = 2;

  async propose(context: ProposerContext): Promise<ProposalDraft[]> {
    const candidates = oversized(context.state.quarantinedWorkOrders).slice(
      0,
      DecompositionProposer.MAX_PER_INVOCATION,
    );

    if (candidates.length === 0) {
      return [
        {
          actionClass: 'decomposition',
          outcome: 'declined',
          summary: 'No work order looked oversized.',
          reasoning:
            'Nothing was quarantined after repeated attempts, so there was no order ' +
            'whose size is evidenced by its failure history.',
          targetKind: 'factory',
        },
      ];
    }

    const drafts: ProposalDraft[] = [];
    for (const order of candidates) {
      const response = await context.model.ask({
        snapshot: context.snapshot,
        instruction: decompositionInstruction(order),
        maxOutputTokens: 900,
      });

      let plan: DecompositionPlan;
      try {
        plan = parseDecomposition(response.text);
      } catch (error) {
        if (error instanceof EmptyDecomposition) {
          // A JUDGEMENT, not a failure: the model looked and concluded
          // splitting would not have helped. That belongs in the log as
          // evidence about the class, not as a proposer error.
          drafts.push({
            actionClass: 'decomposition',
            outcome: 'declined',
            summary: `${order.identity} is not oversized.`,
            reasoning: error.why,
            targetKind: 'work-order',
            targetRef: order.identity,
          });
          continue;
        }
        throw error;
      }

      drafts.push({
        actionClass: 'decomposition',
        outcome: 'proposed',
        summary: `Split ${order.identity} into ${plan.children.length} smaller issues.`,
        reasoning: plan.reasoning,
        targetKind: 'work-order',
        targetRef: order.identity,
        details: {
          children: plan.children,
          // Checkable after the fact: metric 4 for the parent is known, and
          // metric 4 for the children will be. A prediction nobody can grade
          // is a sentence, not evidence.
          prediction: {
            parentAttempts: order.attempt,
            predictedAttemptsPerChild: plan.predictedAttemptsPerChild,
          },
          // Stated in the record, not only in the issue: whoever promotes this
          // class reads the proposal.
          creationConstraint:
            'Once promoted, these issues are created ONLY through the gated ' +
            'issue-creation adapter — the dedupe-and-template gate — never directly.',
        },
      });
    }

    return drafts;
  }
}

/** One proposed child issue. */
export interface DecompositionChild {
  title: string;
  /** Why this piece exists and how it relates to the parent. */
  rationale: string;
  /** Testable, one per element. #110's first acceptance criterion. */
  acceptanceCriteria: string[];
}

export interface DecompositionPlan {
  reasoning: string;
  children: DecompositionChild[];
  /** What the supervisor expects metric 4 to be for each child. */
  predictedAttemptsPerChild: number;
}

/**
 * Which orders are evidenced as oversized.
 *
 * Quarantined ones only. VISION §10 reads a rising attempt count as evidence
 * of bad decomposition, and #66 quarantines at the retry ceiling — so a
 * quarantined order is one the system has already concluded is not going to
 * succeed as specified. Proposing splits for merely queued orders would be
 * guessing at size from the text, which is the thing spec-quality feedback
 * (#111) does deliberately and this should not do accidentally.
 */
export function oversized(
  orders: readonly SnapshotWorkOrder[],
): SnapshotWorkOrder[] {
  return orders.filter((order) => order.status === 'quarantined');
}

export function decompositionInstruction(order: SnapshotWorkOrder): string {
  return [
    `Work order ${order.identity} (${order.repository}#${order.issueNumber}) reached`,
    `attempt ${order.attempt} and was quarantined. It carries`,
    `${order.acceptanceCriteriaCount} acceptance criteria.`,
    '',
    'Propose splitting it into two or more smaller issues. For each child give a title,',
    'a rationale stating its relationship to the parent, and testable acceptance',
    'criteria — each one something a reviewer could check as done or not done.',
    'Also predict how many attempts you expect each child to need; the prediction is',
    'checked afterwards against what actually happens.',
    '',
    'If the order is not oversized — if it failed for a reason splitting would not fix —',
    'return an empty children array and say so in `reasoning`. A split that does not',
    'reduce attempts per work order did not help.',
    '',
    'Answer as JSON only:',
    '{"reasoning": "...", "predictedAttemptsPerChild": 1, "children": [',
    '  {"title": "...", "rationale": "...", "acceptanceCriteria": ["...", "..."]}',
    ']}',
  ].join('\n');
}

/**
 * Validate the model's plan.
 *
 * Throws on anything malformed. A decomposition with an untestable criterion,
 * or with one child, is not a decomposition — and letting it through would put
 * a row in the log that a reviewer rejects for a reason that has nothing to do
 * with the supervisor's judgement, biasing the class's approval rate.
 */
export function parseDecomposition(text: string): DecompositionPlan {
  const raw = parseModelJson<Record<string, unknown>>(text);

  const reasoning = requireString(raw.reasoning, 'reasoning');
  const rawChildren = Array.isArray(raw.children) ? raw.children : [];

  if (rawChildren.length === 0) {
    throw new EmptyDecomposition(reasoning);
  }
  if (rawChildren.length < 2) {
    throw new Error('A decomposition needs at least two children.');
  }

  const children = rawChildren.map((child, index) => {
    const record = (child ?? {}) as Record<string, unknown>;
    return {
      title: requireString(record.title, `children[${index}].title`),
      rationale: requireString(
        record.rationale,
        `children[${index}].rationale`,
      ),
      acceptanceCriteria: requireStringArray(
        record.acceptanceCriteria,
        `children[${index}].acceptanceCriteria`,
      ),
    };
  });

  const predicted = Number(raw.predictedAttemptsPerChild);
  if (!Number.isFinite(predicted) || predicted < 1) {
    throw new Error(
      'predictedAttemptsPerChild is missing or not a number of attempts.',
    );
  }

  return { reasoning, children, predictedAttemptsPerChild: predicted };
}

/**
 * The model looked and concluded the order is not oversized.
 *
 * A distinct type rather than a generic parse failure, because it is a
 * JUDGEMENT and belongs in the log as a decline — where "splitting would not
 * have helped" is evidence about the class.
 */
export class EmptyDecomposition extends Error {
  constructor(readonly why: string) {
    super(why);
    this.name = 'EmptyDecomposition';
  }
}
