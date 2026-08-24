/**
 * Recording a verdict, and saying honestly what happened to it (#98).
 *
 * `POST /approvals/:id/decide` has four outcomes an operator must be able to
 * tell apart, and a hook that collapsed them into `error: string` would lose
 * the only distinction that matters — WHETHER ANYTHING WAS RECORDED:
 *
 *  - **recorded** — the verdict landed. It may still carry two things worth
 *    saying out loud: `grantSkippedReason` (the "always approve" flag was set
 *    and no grant resulted) and `decidedAfterTimeout` (the window had lapsed
 *    but the decision was honoured anyway).
 *  - **trust-grant-required** (403) — NOTHING was recorded. The whole request
 *    was refused because "Always approve this class" mints a grant and the
 *    caller lacks `trust:grant`. The approval is still open. `details
 *    .decisionApplied` is `false`, explicitly, so the UI never has to infer it
 *    from a status code — and the operator must never be left believing their
 *    approval went through.
 *  - **conflict** (409) — the request is no longer open, and `details.reason`
 *    says WHICH of the four ways. "Somebody else answered this" and "the clock
 *    answered it while you were typing" call for completely different things
 *    from the operator, which is the whole reason the API discriminates.
 *  - **gone** (404) / **failed** — everything else.
 *
 * The state is a discriminated union rather than a bag of booleans for the
 * same reason: an impossible combination (a recorded result AND a refusal)
 * cannot be constructed.
 */

import { useCallback, useState } from 'react';
import {
  ApiError,
  approvalErrorDetails,
  decideApproval,
} from '../services/api';
import type {
  ApprovalConflictReason,
  DecideApprovalInput,
  DecideApprovalResult,
} from '../types/approvals';
import { useIsMounted } from './useIsMounted';

export type ApprovalDecisionOutcome =
  | { kind: 'recorded'; result: DecideApprovalResult }
  | { kind: 'trust-grant-required'; message: string }
  | { kind: 'conflict'; reason: ApprovalConflictReason; message: string }
  | { kind: 'gone'; message: string }
  | { kind: 'failed'; message: string };

export interface UseApprovalDecisionResult {
  /** The last attempt's outcome, or null before the first one. */
  outcome: ApprovalDecisionOutcome | null;
  /** A decision is in flight. The buttons disable on it. */
  isDeciding: boolean;
  decide: (input: DecideApprovalInput) => Promise<void>;
  /** Clear the banner, e.g. when the operator edits the note and retries. */
  reset: () => void;
}

const CONFLICT_REASONS: readonly ApprovalConflictReason[] = [
  'already-decided-by-human',
  'already-timed-out',
  'already-authorized-by-grant',
  'superseded',
  'not-pending',
];

function conflictReasonOf(value: unknown): ApprovalConflictReason {
  return CONFLICT_REASONS.includes(value as ApprovalConflictReason)
    ? (value as ApprovalConflictReason)
    : 'not-pending';
}

/**
 * @param id         the approval being decided
 * @param onSettled  called after an outcome that CHANGED the row's real state
 *                   — a recorded verdict or a conflict. Not called after a 403,
 *                   because nothing moved and a refetch would imply otherwise.
 */
export function useApprovalDecision(
  id: string,
  onSettled?: () => void,
): UseApprovalDecisionResult {
  const [outcome, setOutcome] = useState<ApprovalDecisionOutcome | null>(null);
  const [isDeciding, setIsDeciding] = useState(false);
  // Every `setState` past an `await` is guarded — the house rule from
  // `useUsers.ts`. It earns its keep here: the operator can navigate away
  // between the tap and the response, and often does on a phone.
  const isMounted = useIsMounted();

  const decide = useCallback(
    async (input: DecideApprovalInput) => {
      setIsDeciding(true);
      setOutcome(null);

      try {
        const result = await decideApproval(id, input);
        if (isMounted()) setOutcome({ kind: 'recorded', result });
        onSettled?.();
      } catch (cause) {
        const next = toOutcome(cause);
        if (isMounted()) setOutcome(next);
        // A conflict means the row IS resolved, just not by this tap. Refetch
        // so the screen stops offering buttons for a question already answered.
        if (next.kind === 'conflict') onSettled?.();
      } finally {
        if (isMounted()) setIsDeciding(false);
      }
    },
    [id, isMounted, onSettled],
  );

  const reset = useCallback(() => setOutcome(null), []);

  return { outcome, isDeciding, decide, reset };
}

function toOutcome(cause: unknown): ApprovalDecisionOutcome {
  if (!(cause instanceof ApiError)) {
    return {
      kind: 'failed',
      message: cause instanceof Error ? cause.message : String(cause),
    };
  }

  const details = approvalErrorDetails(cause);

  if (cause.status === 403 && details.reason === 'trust-grant-required') {
    return { kind: 'trust-grant-required', message: cause.message };
  }

  if (cause.status === 409) {
    return {
      kind: 'conflict',
      reason: conflictReasonOf(details.reason),
      message: cause.message,
    };
  }

  if (cause.status === 404) {
    return { kind: 'gone', message: cause.message };
  }

  return { kind: 'failed', message: cause.message };
}
