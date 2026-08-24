import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useApprovalDecision } from '../../hooks/useApprovalDecision';
import * as api from '../../services/api';
import { ApiError } from '../../services/api';
import type { DecideApprovalResult } from '../../types/approvals';

/**
 * The four outcomes of a decision, and the one distinction that matters most:
 * WHETHER ANYTHING WAS RECORDED (#98).
 *
 * A hook that collapsed these into `error: string` would lose it, and the
 * operator would be left inferring from a status code whether their approval
 * went through.
 */

const recorded: DecideApprovalResult = {
  approval: {
    id: 'a1',
    status: 'approved',
  } as DecideApprovalResult['approval'],
  createdGrantId: null,
  grantSkippedReason: null,
  decidedAfterTimeout: false,
};

function apiError(status: number, details?: unknown, message = 'refused') {
  return new ApiError(message, status, 'CODE', details);
}

describe('useApprovalDecision', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('reports a recorded verdict and refetches the approval', async () => {
    vi.spyOn(api, 'decideApproval').mockResolvedValue(recorded);
    const onSettled = vi.fn();
    const { result } = renderHook(() => useApprovalDecision('a1', onSettled));

    await act(async () => {
      await result.current.decide({ decision: 'approve' });
    });

    expect(result.current.outcome).toEqual({
      kind: 'recorded',
      result: recorded,
    });
    expect(result.current.isDeciding).toBe(false);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('does NOT refetch after a 403, because nothing moved', async () => {
    vi.spyOn(api, 'decideApproval').mockRejectedValue(
      apiError(403, { reason: 'trust-grant-required', decisionApplied: false }),
    );
    const onSettled = vi.fn();
    const { result } = renderHook(() => useApprovalDecision('a1', onSettled));

    await act(async () => {
      await result.current.decide({
        decision: 'approve',
        alwaysApproveThisClass: true,
      });
    });

    expect(result.current.outcome?.kind).toBe('trust-grant-required');
    // A refetch would imply the row changed. It did not: the approval is still
    // open and still answerable without the flag.
    expect(onSettled).not.toHaveBeenCalled();
  });

  it('refetches after a 409, because the row IS resolved', async () => {
    vi.spyOn(api, 'decideApproval').mockRejectedValue(
      apiError(409, { reason: 'superseded' }),
    );
    const onSettled = vi.fn();
    const { result } = renderHook(() => useApprovalDecision('a1', onSettled));

    await act(async () => {
      await result.current.decide({ decision: 'deny' });
    });

    expect(result.current.outcome).toMatchObject({
      kind: 'conflict',
      reason: 'superseded',
    });
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('falls back to not-pending for a conflict reason it does not know', async () => {
    // Forward compatibility, and deliberately not a generic error: a 409 whose
    // reason this build has never heard of is still a 409, and the row is
    // still resolved.
    vi.spyOn(api, 'decideApproval').mockRejectedValue(
      apiError(409, { reason: 'something-new' }),
    );
    const { result } = renderHook(() => useApprovalDecision('a1'));

    await act(async () => {
      await result.current.decide({ decision: 'deny' });
    });

    expect(result.current.outcome).toMatchObject({
      kind: 'conflict',
      reason: 'not-pending',
    });
  });

  it('reports a 404 as gone rather than as a generic failure', async () => {
    vi.spyOn(api, 'decideApproval').mockRejectedValue(
      apiError(404, undefined, 'Approval request not found'),
    );
    const { result } = renderHook(() => useApprovalDecision('a1'));

    await act(async () => {
      await result.current.decide({ decision: 'approve' });
    });

    expect(result.current.outcome).toEqual({
      kind: 'gone',
      message: 'Approval request not found',
    });
  });

  it('reports a transport failure with its message', async () => {
    vi.spyOn(api, 'decideApproval').mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useApprovalDecision('a1'));

    await act(async () => {
      await result.current.decide({ decision: 'approve' });
    });

    expect(result.current.outcome).toEqual({
      kind: 'failed',
      message: 'offline',
    });
  });

  it('reports a 500 as a failure, not as a conflict', async () => {
    vi.spyOn(api, 'decideApproval').mockRejectedValue(
      apiError(500, {}, 'boom'),
    );
    const { result } = renderHook(() => useApprovalDecision('a1'));

    await act(async () => {
      await result.current.decide({ decision: 'approve' });
    });

    expect(result.current.outcome).toEqual({ kind: 'failed', message: 'boom' });
  });

  it('clears the banner on reset', async () => {
    vi.spyOn(api, 'decideApproval').mockResolvedValue(recorded);
    const { result } = renderHook(() => useApprovalDecision('a1'));

    await act(async () => {
      await result.current.decide({ decision: 'approve' });
    });
    act(() => result.current.reset());

    expect(result.current.outcome).toBeNull();
  });
});
