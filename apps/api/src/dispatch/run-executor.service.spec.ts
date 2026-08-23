import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../prisma/prisma.service';
import {
  ClaudeCodeLocalRunner,
  RunnerAtCapacityError,
} from '../runners/claude-code-local/claude-code-local.runner';
import { RunPollerService } from '../runners/run-poller.service';
import type { RunnerCapabilities } from '../runners/runner.types';
import type { GeneratedWorkOrder } from '../work-orders/work-order-generator';
import { WorkOrderRecordsService } from '../work-orders/work-order-records.service';
import { DispatchService } from './dispatch.service';
import type { DispatchDecision } from './dispatch-policy';
import { RunExecutorService } from './run-executor.service';

/**
 * The joins are what is under test, so the joins are what stay real.
 *
 * Every piece this touches already has its own suite; what has never been
 * exercised is the ORDER they run in and what happens when one of them fails
 * halfway. So the collaborators are doubles and the assertions are about
 * sequencing and recovery — which row exists when, and what is left behind.
 */
describe('RunExecutorService', () => {
  const WORK_ORDER_ID = 'c0ffee00-0000-4000-8000-000000000001';

  const CAPABILITIES = {
    key: 'claude-code-local',
    version: '2.1.240',
  } as unknown as RunnerCapabilities;

  const workOrder = (overrides: Partial<GeneratedWorkOrder> = {}): GeneratedWorkOrder =>
    ({
      identity: 'wo_acme-widgets_42_abc1234_a1',
      branch: 'factory/42-abc1234-a1',
      repositoryOwner: 'acme',
      repositoryName: 'widgets',
      issueNumber: 42,
      issueUrl: 'https://github.com/acme/widgets/issues/42',
      issueTitle: 'Add a health endpoint',
      baseCommit: 'a3f91c2000000000000000000000000000000000',
      attempt: 1,
      taskSpec: 'Add a health endpoint',
      acceptanceCriteria: ['It returns 200'],
      pathConstraints: [],
      decisionRefs: [],
      budgetCeilingUsd: null,
      wallClockTimeoutMinutes: null,
      needs: ['full-streaming'],
      ...overrides,
    }) as GeneratedWorkOrder;

  const DISPATCHABLE: DispatchDecision = {
    outcome: 'dispatch',
    runnerKey: 'claude-code-local',
    queueReason: null,
    reason: 'Dispatch to claude-code-local',
    candidates: [],
  };

  const QUEUED: DispatchDecision = {
    outcome: 'queued',
    runnerKey: null,
    queueReason: 'capable-runners-are-at-capacity',
    reason: 'Everything is full',
    candidates: [],
  };

  let decide: jest.Mock;
  let write: jest.Mock;
  let submit: jest.Mock;
  let track: jest.Mock;
  let runCreate: jest.Mock;
  let runDelete: jest.Mock;
  let runUpdateMany: jest.Mock;
  let workOrderUpdate: jest.Mock;
  let executor: RunExecutorService;

  function build(enabled = true): RunExecutorService {
    decide = jest.fn().mockResolvedValue(DISPATCHABLE);
    write = jest.fn().mockResolvedValue({ alreadyRecorded: false });
    submit = jest.fn().mockResolvedValue({
      runnerKey: 'claude-code-local',
      externalId: 'ext-1',
      workOrderIdentity: 'wo_acme-widgets_42_abc1234_a1',
    });
    track = jest.fn();
    runCreate = jest.fn().mockResolvedValue({});
    runDelete = jest.fn().mockResolvedValue({});
    runUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    workOrderUpdate = jest.fn().mockResolvedValue({});

    const prisma = {
      run: { create: runCreate, delete: runDelete, updateMany: runUpdateMany },
      workOrder: { update: workOrderUpdate },
    } as unknown as PrismaService;

    const config = {
      get: (key: string) => (key === 'dispatch.enabled' ? enabled : undefined),
    } as unknown as ConfigService;

    const runner = {
      submit,
      capabilities: jest.fn().mockResolvedValue(CAPABILITIES),
    } as unknown as ClaudeCodeLocalRunner;
    Object.defineProperty(runner, 'key', { value: 'claude-code-local' });

    return new RunExecutorService(
      prisma,
      config,
      { decide } as unknown as DispatchService,
      { write } as unknown as WorkOrderRecordsService,
      { track } as unknown as RunPollerService,
      runner,
    );
  }

  const dispatch = () =>
    executor.dispatchWorkOrder({ workOrder: workOrder(), workOrderId: WORK_ORDER_ID });

  describe('the happy path', () => {
    beforeEach(() => {
      executor = build();
    });

    it('creates the run, writes the records, submits, and tracks', async () => {
      const result = await dispatch();

      expect(result.outcome).toBe('dispatched');
      expect(runCreate).toHaveBeenCalledTimes(1);
      expect(write).toHaveBeenCalledTimes(1);
      expect(submit).toHaveBeenCalledTimes(1);
      expect(track).toHaveBeenCalledTimes(1);
    });

    it('creates the run BEFORE submitting', async () => {
      // There has to be a row for an event to attach to before the first event
      // can arrive, which is exactly why WorkOrderSpec.runId is passed in
      // rather than returned by submit.
      await dispatch();

      expect(runCreate.mock.invocationCallOrder[0]).toBeLessThan(
        submit.mock.invocationCallOrder[0],
      );
    });

    it('writes the records BEFORE submitting', async () => {
      // #63's execution record is the branch's first commit and the runner's
      // workspace starts from that branch. Writing them afterwards would leave
      // the agent unable to push.
      await dispatch();

      expect(write.mock.invocationCallOrder[0]).toBeLessThan(submit.mock.invocationCallOrder[0]);
    });

    it('passes the same run id to the records, the spec and the poller', async () => {
      // Three places that must agree, and nothing joins them if they do not:
      // the commit trailer, the events, and what gets polled.
      const result = await dispatch();
      if (result.outcome !== 'dispatched') throw new Error('expected a dispatch');

      expect(write.mock.calls[0][0].runId).toBe(result.runId);
      expect(submit.mock.calls[0][0].runId).toBe(result.runId);
      expect(track.mock.calls[0][0]).toBe(result.runId);
    });

    it('never puts a runner name in the work order it submits', async () => {
      // VISION §6: "work orders never name a runner." The seam type has no
      // such field, which is what makes the rule structural.
      await dispatch();

      const spec = submit.mock.calls[0][0];
      expect(Object.keys(spec)).not.toContain('runner');
      expect(Object.keys(spec)).not.toContain('runnerKey');
    });

    it('records the version the runner reported, not a constant', async () => {
      await dispatch();

      expect(runCreate.mock.calls[0][0].data.runnerVersion).toBe('2.1.240');
      expect(write.mock.calls[0][0].runnerVersion).toBe('2.1.240');
    });

    it('moves the work order to dispatched', async () => {
      await dispatch();

      expect(workOrderUpdate).toHaveBeenCalledWith({
        where: { id: WORK_ORDER_ID },
        data: { status: 'dispatched' },
      });
    });
  });

  describe('when nothing can take it', () => {
    it('queues without creating a run', async () => {
      // A queue is a normal outcome (#64), not a failure, and a work order
      // nothing can take must never leave a Run row behind.
      executor = build();
      decide.mockResolvedValue(QUEUED);

      const result = await dispatch();

      expect(result).toMatchObject({ outcome: 'queued', queueReason: 'capable-runners-are-at-capacity' });
      expect(runCreate).not.toHaveBeenCalled();
      expect(submit).not.toHaveBeenCalled();
    });

    it('queues when routing names a runner this build cannot instantiate', async () => {
      // A registration left behind by an older deployment. The work order is
      // fine; the fleet is not.
      executor = build();
      decide.mockResolvedValue({ ...DISPATCHABLE, runnerKey: 'some-other-runner' });

      const result = await dispatch();

      expect(result.outcome).toBe('queued');
      expect(result.reason).toContain('some-other-runner');
      expect(runCreate).not.toHaveBeenCalled();
    });
  });

  describe('with dispatch disabled', () => {
    beforeEach(() => {
      executor = build(false);
    });

    it('runs the whole decision and spends nothing', async () => {
      // VISION §12's observation-week posture, applied to execution: a record
      // of what it WOULD have done, produced by the same code path that will
      // do it.
      const result = await dispatch();

      expect(result).toMatchObject({ outcome: 'observed', wouldDispatchTo: 'claude-code-local' });
      expect(decide).toHaveBeenCalledTimes(1);
      expect(runCreate).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
      expect(submit).not.toHaveBeenCalled();
    });

    it('names the runner and version it would have used', async () => {
      const result = await dispatch();
      expect(result.reason).toContain('claude-code-local@2.1.240');
    });

    it('still reports a queue as a queue, not as an observation', async () => {
      // Otherwise "would have dispatched" would be printed for a work order
      // that could not have been dispatched at all.
      decide.mockResolvedValue(QUEUED);

      expect((await dispatch()).outcome).toBe('queued');
    });

    it('defaults to disabled when the flag is absent', async () => {
      const config = { get: () => undefined } as unknown as ConfigService;
      const bare = new RunExecutorService(
        { run: { create: runCreate } } as unknown as PrismaService,
        config,
        { decide } as unknown as DispatchService,
        { write } as unknown as WorkOrderRecordsService,
        { track } as unknown as RunPollerService,
        {
          submit,
          capabilities: jest.fn().mockResolvedValue(CAPABILITIES),
        } as unknown as ClaudeCodeLocalRunner,
      );

      const result = await bare.dispatchWorkOrder({
        workOrder: workOrder(),
        workOrderId: WORK_ORDER_ID,
      });

      expect(result.outcome).toBe('observed');
    });
  });

  describe('when something fails after the run row exists', () => {
    beforeEach(() => {
      executor = build();
    });

    it('re-queues rather than failing when the runner is at capacity', async () => {
      // Routing reads the database; the ceiling counts live children. The two
      // can legitimately disagree by one, and #66 counts attempts to judge
      // decomposition quality — a capacity refusal is not an attempt.
      submit.mockRejectedValue(new RunnerAtCapacityError('claude-code-local is at its ceiling'));

      const result = await dispatch();

      expect(result.outcome).toBe('queued');
      expect(runDelete).toHaveBeenCalledTimes(1);
      expect(runUpdateMany).not.toHaveBeenCalled();
    });

    it('never leaves a phantom running row when submit throws', async () => {
      // The worst available outcome: the watchdog finds it 90 seconds later
      // and reports a silent run, which is true but useless — the run never
      // started and the reason is already known here.
      submit.mockRejectedValue(new Error('could not start claude'));

      const result = await dispatch();

      expect(result).toMatchObject({ outcome: 'failed' });
      expect(runUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: 'running' }),
          data: expect.objectContaining({ status: 'failed' }),
        }),
      );
    });

    it('carries the reason onto the failed run', async () => {
      submit.mockRejectedValue(new Error('could not start claude'));
      await dispatch();

      expect(runUpdateMany.mock.calls[0][0].data.attentionReason).toContain('could not start');
    });

    it('fails the run when the RECORDS step throws, and never submits', async () => {
      // The branch could not be created, so an agent starting now would have
      // nowhere to push.
      write.mockRejectedValue(new Error('GitHub write failed'));

      const result = await dispatch();

      expect(result.outcome).toBe('failed');
      expect(submit).not.toHaveBeenCalled();
      expect(track).not.toHaveBeenCalled();
    });

    it('does not track a run that failed to start', async () => {
      submit.mockRejectedValue(new Error('boom'));
      await dispatch();

      expect(track).not.toHaveBeenCalled();
    });

    it('leaves the work order dispatchable when submit failed', async () => {
      submit.mockRejectedValue(new Error('boom'));
      await dispatch();

      expect(workOrderUpdate).not.toHaveBeenCalled();
    });
  });
});
