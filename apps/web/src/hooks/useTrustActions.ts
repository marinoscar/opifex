/**
 * The two acts this cockpit can perform on trust, and saying honestly what
 * happened to each (#101, epic #22).
 *
 * Both follow `useApprovalDecision`: a DISCRIMINATED UNION rather than a bag
 * of booleans, so an impossible combination — a recorded result AND a refusal
 * — cannot be constructed, and so the one distinction that matters is never
 * flattened into `error: string`.
 *
 * ## Revoking a grant
 *
 *  - **revoked** — it is over, at once and permanently. The ENDED grant comes
 *    back rather than a 204, so the screen can render the terminal state
 *    without a follow-up read that would race the next sweep.
 *  - **already-ended** (409) — NOTHING was changed, and the existing end
 *    reason stands. This is not an error to apologise for: the grant
 *    authorizes nothing, which is what the operator wanted. It has to be
 *    distinguished from a failure because the correct response is "no further
 *    action" rather than "try again".
 *
 * ## Demoting a class
 *
 *  - **demoted** — carries `grantsSuspended` (the durable effect) and
 *    `rungMayBeRestoredByLadder`, which MUST be surfaced. True is the common
 *    case: a class demoted by hand while its lifetime record still clears the
 *    bar is re-promoted by the next hourly evaluation, because there is no
 *    column recording a human hold-down. The suspended grants stay suspended,
 *    so nothing resumes running — but the rung will read `promoted` again, and
 *    an operator who is not told concludes the button did nothing.
 *  - **not-promoted** (409) — the class was not on the promoted rung, so there
 *    was nothing to take away.
 */

import { useCallback, useState } from 'react';
import {
  ApiError,
  demoteActionClass,
  revokeTrustGrant,
  trustErrorDetails,
} from '../services/api';
import type { ManualDemotionResult, TrustGrantDetail } from '../types/trust';
import { useIsMounted } from './useIsMounted';

// ---------------------------------------------------------------------------
// Revocation
// ---------------------------------------------------------------------------

export type GrantRevocationOutcome =
  | { kind: 'revoked'; grant: TrustGrantDetail }
  | { kind: 'already-ended'; message: string }
  | { kind: 'gone'; message: string }
  | { kind: 'forbidden'; message: string }
  | { kind: 'failed'; message: string };

export interface UseGrantRevocationResult {
  outcome: GrantRevocationOutcome | null;
  /** A revocation is in flight. The button disables on it. */
  isRevoking: boolean;
  /** The id currently being revoked, so a LIST can disable only that row. */
  revokingId: string | null;
  revoke: (id: string, note?: string) => Promise<void>;
  reset: () => void;
}

/**
 * @param onSettled called after an outcome that changed, or revealed, the
 *                  row's real state — a revocation or a 409. Both mean the
 *                  screen is now out of date. Not called after a 403, because
 *                  nothing moved and a refetch would imply otherwise.
 */
export function useGrantRevocation(
  onSettled?: () => void,
): UseGrantRevocationResult {
  const [outcome, setOutcome] = useState<GrantRevocationOutcome | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  // Every `setState` past an `await` is guarded — the house rule from
  // `useUsers.ts`, and it earns its keep here because an operator revoking
  // from a list frequently navigates on before the response lands.
  const isMounted = useIsMounted();

  const revoke = useCallback(
    async (id: string, note?: string) => {
      setRevokingId(id);
      setOutcome(null);

      try {
        const grant = await revokeTrustGrant(id, note);
        if (isMounted()) setOutcome({ kind: 'revoked', grant });
        onSettled?.();
      } catch (cause) {
        const next = toRevocationOutcome(cause);
        if (isMounted()) setOutcome(next);
        // A 409 means the grant IS over, just not by this tap. Refetch so the
        // screen stops offering a button for something already ended.
        if (next.kind === 'already-ended') onSettled?.();
      } finally {
        if (isMounted()) setRevokingId(null);
      }
    },
    [isMounted, onSettled],
  );

  const reset = useCallback(() => setOutcome(null), []);

  return {
    outcome,
    isRevoking: revokingId !== null,
    revokingId,
    revoke,
    reset,
  };
}

function toRevocationOutcome(cause: unknown): GrantRevocationOutcome {
  if (!(cause instanceof ApiError)) {
    return {
      kind: 'failed',
      message: cause instanceof Error ? cause.message : String(cause),
    };
  }

  if (
    cause.status === 409 &&
    trustErrorDetails(cause).reason === 'already-ended'
  ) {
    return { kind: 'already-ended', message: cause.message };
  }
  if (cause.status === 404) return { kind: 'gone', message: cause.message };
  if (cause.status === 403)
    return { kind: 'forbidden', message: cause.message };

  return { kind: 'failed', message: cause.message };
}

// ---------------------------------------------------------------------------
// Manual demotion
// ---------------------------------------------------------------------------

export type ClassDemotionOutcome =
  | { kind: 'demoted'; result: ManualDemotionResult }
  | { kind: 'not-promoted'; message: string }
  | { kind: 'forbidden'; message: string }
  | { kind: 'failed'; message: string };

export interface UseClassDemotionResult {
  outcome: ClassDemotionOutcome | null;
  isDemoting: boolean;
  /** The class currently being demoted, so a LADDER disables only that card. */
  demotingClass: string | null;
  demote: (actionClass: string, note?: string) => Promise<void>;
  reset: () => void;
}

export function useClassDemotion(
  onSettled?: () => void,
): UseClassDemotionResult {
  const [outcome, setOutcome] = useState<ClassDemotionOutcome | null>(null);
  const [demotingClass, setDemotingClass] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const demote = useCallback(
    async (actionClass: string, note?: string) => {
      setDemotingClass(actionClass);
      setOutcome(null);

      try {
        const result = await demoteActionClass(actionClass, note);
        if (isMounted()) setOutcome({ kind: 'demoted', result });
        onSettled?.();
      } catch (cause) {
        const next = toDemotionOutcome(cause);
        if (isMounted()) setOutcome(next);
        if (next.kind === 'not-promoted') onSettled?.();
      } finally {
        if (isMounted()) setDemotingClass(null);
      }
    },
    [isMounted, onSettled],
  );

  const reset = useCallback(() => setOutcome(null), []);

  return {
    outcome,
    isDemoting: demotingClass !== null,
    demotingClass,
    demote,
    reset,
  };
}

function toDemotionOutcome(cause: unknown): ClassDemotionOutcome {
  if (!(cause instanceof ApiError)) {
    return {
      kind: 'failed',
      message: cause instanceof Error ? cause.message : String(cause),
    };
  }

  if (
    cause.status === 409 &&
    trustErrorDetails(cause).reason === 'not-promoted'
  ) {
    return { kind: 'not-promoted', message: cause.message };
  }
  if (cause.status === 403)
    return { kind: 'forbidden', message: cause.message };

  return { kind: 'failed', message: cause.message };
}
