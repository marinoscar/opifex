import { Logger } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';

import {
  REGISTRATION_INTERVAL_MS,
  RunnerRegistrationService,
  type RegistrationSweep,
} from './runner-registration.service';
import { RunnerRegistrationTask } from './runner-registration.task';

describe('RunnerRegistrationTask', () => {
  const CONVERGED: RegistrationSweep = {
    registered: 1,
    transient: 0,
    permanent: 0,
  };

  let addInterval: jest.Mock;
  let deleteInterval: jest.Mock;
  let doesExist: jest.Mock;
  let registerAll: jest.Mock;
  let intervals: NodeJS.Timeout[];

  function build(): RunnerRegistrationTask {
    const scheduler = {
      addInterval,
      deleteInterval,
      doesExist,
    } as unknown as SchedulerRegistry;
    const registration = {
      registerAll,
    } as unknown as RunnerRegistrationService;

    return new RunnerRegistrationTask(scheduler, registration);
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
    registerAll = jest.fn().mockResolvedValue(CONVERGED);
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
  });

  afterEach(() => {
    for (const handle of intervals) clearInterval(handle);
    jest.restoreAllMocks();
  });

  it('registers its interval unconditionally', () => {
    // The one thing that distinguishes this task from `RunPollerTask` and
    // `ReconcilerTask`, both of which register nothing when their flag is off.
    // Registration must converge on a deployment where dispatch is disabled:
    // an empty fleet table is exactly the state an operator has to see
    // resolved BEFORE they are willing to turn dispatch on, and a registration
    // loop gated on the flag it exists to record would be circular.
    build().onModuleInit();

    expect(addInterval).toHaveBeenCalledTimes(1);
    const [name, handle] = addInterval.mock.calls[0];
    expect(name).toBe('runner-registration-tick');
    expect(handle).toBeDefined();
  });

  it('does not register a second time at boot', async () => {
    // `RunnerRegistrationService.onModuleInit` already registers at boot. A
    // second call here would mean two upserts racing on the first tick of
    // every process, for no gain.
    build().onModuleInit();

    expect(registerAll).not.toHaveBeenCalled();
  });

  it('clears its interval on shutdown', () => {
    const task = build();
    task.onModuleInit();
    task.onModuleDestroy();

    expect(deleteInterval).toHaveBeenCalledWith('runner-registration-tick');
  });

  it('does not try to clear an interval that is not there', () => {
    doesExist.mockReturnValue(false);
    const task = build();

    expect(() => task.onModuleDestroy()).not.toThrow();
    expect(deleteInterval).not.toHaveBeenCalled();
  });

  it('swallows a throw rather than taking the process down', async () => {
    // An unhandled rejection from a setInterval callback has no caller to
    // propagate to, and Node's default policy is to exit. Crashing the process
    // would be a poor way to fix a bug about the control plane going quietly
    // dead.
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    registerAll.mockRejectedValue(new Error('tick exploded'));

    await expect(build().runOnce()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('says nothing about a pass that converged', async () => {
    // The service reports what changed, and only when it changed. A summary
    // line here would put a line a minute back in the log, which is the cost
    // that suppression exists to avoid.
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();

    await build().runOnce();

    expect(registerAll).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
  });

  it('ticks on the interval the service publishes', () => {
    // Pinned so the task and the service cannot drift on how long a fleet
    // table can stay empty.
    build().onModuleInit();

    expect(REGISTRATION_INTERVAL_MS).toBe(60_000);
  });
});
