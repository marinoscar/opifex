import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';

import { POLL_INTERVAL_MS, RunPollerService, type PollTickResult } from './run-poller.service';
import { RunPollerTask } from './run-poller.task';

describe('RunPollerTask', () => {
  const QUIET: PollTickResult = {
    polled: 0,
    eventsIngested: 0,
    duplicates: 0,
    lost: 0,
    failed: 0,
    timedOut: 0,
  };

  let addInterval: jest.Mock;
  let deleteInterval: jest.Mock;
  let doesExist: jest.Mock;
  let tick: jest.Mock;
  let intervals: NodeJS.Timeout[];

  function build(enabled: boolean): RunPollerTask {
    const config = {
      get: (key: string) =>
        key === 'runners.claudeCodeLocal.enabled' ? enabled : undefined,
    } as unknown as ConfigService;

    const scheduler = { addInterval, deleteInterval, doesExist } as unknown as SchedulerRegistry;
    const poller = { tick } as unknown as RunPollerService;

    return new RunPollerTask(config, scheduler, poller);
  }

  beforeEach(() => {
    intervals = [];
    addInterval = jest.fn((_name: string, handle: NodeJS.Timeout) => {
      // Captured so the suite can clear them; an un-cleared interval keeps
      // Jest's event loop alive and turns a passing run into a hang.
      intervals.push(handle);
    });
    deleteInterval = jest.fn();
    doesExist = jest.fn().mockReturnValue(true);
    tick = jest.fn().mockResolvedValue(QUIET);
  });

  afterEach(() => {
    for (const handle of intervals) clearInterval(handle);
  });

  describe('registration', () => {
    it('registers no interval at all when no runner is enabled', () => {
      // Not an interval that wakes to decide it is disabled. A disabled loop
      // that still appears in every profile invites the question of whether it
      // is really off — the same argument the reconciler makes.
      build(false).onModuleInit();

      expect(addInterval).not.toHaveBeenCalled();
    });

    it('registers at the interval the watchdog can live with', () => {
      build(true).onModuleInit();

      expect(addInterval).toHaveBeenCalledTimes(1);
      const [name] = addInterval.mock.calls[0];
      expect(name).toBe('run-poller-tick');
    });

    it('clears its interval on shutdown', () => {
      const task = build(true);
      task.onModuleInit();
      task.onModuleDestroy();

      expect(deleteInterval).toHaveBeenCalledWith('run-poller-tick');
    });

    it('does not try to clear an interval it never registered', () => {
      doesExist.mockReturnValue(false);
      const task = build(false);
      task.onModuleInit();

      expect(() => task.onModuleDestroy()).not.toThrow();
      expect(deleteInterval).not.toHaveBeenCalled();
    });
  });

  describe('the tick', () => {
    it('swallows a throw rather than taking the process down', async () => {
      // An unhandled rejection from a setInterval callback has no caller to
      // propagate to, and Node's default policy is to exit. A dead process is
      // a dead factory — the exact silent failure this system exists to catch.
      tick.mockRejectedValue(new Error('tick exploded'));

      await expect(build(true).runOnce()).resolves.toBeUndefined();
    });

    it('says nothing when nothing happened', async () => {
      // A log line every fifteen seconds saying nothing happened is how a log
      // stops being read, and this one competes for attention with the
      // escalations that matter. Asserted against the logger, because that is
      // the thing whose silence is the requirement.
      const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
      try {
        await build(true).runOnce();
        expect(log).not.toHaveBeenCalled();
      } finally {
        log.mockRestore();
      }
    });

    it('reports a tick that carried events', async () => {
      const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
      try {
        tick.mockResolvedValue({ ...QUIET, polled: 2, eventsIngested: 7 });
        await build(true).runOnce();

        expect(log).toHaveBeenCalledTimes(1);
        expect(log.mock.calls[0][0]).toContain('7 event(s) ingested');
      } finally {
        log.mockRestore();
      }
    });

    it.each([
      ['a lost run', { lost: 1 }],
      ['a failure', { failed: 1 }],
    ])('reports %s even with no events', async (_label, overrides) => {
      // Both are things an operator needs to see, and both can happen on a
      // tick that ingested nothing at all.
      const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
      try {
        tick.mockResolvedValue({ ...QUIET, ...overrides });
        await build(true).runOnce();

        expect(log).toHaveBeenCalledTimes(1);
      } finally {
        log.mockRestore();
      }
    });
  });

  it('polls often enough to keep the watchdog honest', () => {
    // Pinned here as well as in the service spec because this is the file that
    // decides how often the interval actually fires.
    expect(POLL_INTERVAL_MS).toBeLessThan(60_000);
  });
});
