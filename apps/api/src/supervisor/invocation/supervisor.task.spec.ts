import { ConfigService } from '@nestjs/config';

import type { SupervisorService } from './supervisor.service';
import { SupervisorTask } from './supervisor.task';

function build(
  options: { enabled?: boolean; logSkips?: boolean; invoke?: jest.Mock } = {},
) {
  const invoke = options.invoke ?? jest.fn().mockResolvedValue('inv-1');
  const supervisor = {
    invoke,
    get enabled() {
      return options.enabled ?? true;
    },
  } as unknown as SupervisorService;

  const config = {
    get: jest.fn((key: string) =>
      key === 'supervisor.logSkippedInvocations'
        ? (options.logSkips ?? false)
        : undefined,
    ),
  } as unknown as ConfigService;

  return { task: new SupervisorTask(supervisor, config), invoke };
}

describe('SupervisorTask (#89)', () => {
  it('invokes the supervisor when it is enabled', async () => {
    const { task, invoke } = build({ enabled: true });

    await task.handleInvocation();

    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('does nothing at all when the supervisor was never configured', async () => {
    // A deployment with no supervisor should not accumulate a skip row an hour
    // forever, so the task returns before the service can write one.
    const { task, invoke } = build({ enabled: false, logSkips: false });

    await task.handleInvocation();

    expect(invoke).not.toHaveBeenCalled();
  });

  it('still records the skip when asked to', async () => {
    // When the supervisor is MEANT to be on and is not, the log must have no
    // gap — that is what logSkippedInvocations is for.
    const { task, invoke } = build({ enabled: false, logSkips: true });

    await task.handleInvocation();

    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('never lets a failure escape into the scheduler', async () => {
    // A task that threw would take the scheduler's other work with it —
    // including the run-summary sweep — for a diagnosis nobody was waiting on.
    const { task } = build({
      invoke: jest.fn().mockRejectedValue(new Error('unexpected')),
    });

    await expect(task.handleInvocation()).resolves.toBeUndefined();
  });

  it('is invoked on a schedule, never per event', async () => {
    // The class exposes exactly one entry point and it carries @Cron. If a
    // second public method appears here, something is calling the supervisor
    // outside the schedule — which is what VISION §7 forbids.
    const methods = Object.getOwnPropertyNames(SupervisorTask.prototype).filter(
      (name) =>
        name !== 'constructor' &&
        // Getters are configuration reads, not entry points.
        typeof Object.getOwnPropertyDescriptor(SupervisorTask.prototype, name)
          ?.value === 'function',
    );

    expect(methods).toEqual(['handleInvocation']);
  });
});
