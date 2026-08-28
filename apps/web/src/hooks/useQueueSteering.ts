/**
 * Hold and release, one row or many, with the next-tick delay made visible
 * (#85, #421).
 *
 * ## Why there is no optimistic update here
 *
 * #85 is explicit: *"an action here takes effect on the next tick, not
 * instantly. The UI must show that honestly — a pending-until-next-tick state —
 * rather than optimistically rendering success and then flickering back."*
 *
 * So a steered work order enters a `pending` set and STAYS there until the
 * polled queue itself changes. The row does not pretend to be held; it says a
 * hold has been requested. When the next reconciler tick lands, the queue
 * refetches and the row's real state arrives from the server — which is also
 * why this reconciles correctly if somebody edits the label in GitHub instead.
 * Nothing here is a local model of queue state that could disagree.
 *
 * ## Why a bulk steer is N sequential requests and not a batch endpoint (#421)
 *
 * `steerMany` loops `POST /queue/:id/hold`, exactly as
 * `useAvailableRepositories.registerMany` loops `POST /repositories` (#407),
 * and for the same two reasons.
 *
 * A batch endpoint would be new API surface that has to invent its own
 * partial-failure semantics anyway — a batch of eight where the third is gone
 * and the fifth is refused cannot answer one status honestly — so it would
 * relocate the problem rather than remove it. The one thing it could add that
 * N requests cannot is a transaction, and a transaction is precisely the
 * outcome this feature does not want: if the third of eight is refused, the
 * first two labels are already on GitHub and should stay there.
 *
 * The loop is **sequential** for the reason `reconciler.service.ts` gives for
 * its own sweep: every one of these writes a label through the shared GitHub
 * budget (VISION §11), and firing thirty at once is the shape that trips a
 * secondary rate limit for no wall-clock benefit worth having.
 *
 * ## `labelWritten: false` is not a success and not an error
 *
 * The steer endpoints answer 200 with `labelWritten: false` when
 * `github.writesEnabled` is off. Both the single and the bulk path read that
 * field rather than the HTTP status, and neither marks such a work order
 * pending: a pending badge for a request that never left the building is the
 * same optimistic lie in a different place.
 */

import { useCallback, useState } from 'react';
import { ApiError, holdWorkOrder, releaseWorkOrder } from '../services/api';
import {
  classifyResult,
  type SteerIntent,
  type SteerOutcome,
} from '../config/queueSteering';
import { useIsMounted } from './useIsMounted';

export type { SteerIntent };

/** How far a running bulk steer has got. Null when none is running. */
export interface SteerProgress {
  /** Requests that have ANSWERED — refusals included, since a refusal is an
   * answer and the run has moved past it. */
  done: number;
  total: number;
  /** The one in flight. */
  current: string;
}

export interface QueueSteeringState {
  /** Work-order ids whose label was written and whose tick has not landed. */
  pending: Record<string, SteerIntent>;
  /** Non-null after a failed single steer, cleared on the next attempt. */
  error: string | null;
  steer: (workOrderId: string, intent: SteerIntent) => Promise<void>;
  /**
   * Steer several, in order, reporting per work order.
   *
   * Resolves with one `SteerOutcome` per id in the order they were attempted
   * and **never rejects**: a refusal partway through is an ordinary outcome of
   * a run, not a failure of it, and throwing would discard the answers for the
   * work orders that had already succeeded. The loop runs to the end rather
   * than stopping at the first refusal, so what comes back does not depend on
   * the order the rows happened to be in.
   */
  steerMany: (
    workOrderIds: readonly string[],
    intent: SteerIntent,
  ) => Promise<SteerOutcome[]>;
  progress: SteerProgress | null;
  /** Drop a work order from `pending` once the server agrees. */
  settle: (workOrderId: string) => void;
}

export function useQueueSteering(onWritten?: () => void): QueueSteeringState {
  const [pending, setPending] = useState<Record<string, SteerIntent>>({});
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<SteerProgress | null>(null);
  // Every `setState` past an `await` is guarded: a run settling after the
  // operator has navigated away must not update a gone component.
  const isMounted = useIsMounted();

  const steer = useCallback(
    async (workOrderId: string, intent: SteerIntent) => {
      setError(null);
      try {
        const result =
          intent === 'hold'
            ? await holdWorkOrder(workOrderId)
            : await releaseWorkOrder(workOrderId);

        // Only pending if the label actually reached GitHub. With writes
        // disabled the endpoint reports `labelWritten: false`, and showing a
        // pending badge for a request that never left the building would be
        // the same lie in a different place.
        if (result.labelWritten) {
          setPending((current) => ({ ...current, [workOrderId]: intent }));
        } else {
          setError(
            'The label was not written: GitHub writes are disabled on this deployment.',
          );
        }
        onWritten?.();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [onWritten],
  );

  const steerMany = useCallback(
    async (workOrderIds: readonly string[], intent: SteerIntent) => {
      const outcomes: SteerOutcome[] = [];
      // The single-steer banner is cleared: a message from a previous row
      // sitting above a fresh run would be read as this run's answer, and the
      // run reports itself per work order.
      setError(null);

      try {
        for (const workOrderId of workOrderIds) {
          if (isMounted()) {
            setProgress({
              done: outcomes.length,
              total: workOrderIds.length,
              current: workOrderId,
            });
          }

          try {
            const result =
              intent === 'hold'
                ? await holdWorkOrder(workOrderId)
                : await releaseWorkOrder(workOrderId);
            const outcome = classifyResult(workOrderId, result);
            outcomes.push(outcome);

            // Pending is for labels that REACHED GitHub. A suppressed write is
            // waiting for no tick.
            if (outcome.kind === 'written' && isMounted()) {
              setPending((current) => ({ ...current, [workOrderId]: intent }));
            }
          } catch (cause) {
            // Caught per work order and never rethrown. The next one is still
            // attempted, because one refusal is a fact about that row and says
            // nothing about the seven behind it.
            outcomes.push({
              kind: 'refused',
              workOrderId,
              identity: workOrderId,
              failure: {
                status: cause instanceof ApiError ? cause.status : null,
                detail:
                  cause instanceof Error
                    ? cause.message
                    : 'The API gave no reason for the refusal.',
              },
            });
          }
        }
      } finally {
        if (isMounted()) setProgress(null);
      }

      // Once for the run rather than once per request: the queue is polled
      // anyway, and refetching between every label would spend reads to show
      // a tick that has not run yet.
      onWritten?.();

      return outcomes;
    },
    [isMounted, onWritten],
  );

  const settle = useCallback((workOrderId: string) => {
    setPending((current) => {
      if (!(workOrderId in current)) return current;
      const next = { ...current };
      delete next[workOrderId];
      return next;
    });
  }, []);

  return { pending, error, steer, steerMany, progress, settle };
}
