/**
 * The steering conversation: propose, confirm, report (#426, epic #419).
 *
 * ## Two calls, and the hook cannot collapse them
 *
 * `propose` never applies. There is no branch in this file where a proposal
 * with a confident parse, a small blast radius or no removals goes straight to
 * `applySteering` — the confirmation is what keeps this chat from being a
 * second controller, and an exception for the easy cases is how that erodes.
 * `apply` takes the operations it is given, which are the ones a human ticked.
 *
 * ## The transcript keeps failures
 *
 * Turns are appended and never rewritten. A refused apply, a stale proposal
 * and a run where four issues drifted all stay on screen under the instruction
 * that produced them — the alternative is a surface where the only visible
 * state is the last thing that worked.
 *
 * ## Nothing is stored anywhere else
 *
 * The proposal lives in this component tree for its thirty minutes and is
 * handed back verbatim on apply, because the API stores none of it
 * (`steering.dto.ts`). In particular `observedInputLabels` is passed straight
 * through: it is the baseline the server re-reads each issue against, and
 * every reshaping of it — sorting, de-duplicating, narrowing to the two
 * steerable labels — turns drift detection off while leaving it looking like
 * it works.
 *
 * The same is true of the SCOPE. It is held here only long enough to be sent,
 * and again only so a refused instruction can be asked again unchanged — never
 * written anywhere, because a stored scope and the `factory:` labels would be
 * two expressions of the same intent for the reconciler to arbitrate between
 * (ADR-0020 decision 4).
 */

import { useCallback, useRef, useState } from 'react';

import { ApiError, applySteering, proposeSteering } from '../services/api';
import type {
  ApplySteeringOperation,
  SteeringApplyResult,
  SteeringOperation,
  SteeringProposal,
  SteeringScopeRequest,
} from '../types/steering';
import { useIsMounted } from './useIsMounted';

/** A refusal, kept as data so the wording stays in `config/steeringChat.ts`. */
export interface SteeringFailure {
  /** The HTTP status, or null when the request never got one. */
  status: number | null;
  /** The API's own message, rendered verbatim beside the remedy. */
  detail: string;
}

export type SteeringTurn =
  | { id: string; kind: 'instruction'; instruction: string }
  | {
      id: string;
      kind: 'proposal';
      instruction: string;
      proposal: SteeringProposal;
    }
  | {
      id: string;
      kind: 'refusal';
      instruction: string;
      phase: 'propose' | 'apply';
      failure: SteeringFailure;
      /**
       * The scope that produced it, kept so "propose again" asks the same
       * question.
       *
       * Re-proposing a stale instruction without its scope would silently
       * widen or narrow what the operator originally chose — the mis-scoping
       * #460 exists to remove, arrived at through the retry button instead of
       * through a typo.
       */
      scope: SteeringScopeRequest;
    }
  | {
      id: string;
      kind: 'result';
      instruction: string;
      result: SteeringApplyResult;
    }
  | { id: string; kind: 'discarded'; instruction: string };

export interface UseSteeringResult {
  /** Everything said so far, oldest first. */
  turns: SteeringTurn[];
  /** The proposal awaiting a human. Null when there is nothing to confirm. */
  pending: SteeringProposal | null;
  isProposing: boolean;
  isApplying: boolean;
  /**
   * `scope` carries AT MOST ONE of `repository`, `project` and
   * `allRepositories` — the API answers 400 to two, and `SteeringScopeRequest`
   * is a union so a caller cannot be holding both.
   */
  propose: (instruction: string, scope?: SteeringScopeRequest) => Promise<void>;
  apply: (
    proposal: SteeringProposal,
    operations: readonly SteeringOperation[],
  ) => Promise<void>;
  /** Throw the proposal away without writing anything. */
  discard: () => void;
}

/**
 * The proposal's operations, as apply takes them back.
 *
 * `observedInputLabels` is copied and not touched. Exported so the echo can be
 * asserted directly as well as over the wire.
 */
export function toApplyOperations(
  operations: readonly SteeringOperation[],
): ApplySteeringOperation[] {
  return operations.map((operation) => ({
    owner: operation.owner,
    name: operation.name,
    number: operation.number,
    add: [...operation.add],
    remove: [...operation.remove],
    observedInputLabels: [...operation.observedInputLabels],
  }));
}

