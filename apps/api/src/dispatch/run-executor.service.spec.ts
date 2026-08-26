import type { HardCeiling } from '../budget/hard-spend-ceiling';
import { HardSpendCeilingService } from '../budget/hard-spend-ceiling';
import type { SpendTally } from '../budget/spend-ledger.service';
import { SpendLedgerService } from '../budget/spend-ledger.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  ClaudeCodeLocalRunner,
  RunnerAtCapacityError,
} from '../runners/claude-code-local/claude-code-local.runner';
import { RunPollerService } from '../runners/run-poller.service';
import type { RunnerCapabilities } from '../runners/runner.types';
import { makeOperatorSettings } from '../settings/operator-settings/operator-settings.test-double';
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
    // Not decoration. The spend gate (#65) reads this, and a runner that
    // reports no cost cannot take a work order with no ceiling -- so leaving
    // it off would make every dispatch test in this file exercise a refusal.
    reportsCost: true,
  } as unknown as RunnerCapabilities;

  const workOrder = (
    overrides: Partial<GeneratedWorkOrder> = {},
  ): GeneratedWorkOrder =>
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
      budgetCeilingUsd: 5,
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
    avoidedQuotaPark: false,
    avoidedPark: null,
  };

  const QUEUED: DispatchDecision = {
    outcome: 'queued',
    runnerKey: null,
    queueReason: 'capable-runners-are-at-capacity',
    reason: 'Everything is full',
    candidates: [],
    avoidedQuotaPark: false,
    avoidedPark: null,
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

  beforeEach(() => {
    // Room under the ceiling, and nothing unmeasured. The gate is exercised
    // deliberately in its own describe below; everywhere else it must be out
    // of the way, and visibly so.
    ceiling = { limitUsd: 100, windowDays: 30, malformed: null };
    tally = {
      reportedUsd: 0,
      estimatedUsd: 0,
      totalUsd: 0,
      runs: 0,
      runsWithoutCost: 0,
      unboundedRuns: 0,
      window: { from: new Date(0), to: new Date(0), days: 30 },
    };
  });

  /**
   * The spend gate's two inputs (#65), as fixtures the tests can move.
   *
   * Defaulted to a ceiling with room under it so that every pre-existing test
   * in this file keeps asserting what it was written to assert. That default
   * is itself load-bearing: without a ceiling the executor now REFUSES, so a
   * suite that left these unset would pass for the wrong reason -- every
   * dispatch test would be exercising the refusal path while claiming to
   * exercise dispatch.
   */
  let ceiling: HardCeiling;
  let tally: SpendTally;

  function ceilingOf(value: HardCeiling): HardSpendCeilingService {
    return { value } as unknown as HardSpendCeilingService;
  }

  function ledgerOf(value: SpendTally): SpendLedgerService {
    return {
      tally: jest.fn().mockResolvedValue(value),
    } as unknown as SpendLedgerService;
  }

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

    const settings = makeOperatorSettings({
      overrides: { 'dispatch.enabled': enabled },
    });

    const runner = {
      submit,
      capabilities: jest.fn().mockResolvedValue(CAPABILITIES),
    } as unknown as ClaudeCodeLocalRunner;
    Object.defineProperty(runner, 'key', { value: 'claude-code-local' });

    return new RunExecutorService(
      prisma,
      settings,
      { decide } as unknown as DispatchService,
      { write } as unknown as WorkOrderRecordsService,
      { track } as unknown as RunPollerService,
      runner,
      ceilingOf(ceiling),
      ledgerOf(tally),
    );
  }

  const dispatch = () =>
    executor.dispatchWorkOrder({
      workOrder: workOrder(),
      workOrderId: WORK_ORDER_ID,
    });

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

      expect(write.mock.invocationCallOrder[0]).toBeLessThan(
        submit.mock.invocationCallOrder[0],
      );
    });

    it('passes the same run id to the records, the spec and the poller', async () => {
      // Three places that must agree, and nothing joins them if they do not:
      // the commit trailer, the events, and what gets polled.
      const result = await dispatch();
      if (result.outcome !== 'dispatched')
        throw new Error('expected a dispatch');

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

    it('carries the model tier across the runner seam (#273)', async () => {
      // Routing having chosen a runner that SERVES the tier is not the same
      // as the runner knowing which tier to USE — dropping it here would
      // leave a `tier:small` work order running on the runner's default
      // model, which is the spend the tier exists to avoid.
      await executor.dispatchWorkOrder({
        workOrder: workOrder({ modelTier: 'small' }),
        workOrderId: WORK_ORDER_ID,
      });

      const spec = submit.mock.calls[0][0];
      expect(spec.modelTier).toBe('small');
    });

    it('sends no modelTier key at all when the work order asked for none', async () => {
      // An absent tier is not the same fact as an explicit undefined, and the
      // seam should not have to tell the two apart.
      await dispatch();

      const spec = submit.mock.calls[0][0];
      expect('modelTier' in spec).toBe(false);
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

    it('writes no avoided park when routing avoided none', async () => {
      // The single-runner fleet's permanent answer. A row here would be a
      // fabricated event, and the count is only worth anything if it counts
      // nothing when nothing happened.
      await dispatch();

      expect(runCreate.mock.calls[0][0].data.avoidedPark).toBeUndefined();
    });
  });

  describe('persisting the avoided park (#264)', () => {
    // The two-runner fixture #105's own tests use, because the real fleet
    // cannot produce one: there is exactly ONE registered runner, and
    // #102/#103's cloud runner is blocked on the vendor CLI. So this reports
    // zero in production, and that zero is the "before" half of VISION §10's
    // metric 2 — which is why it is built now rather than then.
    const AVOIDED: DispatchDecision = {
      ...DISPATCHABLE,
      avoidedQuotaPark: true,
      avoidedPark: {
        chosenRunnerKey: 'claude-code-local',
        exhausted: [
          {
            runnerKey: 'claude-code-cloud',
            resumesAt: '2026-08-23T18:00:00.000Z',
            basis:
              "1 run(s) on this runner are blocked on 'rate-limit' with a reset time",
          },
        ],
      },
    };

    beforeEach(() => {
      executor = build();
      decide.mockResolvedValue(AVOIDED);
    });

    it('persists the event instead of only logging it', async () => {
      // #105's boolean died with the in-memory decision and "counting these
      // over time" meant grepping container logs. This is the fix.
      await dispatch();

      expect(runCreate.mock.calls[0][0].data.avoidedPark).toMatchObject({
        create: expect.objectContaining({
          chosenRunnerKey: 'claude-code-local',
          exhaustedRunnerKeys: ['claude-code-cloud'],
        }),
      });
    });

    it('keeps the runner that was spent and when its window rolls', async () => {
      // What makes the count explainable: "work moved off claude-code-cloud
      // while it was rate-limited" is a sentence an operator can act on.
      // Recorded to EXPLAIN, never to subtract — see the model comment.
      await dispatch();

      const created = runCreate.mock.calls[0][0].data.avoidedPark.create;
      expect(created.resumesAt).toEqual(new Date('2026-08-23T18:00:00.000Z'));
      expect(created.basis[0]).toContain('claude-code-cloud');
      expect(created.basis[0]).toContain('rate-limit');
    });

    it('stores no duration, because the park never happened', async () => {
      // The one thing #264 exists to prevent. There is no interval to measure;
      // hours would have to be estimated from `resumesAt`, and an estimate
      // under a measurement's label is what `metrics.service.ts` refuses.
      await dispatch();

      const created = runCreate.mock.calls[0][0].data.avoidedPark.create;
      for (const key of Object.keys(created)) {
        expect(key).not.toMatch(
          /hours|duration|ms$|seconds|minutes|avoidedMs/i,
        );
      }
    });

    it('writes it in the SAME statement as the run', async () => {
      // A second create could fail on its own and leave a dispatched run whose
      // avoided park was silently lost — an undercount with no symptom, which
      // is the failure a metric can least afford.
      await dispatch();

      expect(runCreate).toHaveBeenCalledTimes(1);
      expect(runCreate.mock.calls[0][0].data.id).toBe(
        submit.mock.calls[0][0].runId,
      );
    });

    it('takes the SOONEST reset when several runners are spent', async () => {
      decide.mockResolvedValue({
        ...AVOIDED,
        avoidedPark: {
          chosenRunnerKey: 'claude-code-local',
          exhausted: [
            {
              runnerKey: 'a',
              resumesAt: '2026-08-23T20:00:00.000Z',
              basis: 'blocked',
            },
            {
              runnerKey: 'b',
              resumesAt: '2026-08-23T18:00:00.000Z',
              basis: 'blocked',
            },
          ],
        },
      });

      await dispatch();

      const created = runCreate.mock.calls[0][0].data.avoidedPark.create;
      expect(created.resumesAt).toEqual(new Date('2026-08-23T18:00:00.000Z'));
      expect(created.exhaustedRunnerKeys).toEqual(['a', 'b']);
    });

    it('records nothing when the work never dispatched', async () => {
      // Observation mode runs the whole decision and none of the consequences.
      // A park cannot have been avoided by a dispatch that did not happen.
      executor = build(false);
      decide.mockResolvedValue(AVOIDED);

      const result = await dispatch();

      expect(result.outcome).toBe('observed');
      expect(runCreate).not.toHaveBeenCalled();
    });
  });

  describe('when nothing can take it', () => {
    it('queues without creating a run', async () => {
      // A queue is a normal outcome (#64), not a failure, and a work order
      // nothing can take must never leave a Run row behind.
      executor = build();
      decide.mockResolvedValue(QUEUED);

      const result = await dispatch();

      expect(result).toMatchObject({
        outcome: 'queued',
        queueReason: 'capable-runners-are-at-capacity',
      });
      expect(runCreate).not.toHaveBeenCalled();
      expect(submit).not.toHaveBeenCalled();
    });

    it('queues when routing names a runner this build cannot instantiate', async () => {
      // A registration left behind by an older deployment. The work order is
      // fine; the fleet is not.
      executor = build();
      decide.mockResolvedValue({
        ...DISPATCHABLE,
        runnerKey: 'some-other-runner',
      });

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

      expect(result).toMatchObject({
        outcome: 'observed',
        wouldDispatchTo: 'claude-code-local',
      });
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
      // No override and a hermetic environment, so the `false` under test is
      // the REGISTRY's declared default rather than a `?? false` here.
      const bare = new RunExecutorService(
        { run: { create: runCreate } } as unknown as PrismaService,
        makeOperatorSettings(),
        { decide } as unknown as DispatchService,
        { write } as unknown as WorkOrderRecordsService,
        { track } as unknown as RunPollerService,
        {
          submit,
          capabilities: jest.fn().mockResolvedValue(CAPABILITIES),
        } as unknown as ClaudeCodeLocalRunner,
        ceilingOf(ceiling),
        ledgerOf(tally),
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
      submit.mockRejectedValue(
        new RunnerAtCapacityError('claude-code-local is at its ceiling'),
      );

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

      expect(runUpdateMany.mock.calls[0][0].data.attentionReason).toContain(
        'could not start',
      );
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
  /**
   * The spend gate (#65), at the only place that spends money.
   *
   * The gate's own truth table lives in `budget/spend-admission.spec.ts` and
   * is exhaustive there. What is asserted HERE is the wiring: that a refusal
   * actually stops the money, that the right three facts reach the gate, and
   * that a refusal is not quietly downgraded into an observation.
   */
  describe('the spend gate', () => {
    it('creates no run, writes no records and submits nothing when refused', async () => {
      // The assertion that matters is the absence of the side effects, not the
      // returned outcome: an executor that returned "queued" and had already
      // created the row would look correct from the outside and leave a
      // phantom `running` run for the watchdog to find.
      ceiling = { limitUsd: 10, malformed: null, windowDays: 30 };
      tally = { ...tally, totalUsd: 10, reportedUsd: 10 };
      executor = build();

      const result = await executor.dispatchWorkOrder({
        workOrder: workOrder(),
        workOrderId: WORK_ORDER_ID,
      });

      expect(result.outcome).toBe('queued');
      expect(result.outcome === 'queued' && result.queueReason).toBe(
        'hard-spend-ceiling-reached',
      );
      expect(runCreate).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
      expect(submit).not.toHaveBeenCalled();
      expect(track).not.toHaveBeenCalled();
    });

    it('refuses with no ceiling configured, which is the default for a fresh install', async () => {
      ceiling = { limitUsd: null, malformed: null, windowDays: 30 };
      executor = build();

      const result = await executor.dispatchWorkOrder({
        workOrder: workOrder(),
        workOrderId: WORK_ORDER_ID,
      });

      expect(result.outcome === 'queued' && result.queueReason).toBe(
        'no-hard-spend-ceiling-configured',
      );
      expect(submit).not.toHaveBeenCalled();
    });

    it('refuses BEFORE the observation-mode check, not after it', async () => {
      // An install running with dispatch off is the one that most needs to
      // hear its ceiling is unset -- there is still time to fix it. Reporting
      // "would have dispatched" for a work order the gate would have refused
      // is the same lie as reporting it for one routing would have queued,
      // which this file already tests for a few blocks up.
      ceiling = { limitUsd: null, malformed: null, windowDays: 30 };
      executor = build(false);

      const result = await executor.dispatchWorkOrder({
        workOrder: workOrder(),
        workOrderId: WORK_ORDER_ID,
      });

      expect(result.outcome).toBe('queued');
      expect(result.outcome === 'queued' && result.queueReason).toBe(
        'no-hard-spend-ceiling-configured',
      );
    });

    it('refuses an order with no ceiling routed to a runner that reports no cost', async () => {
      // Both halves have to reach the gate for this to be decidable, so this
      // is really a test that neither is dropped on the way in.
      const runner = {
        submit,
        capabilities: jest
          .fn()
          .mockResolvedValue({ ...CAPABILITIES, reportsCost: false }),
      } as unknown as ClaudeCodeLocalRunner;

      const executorWithBlindRunner = new RunExecutorService(
        { run: { create: runCreate } } as unknown as PrismaService,
        makeOperatorSettings({ overrides: { 'dispatch.enabled': true } }),
        { decide } as unknown as DispatchService,
        { write } as unknown as WorkOrderRecordsService,
        { track } as unknown as RunPollerService,
        runner,
        ceilingOf(ceiling),
        ledgerOf(tally),
      );

      const result = await executorWithBlindRunner.dispatchWorkOrder({
        workOrder: workOrder({ budgetCeilingUsd: null }),
        workOrderId: WORK_ORDER_ID,
      });

      expect(result.outcome === 'queued' && result.queueReason).toBe(
        'work-order-cannot-be-budgeted',
      );
      expect(runCreate).not.toHaveBeenCalled();
    });

    it('dispatches normally when there is headroom', async () => {
      // The other side of the fixture default, asserted explicitly rather
      // than left implicit in the rest of the file: if the gate were refusing
      // everything, every other test here would still pass for the wrong
      // reason only if it asserted outcomes it does not assert.
      ceiling = { limitUsd: 100, malformed: null, windowDays: 30 };
      tally = { ...tally, totalUsd: 1, reportedUsd: 1 };
      executor = build();

      const result = await executor.dispatchWorkOrder({
        workOrder: workOrder(),
        workOrderId: WORK_ORDER_ID,
      });

      expect(result.outcome).toBe('dispatched');
      expect(submit).toHaveBeenCalledTimes(1);
    });

    it("tallies over the ceiling's own window, not a window of its own choosing", async () => {
      ceiling = { limitUsd: 100, malformed: null, windowDays: 7 };
      const ledger = ledgerOf(tally);
      const executorWithLedger = new RunExecutorService(
        {
          run: { create: runCreate },
          workOrder: { update: workOrderUpdate },
        } as unknown as PrismaService,
        makeOperatorSettings({ overrides: { 'dispatch.enabled': true } }),
        { decide } as unknown as DispatchService,
        { write } as unknown as WorkOrderRecordsService,
        { track } as unknown as RunPollerService,
        {
          submit,
          capabilities: jest.fn().mockResolvedValue(CAPABILITIES),
        } as unknown as ClaudeCodeLocalRunner,
        ceilingOf(ceiling),
        ledger,
      );

      await executorWithLedger.dispatchWorkOrder({
        workOrder: workOrder(),
        workOrderId: WORK_ORDER_ID,
      });

      expect(ledger.tally).toHaveBeenCalledWith(7);
    });
  });
});
