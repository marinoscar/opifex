import { Logger } from '@nestjs/common';

import type { ApprovalGateService } from './approval-gate.service';
import { ApprovalGateTask } from './approval-gate.task';
import type {
  BackfillParkedResult,
  SweepTimeoutsResult,
} from './approval.types';

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

function backfillResult(
  overrides: Partial<BackfillParkedResult> = {},
): BackfillParkedResult {
  return {
    examined: 0,
    raised: 0,
    linked: 0,
    raced: 0,
    failed: 0,
    abandoned: 0,
    ...overrides,
  };
}

function build(sweep: jest.Mock, backfill: jest.Mock = jest.fn()) {
  const gate = {
    sweepTimeouts: sweep,
    backfillParkedEscalations: backfill,
  } as unknown as ApprovalGateService;
  return new ApprovalGateTask(gate);
}

describe('ApprovalGateTask', () => {
  let errors: jest.SpyInstance;
  let warnings: jest.SpyInstance;

  beforeEach(() => {
    errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    warnings = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => {});
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

  describe('handleParkedEscalations (#237)', () => {
    function task(backfill: jest.Mock) {
      return build(jest.fn().mockResolvedValue(sweepResult()), backfill);
    }

    it('drives the backfill on each tick', async () => {
      const backfill = jest.fn().mockResolvedValue(backfillResult());

      await task(backfill).handleParkedEscalations();

      expect(backfill).toHaveBeenCalledTimes(1);
      expect(errors).not.toHaveBeenCalled();
      expect(warnings).not.toHaveBeenCalled();
    });

    /**
     * The timeout sweep resolves requests against a deadline it ANNOUNCED. A
     * database blip in the backfill must not stop it, which is why the two are
     * separate methods rather than one tick doing both.
     */
    it('does not touch the timeout sweep when it fails', async () => {
      const sweep = jest.fn().mockResolvedValue(sweepResult());
      const backfill = jest.fn().mockRejectedValue(new Error('database down'));
      const subject = build(sweep, backfill);

      await expect(subject.handleParkedEscalations()).resolves.toBeUndefined();
      await expect(subject.handleTimeouts()).resolves.toBeUndefined();

      expect(sweep).toHaveBeenCalledTimes(1);
      expect(errors).toHaveBeenCalledWith(
        expect.stringContaining('database down'),
      );
    });

    it('never throws when the backfill rejects with a non-Error', async () => {
      const backfill = jest.fn().mockRejectedValue('a string, somehow');

      await expect(
        task(backfill).handleParkedEscalations(),
      ).resolves.toBeUndefined();

      expect(errors).toHaveBeenCalledWith(
        expect.stringContaining('a string, somehow'),
      );
    });

    /**
     * A repair means something failed earlier that nothing else reported as it
     * happened, so a silent successful backfill would hide the outage that
     * made it necessary.
     */
    it('warns when it repaired something', async () => {
      const backfill = jest
        .fn()
        .mockResolvedValue(
          backfillResult({ examined: 3, raised: 2, linked: 1 }),
        );

      await task(backfill).handleParkedEscalations();

      expect(warnings).toHaveBeenCalledWith(
        expect.stringContaining('repaired 3 request(s)'),
      );
    });

    it('reports a retry that failed again', async () => {
      const backfill = jest
        .fn()
        .mockResolvedValue(backfillResult({ examined: 1, failed: 1 }));

      await task(backfill).handleParkedEscalations();

      expect(errors).toHaveBeenCalledWith(
        expect.stringContaining('still have no escalation'),
      );
    });

    /**
     * The honest terminal state, #136's shape: nothing more will be attempted,
     * and the system says so out loud rather than falling quiet and looking
     * healthy. The marker is what an infrastructure alert matches on.
     */
    it('is loud about a request past the retry bound', async () => {
      const backfill = jest
        .fn()
        .mockResolvedValue(backfillResult({ abandoned: 2 }));

      await task(backfill).handleParkedEscalations();

      expect(errors).toHaveBeenCalledWith(
        expect.stringContaining('PARKED APPROVAL NEVER ESCALATED'),
      );
      expect(errors).toHaveBeenCalledWith(expect.stringContaining('24h'));
    });

    it('is quiet when there is nothing to repair', async () => {
      const backfill = jest
        .fn()
        .mockResolvedValue(backfillResult({ raced: 1 }));

      await task(backfill).handleParkedEscalations();

      expect(errors).not.toHaveBeenCalled();
      expect(warnings).not.toHaveBeenCalled();
    });
  });
});
