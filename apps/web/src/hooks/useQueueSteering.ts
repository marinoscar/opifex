/**
 * Hold and release, with the next-tick delay made visible (#85).
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
 */

import { useCallback, useState } from 'react';
import { holdWorkOrder, releaseWorkOrder } from '../services/api';

export type SteerIntent = 'hold' | 'release';

export interface QueueSteeringState {
  /** Work-order ids whose label was written and whose tick has not landed. */
  pending: Record<string, SteerIntent>;
  /** Non-null after a failed steer, cleared on the next attempt. */
  error: string | null;
  steer: (workOrderId: string, intent: SteerIntent) => Promise<void>;
  /** Drop a work order from `pending` once the server agrees. */
  settle: (workOrderId: string) => void;
}

export function useQueueSteering(onWritten?: () => void): QueueSteeringState {
  const [pending, setPending] = useState<Record<string, SteerIntent>>({});
  const [error, setError] = useState<string | null>(null);

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

  const settle = useCallback((workOrderId: string) => {
    setPending((current) => {
      if (!(workOrderId in current)) return current;
      const next = { ...current };
      delete next[workOrderId];
      return next;
    });
  }, []);

  return { pending, error, steer, settle };
}
