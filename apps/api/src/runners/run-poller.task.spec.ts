import { Logger } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';

import {
  makeOperatorSettings,
  type FakeOperatorSettingsService,
} from '../settings/operator-settings/operator-settings.test-double';
import {
  POLL_INTERVAL_MS,
  RunPollerService,
  type PollTickResult,
} from './run-poller.service';
import { RunPollerTask } from './run-poller.task';

describe('RunPollerTask', () => {
  const QUIET: PollTickResult = {
    polled: 0,
    eventsIngested: 0,
    duplicates: 0,
    lost: 0,
    failed: 0,
    timedOut: 0,
    overBudget: 0,
    quotaWindows: 0,
  };

  let addInterval: jest.Mock;
  let deleteInterval: jest.Mock;
  let doesExist: jest.Mock;
  let tick: jest.Mock;
  /**
   * What the registry currently holds, keyed by name.
   *
   * A real map rather than bare spies, for two reasons #343 makes load
   * bearing: `SchedulerRegistry.addInterval` THROWS on a duplicate name, so a
   * spy that silently accepted two would let a double registration pass, and
   * an interval left running keeps Jest's event loop alive and turns a passing
   * run into a hang.
   */
  let registered: Map<string, NodeJS.Timeout>;
  let settings: FakeOperatorSettingsService;

  function build(enabled: boolean): RunPollerTask {
    settings = makeOperatorSettings({
      overrides: { 'runners.claudeCodeLocal.enabled': enabled },
    });

    const scheduler = {
      addInterval,
      deleteInterval,
      doesExist,
    } as unknown as SchedulerRegistry;
    const poller = { tick } as unknown as RunPollerService;

    return new RunPollerTask(settings, scheduler, poller);
  }

  beforeEach(() => {
    registered = new Map();
    addInterval = jest.fn((name: string, handle: NodeJS.Timeout) => {
      if (registered.has(name)) {
        throw new Error(
          `Interval with the given name (${name}) already exists`,
        );
      }
      registered.set(name, handle);
    });
    deleteInterval = jest.fn((name: string) => {
      const handle = registered.get(name);
      if (!handle) throw new Error(`No interval was found with the given name`);
      clearInterval(handle);
      registered.delete(name);
    });
    doesExist = jest.fn((_type: string, name: string) => registered.has(name));
    tick = jest.fn().mockResolvedValue(QUIET);
  });

  afterEach(() => {
    for (const handle of registered.values()) clearInterval(handle);
    registered.clear();
    jest.useRealTimers();
  });

  describe('registration', () => {
    it('registers the interval even when no runner is enabled', () => {
      // #343. The old behaviour — no interval at all — made the interval's
      // existence a second copy of the enablement state, one `onModuleInit`
      // could never revise. For THIS loop that copy is dangerous rather than
      // merely stale: registration and dispatch admission both read the flag
      // lazily, so a runtime enable would start admitting work with no poller
      // to conclude it.
      build(false).onModuleInit();

      expect(addInterval).toHaveBeenCalledTimes(1);
      expect(addInterval.mock.calls[0][0]).toBe('run-poller-tick');
    });

    it('registers at the interval the watchdog can live with', () => {
      build(true).onModuleInit();

      expect(addInterval).toHaveBeenCalledTimes(1);
      const [name] = addInterval.mock.calls[0];
      expect(name).toBe('run-poller-tick');
    });

    it.each([
      [true, 'ENABLED'],
      [false, 'DISABLED'],
    ])(
      'states the enablement state in the boot line when enabled is %s',
      (enabled, expected) => {
        // The skip logs at `debug`, so this line is the ONLY place an operator
        // is told whether the loop that just registered will do anything. That
        // is what answers the superseded comment's objection without keeping a
        // second copy of the state.
        const log = jest
          .spyOn(Logger.prototype, 'log')
          .mockImplementation(() => {});
        try {
          build(enabled).onModuleInit();

          expect(log).toHaveBeenCalledTimes(1);
          expect(log.mock.calls[0][0]).toContain(expected);
        } finally {
          log.mockRestore();
        }
      },
    );

    it('clears its interval on shutdown', () => {
      const task = build(true);
      task.onModuleInit();
      task.onModuleDestroy();

      expect(deleteInterval).toHaveBeenCalledWith('run-poller-tick');
      expect(registered.size).toBe(0);
    });

    it('does not try to clear an interval it never registered', () => {
      const task = build(false);

      expect(() => task.onModuleDestroy()).not.toThrow();
      expect(deleteInterval).not.toHaveBeenCalled();
    });
  });

  describe('enabling a runner while the process is running', () => {
    it('polls within one interval of the flag being turned on', () => {
      // The acceptance criterion #343 exists for. Nothing is restarted here:
      // the task booted with the runner OFF, the interval was registered
      // anyway, and the flip is seen by the very next firing.
      jest.useFakeTimers();

      const task = build(false);
      task.onModuleInit();

      jest.advanceTimersByTime(POLL_INTERVAL_MS);
      expect(tick).not.toHaveBeenCalled();

      settings.setOverride('runners.claudeCodeLocal.enabled', true);

      jest.advanceTimersByTime(POLL_INTERVAL_MS);
      expect(tick).toHaveBeenCalledTimes(1);
    });

    it('stops polling again when the runner is turned back off', () => {
      // The read is per firing in both directions. A cached "we saw it turn
      // on" would keep polling a runner an operator has just disabled.
      jest.useFakeTimers();

      const task = build(true);
      task.onModuleInit();

      jest.advanceTimersByTime(POLL_INTERVAL_MS);
      expect(tick).toHaveBeenCalledTimes(1);

      settings.setOverride('runners.claudeCodeLocal.enabled', false);

      jest.advanceTimersByTime(POLL_INTERVAL_MS * 3);
      expect(tick).toHaveBeenCalledTimes(1);
    });
  });

  describe('the tick', () => {
    it('does nothing at all while no runner is enabled', async () => {
      await build(false).runOnce();

      expect(tick).not.toHaveBeenCalled();
    });

    it('logs the skip at debug, not at log', async () => {
      // A disabled deployment ticks four times a minute forever. At `log` that
      // is 5,760 INFO lines a day saying nothing happened, competing with the
      // escalations this log exists to carry — which is the cost the old
      // no-interval-at-all design was avoiding, and the one thing about it
      // worth keeping.
      const log = jest
        .spyOn(Logger.prototype, 'log')
        .mockImplementation(() => {});
      const debug = jest
        .spyOn(Logger.prototype, 'debug')
        .mockImplementation(() => {});
      try {
        await build(false).runOnce();

        expect(debug).toHaveBeenCalledTimes(1);
        expect(log).not.toHaveBeenCalled();
      } finally {
        log.mockRestore();
        debug.mockRestore();
      }
    });

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
      const log = jest
        .spyOn(Logger.prototype, 'log')
        .mockImplementation(() => {});
      try {
        await build(true).runOnce();
        expect(log).not.toHaveBeenCalled();
      } finally {
        log.mockRestore();
      }
    });

    it('reports a tick that carried events', async () => {
      const log = jest
        .spyOn(Logger.prototype, 'log')
        .mockImplementation(() => {});
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
      const log = jest
        .spyOn(Logger.prototype, 'log')
        .mockImplementation(() => {});
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
