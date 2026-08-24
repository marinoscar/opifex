import { Injectable } from '@nestjs/common';

import type { ProposalDraft } from '../decision-log/decision-log.types';
import type { SnapshotSpecRejection } from '../snapshot/snapshot.types';
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
 * Issue shaping (#109).
 *
 * VISION §7's advisory column lists "issue shaping → acceptance criteria" as
 * judgement work where rules cannot compete, and puts it at rung 3 of the
 * promotion order. It matters more than its phase suggests: VISION §10 says
 * metric 3 (first-pass acceptance) decides the roadmap, and that "throughput
 * ceiling is spec quality, not token budget".
 *
 * ## The candidates come from the deterministic gate, not from a guess
 *
 * #62 already refuses to project a work order from an issue with no testable
 * acceptance criteria, and records that refusal with the message the author
 * was given. Those rows are the truest available signal of an under-specified
 * issue — not an opinion about the text, but a record that the system
 * ALREADY REFUSED IT and said why.
 *
 * #111 puts the same point the other way round: the gate "is a floor, not
 * feedback — it says no without saying what yes looks like". This proposer
 * answers the second half, and it answers it about exactly the issues the
 * first half turned away.
 *
 * ## It never edits the issue
 *
 * The proposed rewrite is a string in the decision log. #109's third criterion
 * is that "the proposal never edits the issue itself — observe-only until
 * promoted", and that is structural rather than careful: this class has no
 * GitHub client, and `SupervisorModule` imports nothing that could give it one.
 */
@Injectable()
export class IssueShapingProposer implements SupervisorProposer {
  readonly actionClass = 'issue-shaping';
  readonly name = 'issue-shaping';

  /** How many issues one invocation will shape. */
  static readonly MAX_PER_INVOCATION = 3;

  async propose(context: ProposerContext): Promise<ProposalDraft[]> {
    const candidates = context.state.specRejections.slice(
      0,
      IssueShapingProposer.MAX_PER_INVOCATION,
    );

    if (candidates.length === 0) {
      return [
        {
          actionClass: 'issue-shaping',
          outcome: 'declined',
          summary: 'No issue was waiting on a better specification.',
          reasoning:
            'The spec gate turned nothing away, so there was no issue whose ' +
            'under-specification is evidenced rather than guessed at.',
          targetKind: 'factory',
        },
      ];
    }

    const drafts: ProposalDraft[] = [];
    for (const rejection of candidates) {
      const response = await context.model.ask({
        snapshot: context.snapshot,
        instruction: shapingInstruction(rejection),
        maxOutputTokens: 900,
      });

      const shaping = parseShaping(response.text);

      drafts.push({
        actionClass: 'issue-shaping',
        outcome: 'proposed',
        summary: `Shape ${rejection.repository}#${rejection.issueNumber}: ${shaping.acceptanceCriteria.length} acceptance criteria proposed.`,
        reasoning: shaping.reasoning,
        targetKind: 'issue',
        // `owner/name#number`, because an issue with no work order has no
        // identity to point at — the log's `targetRef` is deliberately not a
        // foreign key for exactly this case.
        targetRef: `${rejection.repository}#${rejection.issueNumber}`,
        details: {
          acceptanceCriteria: shaping.acceptanceCriteria,
          gaps: shaping.gaps,
          // A rewrite, stored. Applying it is a human's action until the class
          // is promoted, and after promotion it is an issue EDIT — which is
          // why ADR-0011 classifies this as reversible-with-effort rather than
          // reversible.
          suggestedBody: shaping.suggestedBody,
          rejectedBecause: rejection.message,
        },
      });
    }

    return drafts;
  }
}

export interface IssueShaping {
  reasoning: string;
  /** Testable, one per element. #109's first acceptance criterion. */
  acceptanceCriteria: string[];
  /** What the issue does not say: missing component, untestable claims. */
  gaps: string[];
  /** A template-conformant rewrite. Never applied by this path. */
  suggestedBody: string;
}

export function shapingInstruction(rejection: SnapshotSpecRejection): string {
  return [
    `Issue ${rejection.repository}#${rejection.issueNumber} was refused by the`,
    'specification gate. The author was told:',
    '',
    rejection.message,
    '',
    'Propose a shaping of that issue. Give acceptance criteria that are TESTABLE —',
    'each one something a reviewer could mark done or not done without a judgement',
    'call. List the gaps: what the issue does not say that it needs to, such as a',
    'missing component or a claim nobody could check. Then give a rewritten body',
    'that conforms to the feature-request template.',
    '',
    "Derive everything from the issue's own problem statement. Do not invent scope:",
    'a shaping that changes what the issue is asking for is a different issue, and a',
    'human reviewing this will reject it — correctly.',
    '',
    'Answer as JSON only:',
    '{"reasoning": "...", "acceptanceCriteria": ["...", "..."], "gaps": ["..."],',
    ' "suggestedBody": "..."}',
  ].join('\n');
}

/**
 * Validate the shaping.
 *
 * `gaps` may legitimately be empty — an issue can be under-specified purely by
 * missing criteria, with nothing else absent — so it is the one field that
 * defaults rather than throws. Everything else is required, because a shaping
 * with no criteria is not a shaping, and a rewrite that is missing would send
 * a reviewer to the issue to work out what was meant.
 */
export function parseShaping(text: string): IssueShaping {
  const raw = parseModelJson<Record<string, unknown>>(text);

  return {
    reasoning: requireString(raw.reasoning, 'reasoning'),
    acceptanceCriteria: requireStringArray(
      raw.acceptanceCriteria,
      'acceptanceCriteria',
    ),
    gaps: Array.isArray(raw.gaps)
      ? raw.gaps.map((gap, index) => requireString(gap, `gaps[${index}]`))
      : [],
    suggestedBody: requireString(raw.suggestedBody, 'suggestedBody'),
  };
}
