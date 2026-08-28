import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useQueueSteering } from '../../hooks/useQueueSteering';
import type { SteerOutcome } from '../../config/queueSteering';
import * as api from '../../services/api';
import { ApiError } from '../../services/api';

/**
 * The pending-until-next-tick contract (#85).
 *
 * #85 is explicit that an action here "takes effect on the next tick, not
 * instantly. The UI must show that honestly — a pending-until-next-tick state —
 * rather than optimistically rendering success and then flickering back."
 */

describe('useQueueSteering', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const written = {
    workOrderId: 'wo-1',
    identity: 'wo_opifex_312_a3f91c2_a1',
    label: 'factory:hold',
    labelWritten: true,
    reconciled: false,
    effect: 'next tick',
  };

  it('marks a steered work order pending, never held', async () => {
    vi.spyOn(api, 'holdWorkOrder').mockResolvedValue(written);
    const { result } = renderHook(() => useQueueSteering());

    await act(async () => {
      await result.current.steer('wo-1', 'hold');
    });

    // The row will render "hold requested — next tick". It does NOT claim the
    // work order is held: the reconciler has not run.
    expect(result.current.pending['wo-1']).toBe('hold');
  });

  it('does not go pending when the label never reached GitHub', async () => {
    // With writes disabled the endpoint reports labelWritten: false. A pending
    // badge for a request that never left the building is the same optimistic
    // lie in a different place.
    vi.spyOn(api, 'holdWorkOrder').mockResolvedValue({
      ...written,
      labelWritten: false,
    });
    const { result } = renderHook(() => useQueueSteering());

    await act(async () => {
      await result.current.steer('wo-1', 'hold');
    });

    expect(result.current.pending['wo-1']).toBeUndefined();
    expect(result.current.error).toContain('writes are disabled');
  });

  it('surfaces a failed steer rather than swallowing it', async () => {
    vi.spyOn(api, 'releaseWorkOrder').mockRejectedValue(
      new Error('403 Forbidden'),
    );
    const { result } = renderHook(() => useQueueSteering());

    await act(async () => {
      await result.current.steer('wo-1', 'release');
    });

    await waitFor(() => expect(result.current.error).toContain('403'));
    expect(result.current.pending['wo-1']).toBeUndefined();
  });

  it('settles only when told to, which is when the server agrees', async () => {
    vi.spyOn(api, 'holdWorkOrder').mockResolvedValue(written);
    const { result } = renderHook(() => useQueueSteering());

    await act(async () => {
      await result.current.steer('wo-1', 'hold');
    });
    expect(result.current.pending['wo-1']).toBe('hold');

    act(() => result.current.settle('wo-1'));
    expect(result.current.pending['wo-1']).toBeUndefined();
  });

  describe('steerMany (#421)', () => {
    it('issues one request per work order, in order, and never rejects', async () => {
      const hold = vi
        .spyOn(api, 'holdWorkOrder')
        .mockResolvedValueOnce({ ...written, identity: 'wo_a' })
        // The middle one is refused. The loop must run to the end: what comes
        // back cannot depend on the order the rows happened to be in.
        .mockRejectedValueOnce(new ApiError('Work order not found', 404))
        .mockResolvedValueOnce({ ...written, identity: 'wo_c' });
      const { result } = renderHook(() => useQueueSteering());

      let outcomes: SteerOutcome[] = [];
      await act(async () => {
        outcomes = await result.current.steerMany(
          ['wo-a', 'wo-b', 'wo-c'],
          'hold',
        );
      });

      expect(hold.mock.calls.map(([id]) => id)).toEqual([
        'wo-a',
        'wo-b',
        'wo-c',
      ]);
      expect(outcomes.map((outcome) => outcome.kind)).toEqual([
        'written',
        'refused',
        'written',
      ]);
      // Keyed on what was SENT, so the selection can act on the answer.
      expect(outcomes.map((outcome) => outcome.workOrderId)).toEqual([
        'wo-a',
        'wo-b',
        'wo-c',
      ]);
    });

    it('carries the API status through so the refusal can be told apart', async () => {
      vi.spyOn(api, 'releaseWorkOrder').mockRejectedValue(
        new ApiError('Forbidden', 403),
      );
      const { result } = renderHook(() => useQueueSteering());

      let outcomes: SteerOutcome[] = [];
      await act(async () => {
        outcomes = await result.current.steerMany(['wo-a'], 'release');
      });

      expect(outcomes[0]).toMatchObject({
        kind: 'refused',
        failure: { status: 403, detail: 'Forbidden' },
      });
    });

    it('marks only the written ones pending, never the suppressed ones', async () => {
      vi.spyOn(api, 'holdWorkOrder')
        .mockResolvedValueOnce(written)
        // Writes disabled: the same 202 as any other answer, and no label
        // written. A pending badge here would claim a tick is coming for a
        // request that never left the building.
        .mockResolvedValueOnce({ ...written, labelWritten: false });
      const { result } = renderHook(() => useQueueSteering());

      await act(async () => {
        await result.current.steerMany(['wo-a', 'wo-b'], 'hold');
      });

      expect(result.current.pending['wo-a']).toBe('hold');
      expect(result.current.pending['wo-b']).toBeUndefined();
    });

    it('leaves no progress behind once the run has finished', async () => {
      vi.spyOn(api, 'holdWorkOrder').mockResolvedValue(written);
      const { result } = renderHook(() => useQueueSteering());

      await act(async () => {
        await result.current.steerMany(['wo-a', 'wo-b'], 'hold');
      });

      expect(result.current.progress).toBeNull();
    });

    it('refreshes the queue once for the run, not once per label', async () => {
      vi.spyOn(api, 'holdWorkOrder').mockResolvedValue(written);
      const onWritten = vi.fn();
      const { result } = renderHook(() => useQueueSteering(onWritten));

      await act(async () => {
        await result.current.steerMany(['wo-a', 'wo-b', 'wo-c'], 'hold');
      });

      expect(onWritten).toHaveBeenCalledTimes(1);
    });
  });

  it('refreshes the queue after a write, so the tick is noticed promptly', async () => {
    vi.spyOn(api, 'holdWorkOrder').mockResolvedValue(written);
    const onWritten = vi.fn();
    const { result } = renderHook(() => useQueueSteering(onWritten));

    await act(async () => {
      await result.current.steer('wo-1', 'hold');
    });

    expect(onWritten).toHaveBeenCalled();
  });
});
