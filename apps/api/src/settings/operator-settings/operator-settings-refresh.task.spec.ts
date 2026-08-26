import { Logger } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';

import { OperatorSettingsRefreshTask } from './operator-settings-refresh.task';
import {
  OPERATOR_SETTINGS_REFRESH_INTERVAL_MS,
  OperatorSettingsService,
} from './operator-settings.service';

describe('OperatorSettingsRefreshTask', () => {
  let addInterval: jest.Mock;
  let deleteInterval: jest.Mock;
  let doesExist: jest.Mock;
  let refresh: jest.Mock;
  let intervals: NodeJS.Timeout[];

  function build(): OperatorSettingsRefreshTask {
    const scheduler = {
      addInterval,
      deleteInterval,
      doesExist,
    } as unknown as SchedulerRegistry;
    const settings = { refresh } as unknown as OperatorSettingsService;

    return new OperatorSettingsRefreshTask(scheduler, settings);
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
    refresh = jest.fn().mockResolvedValue({ status: 'loaded' });
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    for (const handle of intervals) clearInterval(handle);
    jest.restoreAllMocks();
  });

  it('registers the interval unconditionally, at the declared period', () => {
    // Unconditional because this is the loop that recovers the state in which
    // nothing is known — including whatever flag someone might be tempted to
    // gate it with. ADR-0018 §5 makes the general version of the argument.
    build().onModuleInit();

    expect(addInterval).toHaveBeenCalledTimes(1);
    expect(addInterval.mock.calls[0]?.[0]).toBe('operator-settings-refresh');
    expect(OPERATOR_SETTINGS_REFRESH_INTERVAL_MS).toBe(15_000);
  });

  it('does not refresh at registration time', () => {
    // `OperatorSettingsService.onModuleInit` performs the first load, so that
    // a consumer reading a managed key in its OWN `onModuleInit` sees the
    // overlay. A second load here would be two queries racing on the first
    // tick of every process.
    build().onModuleInit();

    expect(refresh).not.toHaveBeenCalled();
  });

  it('refreshes when the interval fires', async () => {
    jest.useFakeTimers();
    try {
      build().onModuleInit();

      jest.advanceTimersByTime(OPERATOR_SETTINGS_REFRESH_INTERVAL_MS);
      await Promise.resolve();

      expect(refresh).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(OPERATOR_SETTINGS_REFRESH_INTERVAL_MS * 3);
      await Promise.resolve();

      expect(refresh).toHaveBeenCalledTimes(4);
    } finally {
      jest.useRealTimers();
    }
  });

  it('swallows a throw rather than taking the process down', async () => {
    // `refresh()` is written not to throw; this catches anyway. An unhandled
    // rejection from a `setInterval` callback has no caller to propagate to
    // and kills the process under Node's default policy — a dead factory
    // would be a poor way to fix a stale settings value.
    const error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    refresh.mockRejectedValue(new Error('overlay exploded'));

    await expect(build().runOnce()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('says nothing on a successful pass', async () => {
    // Four lines an hour saying nothing happened is how a real warning becomes
    // invisible. The service already reports when the overlay went away and
    // when it came back, and only when it CHANGED.
    const log = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    const task = build();
    log.mockClear();

    await task.runOnce();

    expect(log).not.toHaveBeenCalled();
  });

  it('removes the interval on shutdown', () => {
    const task = build();
    task.onModuleInit();

    task.onModuleDestroy();

    expect(deleteInterval).toHaveBeenCalledWith('operator-settings-refresh');
  });

  it('does not remove an interval that was never registered', () => {
    doesExist.mockReturnValue(false);

    build().onModuleDestroy();

    expect(deleteInterval).not.toHaveBeenCalled();
  });
});
