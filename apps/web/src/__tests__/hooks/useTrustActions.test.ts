import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  useClassDemotion,
  useGrantRevocation,
} from '../../hooks/useTrustActions';
import * as api from '../../services/api';
import { ApiError } from '../../services/api';
import type { ManualDemotionResult, TrustGrantDetail } from '../../types/trust';

/**
 * The outcomes of the two acts a cockpit can perform on trust (#101).
 *
 * The distinction each union preserves is the same one `useApprovalDecision`
 * preserves: WHETHER ANYTHING CHANGED. A hook that collapsed these into
 * `error: string` would leave the operator inferring from a status code
 * whether the thing they tried to stop actually stopped.
 */

const ended = { id: 'g-1', status: 'revoked' } as TrustGrantDetail;

const demoted: ManualDemotionResult = {
  state: {
    actionClass: 'runner-restart',
    actionClassTitle: 'Runner restart',
    rung: 'measure',
  } as ManualDemotionResult['state'],
  grantsSuspended: 2,
  notified: true,
  manualHoldUntil: '2026-09-06T10:00:00.000Z',
  rungMayBeRestoredByLadder: true,
};

function apiError(status: number, details?: unknown, message = 'refused') {
  return new ApiError(message, status, 'CODE', details);
}

describe('useGrantRevocation', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('reports the ended grant and refetches', async () => {
    const revoke = vi.spyOn(api, 'revokeTrustGrant').mockResolvedValue(ended);
    const onSettled = vi.fn();
    const { result } = renderHook(() => useGrantRevocation(onSettled));

    await act(async () => {
      await result.current.revoke('g-1', 'because');
    });

    expect(revoke).toHaveBeenCalledWith('g-1', 'because');
    expect(result.current.outcome).toEqual({ kind: 'revoked', grant: ended });
    expect(result.current.isRevoking).toBe(false);
    expect(result.current.revokingId).toBeNull();
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('treats a 409 as "already ended" and still refetches', async () => {
    // The grant IS over, just not by this tap — so the screen is out of date
    // and must stop offering a button for something already finished.
    vi.spyOn(api, 'revokeTrustGrant').mockRejectedValue(
      apiError(409, { reason: 'already-ended', status: 'suspended' }),
    );
    const onSettled = vi.fn();
    const { result } = renderHook(() => useGrantRevocation(onSettled));

    await act(async () => {
      await result.current.revoke('g-1');
    });

    expect(result.current.outcome?.kind).toBe('already-ended');
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('does NOT refetch after a 403, because nothing moved', async () => {
    vi.spyOn(api, 'revokeTrustGrant').mockRejectedValue(apiError(403));
    const onSettled = vi.fn();
    const { result } = renderHook(() => useGrantRevocation(onSettled));

    await act(async () => {
      await result.current.revoke('g-1');
    });

    expect(result.current.outcome?.kind).toBe('forbidden');
    expect(onSettled).not.toHaveBeenCalled();
  });

  it('distinguishes a missing grant from a failed request', async () => {
    vi.spyOn(api, 'revokeTrustGrant').mockRejectedValue(apiError(404));
    const { result } = renderHook(() => useGrantRevocation());
    await act(async () => {
      await result.current.revoke('g-1');
    });
    expect(result.current.outcome?.kind).toBe('gone');

    vi.spyOn(api, 'revokeTrustGrant').mockRejectedValue(apiError(500));
    await act(async () => {
      await result.current.revoke('g-1');
    });
    expect(result.current.outcome?.kind).toBe('failed');
  });

  it('reports a non-ApiError rejection rather than swallowing it', async () => {
    // A network failure is not an `ApiError`, and a hook that only branched on
    // status codes would report nothing at all.
    vi.spyOn(api, 'revokeTrustGrant').mockRejectedValue(
      new Error('NetworkError'),
    );
    const { result } = renderHook(() => useGrantRevocation());

    await act(async () => {
      await result.current.revoke('g-1');
    });

    expect(result.current.outcome).toEqual({
      kind: 'failed',
      message: 'NetworkError',
    });
  });

  it('does not treat a 409 with another reason as "already ended"', async () => {
    // The discriminator travels in `details.reason`, never in the status —
    // `HttpExceptionFilter` overwrites the envelope's `code` from the status,
    // so a status-only branch would mislabel any future 409.
    vi.spyOn(api, 'revokeTrustGrant').mockRejectedValue(
      apiError(409, { reason: 'something-else' }),
    );
    const { result } = renderHook(() => useGrantRevocation());

    await act(async () => {
      await result.current.revoke('g-1');
    });

    expect(result.current.outcome?.kind).toBe('failed');
  });

  it('clears the banner on reset', async () => {
    vi.spyOn(api, 'revokeTrustGrant').mockResolvedValue(ended);
    const { result } = renderHook(() => useGrantRevocation());

    await act(async () => {
      await result.current.revoke('g-1');
    });
    expect(result.current.outcome).not.toBeNull();

    act(() => result.current.reset());
    expect(result.current.outcome).toBeNull();
  });
});

describe('useClassDemotion', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('carries the whole result through, hold and ladder caveat included', async () => {
    // `manualHoldUntil` and `rungMayBeRestoredByLadder` must both reach the
    // component untouched: the first is the TERM of the operator's decision
    // and the second reports the hold failing, and a hook that reduced the
    // result to a boolean would drop both.
    const demote = vi
      .spyOn(api, 'demoteActionClass')
      .mockResolvedValue(demoted);
    const onSettled = vi.fn();
    const { result } = renderHook(() => useClassDemotion(onSettled));

    await act(async () => {
      await result.current.demote('runner-restart', 'misfiring');
    });

    expect(demote).toHaveBeenCalledWith('runner-restart', 'misfiring');
    expect(result.current.outcome).toEqual({
      kind: 'demoted',
      result: demoted,
    });
    expect(result.current.demotingClass).toBeNull();
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('treats a 409 "not-promoted" as its own outcome', async () => {
    vi.spyOn(api, 'demoteActionClass').mockRejectedValue(
      apiError(409, { reason: 'not-promoted' }),
    );
    const onSettled = vi.fn();
    const { result } = renderHook(() => useClassDemotion(onSettled));

    await act(async () => {
      await result.current.demote('runner-restart');
    });

    expect(result.current.outcome?.kind).toBe('not-promoted');
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('separates a refusal from a failure, and does not refetch on a refusal', async () => {
    vi.spyOn(api, 'demoteActionClass').mockRejectedValue(apiError(403));
    const onSettled = vi.fn();
    const { result } = renderHook(() => useClassDemotion(onSettled));

    await act(async () => {
      await result.current.demote('runner-restart');
    });

    expect(result.current.outcome?.kind).toBe('forbidden');
    expect(onSettled).not.toHaveBeenCalled();

    vi.spyOn(api, 'demoteActionClass').mockRejectedValue(apiError(500));
    await act(async () => {
      await result.current.demote('runner-restart');
    });
    expect(result.current.outcome?.kind).toBe('failed');
  });

  it('reports a non-ApiError rejection', async () => {
    vi.spyOn(api, 'demoteActionClass').mockRejectedValue('offline');
    const { result } = renderHook(() => useClassDemotion());

    await act(async () => {
      await result.current.demote('runner-restart');
    });

    expect(result.current.outcome).toEqual({
      kind: 'failed',
      message: 'offline',
    });
  });

  it('clears the banner on reset', async () => {
    vi.spyOn(api, 'demoteActionClass').mockResolvedValue(demoted);
    const { result } = renderHook(() => useClassDemotion());

    await act(async () => {
      await result.current.demote('runner-restart');
    });
    act(() => result.current.reset());

    expect(result.current.outcome).toBeNull();
  });
});
