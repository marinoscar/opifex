import { PrismaService } from '../prisma/prisma.service';
import { generateWorkOrder } from '../work-orders/work-order-generator';
import { DISPATCH_BATCH_SIZE, DispatchQueueService } from './dispatch-queue.service';
import { RunExecutorService } from './run-executor.service';

/**
 * What this drains, what it refuses, and what it does with a row that cannot
 * be rebuilt.
 *
 * The rows here are built by the REAL generator and then flattened, so a row
 * that would fail `rehydrateWorkOrder` fails for the same reason a real one
 * would rather than because a fixture was hand-assembled wrong.
 */
describe('DispatchQueueService', () => {
  /** A row exactly as the projection (#155) would have written it. */
  function row(overrides: Record<string, unknown> = {}) {
    const generated = generateWorkOrder({
      issue: {
        repository: { owner: 'marinoscar', name: 'opifex' },
        issueNumber: 312,
        title: 'Add a permit search prompt builder',
        issueUrl: 'https://github.com/marinoscar/opifex/issues/312',
        taskSpec: 'Add a permit search prompt builder to the chat surface.',
        acceptanceCriteria: [
          'Searching by address returns the matching permits',
          'An empty result set renders the empty state',
        ],
        pathConstraints: [],
        decisionRefs: [],
        needs: [],
      },
      baseCommit: 'a3f91c2000000000000000000000000000000000',
      attempt: 1,
      budgetCeilingUsd: 5,
      wallClockTimeoutMinutes: 30,
    });
    if (!generated.ok) throw new Error('fixture did not generate');
    const w = generated.workOrder;

    return {
      id: 'wo-uuid',
      identity: w.identity,
      branch: w.branch,
      issueNumber: w.issueNumber,
      issueUrl: w.issueUrl,
      issueTitle: w.issueTitle,
      baseCommit: w.baseCommit,
      attempt: w.attempt,
      taskSpec: w.taskSpec,
      acceptanceCriteria: w.acceptanceCriteria,
      pathConstraints: w.pathConstraints,
      decisionRefs: w.decisionRefs,
      needs: w.needs,
      budgetCeilingUsd: w.budgetCeilingUsd,
      wallClockTimeoutMinutes: w.wallClockTimeoutMinutes,
      repository: { owner: 'marinoscar', name: 'opifex', dispatchEnabled: true },
      ...overrides,
    };
  }

  let findMany: jest.Mock;
  let update: jest.Mock;
  let dispatchWorkOrder: jest.Mock;
  let service: DispatchQueueService;

  beforeEach(() => {
    findMany = jest.fn().mockResolvedValue([row()]);
    update = jest.fn().mockResolvedValue({});
    dispatchWorkOrder = jest.fn().mockResolvedValue({
      outcome: 'dispatched',
      runId: 'run-uuid',
      runnerKey: 'claude-code-local',
      reason: 'dispatched',
    });

    service = new DispatchQueueService(
      { workOrder: { findMany, update } } as unknown as PrismaService,
      { dispatchWorkOrder } as unknown as RunExecutorService,
    );
  });

  describe('what it selects', () => {
    it('asks only for queued work orders', async () => {
      // `held` is a different status, so a hold applied between ticks stops
      // the row being selected at all. Structural rather than a check.
      await service.drain();

      expect(findMany.mock.calls[0][0].where).toEqual({ status: 'queued' });
    });

    it('takes the oldest queuedAt first', async () => {
      // `queuedAt` rather than `createdAt`: a work order that was held and
      // later released is queued from the moment the hold lifted. Ordering on
      // creation would let a long-held one jump ahead of work that has
      // actually been waiting.
      await service.drain();

      expect(findMany.mock.calls[0][0].orderBy).toEqual({ queuedAt: 'asc' });
    });

    it('bounds the batch', async () => {
      // Fifty issues marked ready at once would otherwise mean fifty decide()
      // calls inside a tick that has 60 seconds. They queue on concurrency
      // anyway.
      await service.drain();

      expect(findMany.mock.calls[0][0].take).toBe(DISPATCH_BATCH_SIZE);
    });

    it('does nothing at all on an empty queue', async () => {
      findMany.mockResolvedValue([]);

      const result = await service.drain();

      expect(dispatchWorkOrder).not.toHaveBeenCalled();
      expect(result.dispatched).toBe(0);
    });
  });

  describe('handing a work order over', () => {
    it('rebuilds the stored document rather than re-projecting it', async () => {
      // #63 posted an authorization record for ONE specific document. If the
      // issue has since been edited, a re-projection is a DIFFERENT work order
      // wearing the same issue number.
      await service.drain();

      expect(dispatchWorkOrder).toHaveBeenCalledTimes(1);
      const input = dispatchWorkOrder.mock.calls[0][0];
      expect(input.workOrderId).toBe('wo-uuid');
      expect(input.workOrder.identity).toBe('wo_opifex_312_a3f91c2_a1');
      expect(input.workOrder.taskSpec).toContain('permit search prompt builder');
    });

    it('counts a dispatch', async () => {
      const result = await service.drain();
      expect(result.dispatched).toBe(1);
    });

    it('leaves a work order the executor queued exactly as it is', async () => {
      // Waiting for headroom is already the right state. Writing the status
      // back would touch updatedAt on every row on every tick for no change.
      dispatchWorkOrder.mockResolvedValue({
        outcome: 'queued',
        queueReason: 'capable-runners-are-at-capacity',
        reason: 'full',
      });

      const result = await service.drain();

      expect(update).not.toHaveBeenCalled();
      expect(result.stillQueued).toBe(1);
    });

    it('leaves a failed work order queued for a later tick', async () => {
      // The failure was BEFORE the run started, so nothing was spent and
      // nothing is half-done. The executor already marked the run failed.
      dispatchWorkOrder.mockResolvedValue({
        outcome: 'failed',
        runId: 'run-uuid',
        reason: 'could not create the branch',
      });

      const result = await service.drain();

      expect(update).not.toHaveBeenCalled();
      expect(result.failed).toBe(1);
    });

    it('counts an observation when dispatch is globally off', async () => {
      // The executor runs the whole decision and reports what it WOULD have
      // done. That is the observation-week artifact, so the pass still runs.
      dispatchWorkOrder.mockResolvedValue({
        outcome: 'observed',
        wouldDispatchTo: 'claude-code-local',
        reason: 'DISPATCH DISABLED',
      });

      const result = await service.drain();

      expect(result.observed).toBe(1);
      expect(result.dispatched).toBe(0);
    });
  });

  describe('a repository with dispatch disabled', () => {
    it('is never handed to the executor', async () => {
      findMany.mockResolvedValue([
        row({ repository: { owner: 'marinoscar', name: 'opifex', dispatchEnabled: false } }),
      ]);

      const result = await service.drain();

      expect(dispatchWorkOrder).not.toHaveBeenCalled();
      expect(result.repositoriesDisabled).toBe(1);
    });

    it('does not block a repository that IS enabled', async () => {
      findMany.mockResolvedValue([
        row({
          id: 'off',
          repository: { owner: 'marinoscar', name: 'other', dispatchEnabled: false },
        }),
        row({ id: 'on' }),
      ]);

      const result = await service.drain();

      expect(dispatchWorkOrder).toHaveBeenCalledTimes(1);
      expect(dispatchWorkOrder.mock.calls[0][0].workOrderId).toBe('on');
      expect(result.dispatched).toBe(1);
    });
  });

  describe('a row that cannot be rebuilt', () => {
    it('is quarantined rather than retried forever', async () => {
      // A row whose stored identity its own coordinates do not derive is a
      // data-integrity problem no amount of retrying fixes. Left queued it
      // would be reconsidered every 60 seconds until somebody noticed.
      findMany.mockResolvedValue([row({ identity: 'wo_something-else_312_a3f91c2_a1' })]);

      const result = await service.drain();

      expect(dispatchWorkOrder).not.toHaveBeenCalled();
      expect(result.unrebuildable).toBe(1);
      expect(update).toHaveBeenCalledTimes(1);
      expect(update.mock.calls[0][0]).toMatchObject({
        where: { id: 'wo-uuid' },
        data: { status: 'quarantined' },
      });
    });

    it('records why, in the field the schema keeps for it', async () => {
      // `holdReason`, documented as "why it is held or quarantined".
      // `attentionReason` lives on Run and does not exist here — and Prisma's
      // generated `data` argument accepts an unknown field WITHOUT a type
      // error, so the first version of this compiled and would have thrown.
      findMany.mockResolvedValue([row({ identity: 'wo_something-else_312_a3f91c2_a1' })]);

      await service.drain();

      const data = update.mock.calls[0][0].data;
      expect(Object.keys(data).sort()).toEqual(['holdReason', 'status']);
      expect(data.holdReason).toMatch(/disagrees with itself/);
    });

    it('quarantines a row declaring a need this build does not understand', async () => {
      // Dispatching it as though it had not asked could send a work order
      // requiring own-infrastructure to a vendor cloud.
      findMany.mockResolvedValue([row({ needs: ['gpu-attached'] })]);

      const result = await service.drain();

      expect(result.unrebuildable).toBe(1);
      expect(update.mock.calls[0][0].data.holdReason).toMatch(/gpu-attached/);
    });

    it('keeps draining the rest of the batch', async () => {
      // One bad row must not abandon everything behind it.
      findMany.mockResolvedValue([
        row({ id: 'bad', identity: 'wo_something-else_312_a3f91c2_a1' }),
        row({ id: 'good' }),
      ]);

      const result = await service.drain();

      expect(result.unrebuildable).toBe(1);
      expect(result.dispatched).toBe(1);
      expect(dispatchWorkOrder.mock.calls[0][0].workOrderId).toBe('good');
    });
  });

  describe('failures it absorbs', () => {
    it('counts a throw as a failure and continues', async () => {
      findMany.mockResolvedValue([row({ id: 'a' }), row({ id: 'b' })]);
      dispatchWorkOrder
        .mockRejectedValueOnce(new Error('unexpected'))
        .mockResolvedValue({
          outcome: 'dispatched',
          runId: 'r',
          runnerKey: 'claude-code-local',
          reason: 'ok',
        });

      const result = await service.drain();

      expect(result.failed).toBe(1);
      expect(result.dispatched).toBe(1);
    });
  });
});
