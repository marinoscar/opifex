import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useQueueSteering } from '../../hooks/useQueueSteering';
import * as api from '../../services/api';

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