function failureFrom(cause: unknown): SteeringFailure {
  return {
    status: cause instanceof ApiError ? cause.status : null,
    detail:
      cause instanceof Error
        ? cause.message
        : 'The API gave no reason for the refusal.',
  };
}

/**
 * A turn before it has an id.
 *
 * Distributive on purpose: a bare `Omit<SteeringTurn, 'id'>` over a union
 * keeps only the keys every member shares, which would silently reduce every
 * turn to `kind` and `instruction` and make the payloads unassignable.
 */
type NewTurn = SteeringTurn extends infer T
  ? T extends { id: string }
    ? Omit<T, 'id'>
    : never
  : never;

export function useSteering(): UseSteeringResult {
  const [turns, setTurns] = useState<SteeringTurn[]>([]);
  const [pending, setPending] = useState<SteeringProposal | null>(null);
  // The scope that produced `pending`, so an apply refusal can offer to ask
  // the same question again rather than a wider or narrower one.
  const [pendingScope, setPendingScope] = useState<SteeringScopeRequest>({});
  const [isProposing, setIsProposing] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  // Every `setState` past an `await` is guarded: an answer landing after the
  // operator has navigated away must not update a gone component.
  const isMounted = useIsMounted();
  const nextId = useRef(0);

  const append = useCallback((turn: NewTurn) => {
    const id = `turn-${(nextId.current += 1)}`;
    setTurns((current) => [...current, { ...turn, id } as SteeringTurn]);
  }, []);

  const propose = useCallback(
    async (instruction: string, scope: SteeringScopeRequest = {}) => {
      const trimmed = instruction.trim();
      if (trimmed.length === 0) return;

      append({ kind: 'instruction', instruction: trimmed });
      // A new instruction replaces whatever was awaiting confirmation: two
      // live proposals would be two things a Confirm button could mean.
      setPending(null);
      setPendingScope(scope);
      setIsProposing(true);

      try {
        // Spread, not composed field by field: the scope arrives as one
        // member of an exclusive union, so there is no branch here that could
        // send two of the three and earn a 400 the operator never asked for.
        const proposal = await proposeSteering({
          instruction: trimmed,
          ...scope,
        });
        if (!isMounted()) return;
        append({ kind: 'proposal', instruction: trimmed, proposal });
        setPending(proposal);
      } catch (cause) {
        if (!isMounted()) return;
        append({
          kind: 'refusal',
          instruction: trimmed,
          phase: 'propose',
          failure: failureFrom(cause),
          scope,
        });
      } finally {
        if (isMounted()) setIsProposing(false);
      }
    },
    [append, isMounted],
  );

  const apply = useCallback(
    async (
      proposal: SteeringProposal,
      operations: readonly SteeringOperation[],
    ) => {
      if (operations.length === 0) return;
      setIsApplying(true);

      try {
        const result = await applySteering({
          proposalId: proposal.proposalId,
          proposedAt: proposal.proposedAt,
          instruction: proposal.instruction,
          operations: toApplyOperations(operations),
        });
        if (!isMounted()) return;
        append({
          kind: 'result',
          instruction: proposal.instruction,
          result,
        });
        // The proposal has been spent. It is not offered again: re-confirming
        // the same diff would re-send label writes that already landed.
        setPending(null);
      } catch (cause) {
        if (!isMounted()) return;
        const failure = failureFrom(cause);
        append({
          kind: 'refusal',
          instruction: proposal.instruction,
          phase: 'apply',
          failure,
          scope: pendingScope,
        });
        // A stale proposal (409) is retired: it cannot be applied again by
        // definition, and leaving the button live would offer an action the
        // API will refuse every time. Any other refusal leaves it standing,
        // because a 401 or a transient failure is worth trying again with the
        // diff the operator already read.
        if (failure.status === 409) setPending(null);
      } finally {
        if (isMounted()) setIsApplying(false);
      }
    },
    [append, isMounted, pendingScope],
  );

  // Not written as a `setPending` updater with the append inside it: a state
  // updater must be pure, and React would run it twice under StrictMode —
  // putting the discarded turn on the transcript twice.
  const discard = useCallback(() => {
    if (pending === null) return;
    append({ kind: 'discarded', instruction: pending.instruction });
    setPending(null);
  }, [append, pending]);

  return { turns, pending, isProposing, isApplying, propose, apply, discard };
}
