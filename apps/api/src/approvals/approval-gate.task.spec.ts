import { Logger } from '@nestjs/common';

import type { ApprovalGateService } from './approval-gate.service';
import { ApprovalGateTask } from './approval-gate.task';
import type { SweepTimeoutsResult } from './approval.types';

function sweepResult(
  overrides: Partial<SweepTimeoutsResult> = {},
): SweepTimeoutsResult {
  return {
    examined: 0,
    autoApproved: 0,
    autoDenied: 0,
    skippedParked: 0,
    raced: 0,
    ...overrides,
  };
}

function build(sweep: jest.Mock) {
  const gate = { sweepTimeouts: sweep } as unknown as ApprovalGateService;
  return new ApprovalGateTask(gate);
}

describe('ApprovalGateTask', () => {
  let errors: jest.SpyInstance;

  beforeEach(() => {
    errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('drives the sweep on each tick', async () => {
    const sweep = jest.fn().mockResolvedValue(sweepResult({ autoDenied: 3 }));

    await build(sweep).handleTimeouts();

    expect(sweep).toHaveBeenCalledTimes(1);
    expect(errors).not.toHaveBeenCalled();
  });

  /**
   * The property that matters most about a scheduled task in this codebase.
   *
   * A throw here would take the scheduler's other work with it — the
   * reconciler tick, the merge-state pass, the run-summary sweep — for the
   * sake of one batch of approvals the next tick will pick up anyway.
   * `SupervisorTask` makes the same argument about itself.
   */
  it('never throws when the sweep fails', async () => {
    const sweep = jest.fn().mockRejectedValue(new Error('database is down'));

    await expect(build(sweep).handleTimeouts()).resolves.toBeUndefined();

    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining('database is down'),
    );
  });

  it('never throws when the sweep rejects with a non-Error', async () => {
    const sweep = jest.fn().mockRejectedValue('a string, somehow');

    await expect(build(sweep).handleTimeouts()).resolves.toBeUndefined();

    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining('a string, somehow'),
    );
  });

  /**
   * `skippedParked` is structurally impossible — a parked request has no
   * `timeoutAt` for the query to match — so a non-zero value means the
   * never-auto-approve invariant has been broken somewhere else. It must be
   * loud rather than buried, since the sweep itself leaves such rows alone and
   * would otherwise report a quiet, successful tick.
   */
  it('reports loudly if a parked request was ever selected', async () => {
    const sweep = jest
      .fn()
      .mockResolvedValue(sweepResult({ examined: 1, skippedParked: 1 }));

    await build(sweep).handleTimeouts();

    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining('should be impossible'),
    );
  });

  it('is quiet on an ordinary empty tick', async () => {
    const sweep = jest.fn().mockResolvedValue(sweepResult());

    await build(sweep).handleTimeouts();

    expect(errors).not.toHaveBeenCalled();
  });
});
