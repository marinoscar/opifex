import { tickRecordSchema } from './dto/tick-history.dto';
import type { ReconcileLogService } from './log/reconcile-log.service';
import { ReconcilerController } from './reconciler.controller';

/**
 * #320: nothing exercised these two endpoints' response shape before. Both
 * methods return exactly what `ReconcileLogService` hands them — no mapping
 * of their own — so what is asserted here is that the controller does not
 * quietly introduce one, and that `null` versus `[]` on `executionFailures`
 * survives to what a caller of `GET /api/reconciler/ticks` and
 * `GET /api/reconciler/ticks/:id` actually receives.
 */
describe('ReconcilerController', () => {
  function tick(overrides: Record<string, unknown> = {}) {
    return {
      id: '11111111-1111-4111-8111-111111111111',
      startedAt: '2026-08-21T10:00:00.000Z',
      finishedAt: '2026-08-21T10:00:01.000Z',
      durationMs: 1000,
      outcome: 'completed',
      repositoriesObserved: 1,
      actionsComputed: 1,
      actionsExecuted: 1,
      allFromCache: false,
      rateLimitRemaining: 4999,
      settings: {
        retryCeiling: 3,
        rateLimitReserve: 100,
        writesEnabled: false,
      },
      failures: [],
      executionFailures: null,
      projections: null,
      actions: null,
      ...overrides,
    };
  }

  function build(log: Partial<ReconcileLogService>) {
    const controller = new ReconcilerController(
      log as unknown as ReconcileLogService,
    );
    return controller;
  }

  describe('GET /reconciler/ticks (listTicks)', () => {
    it('passes a null executionFailures through untouched, and it is a valid response', async () => {
      const page = {
        items: [tick({ executionFailures: null })],
        total: 1,
        page: 1,
        pageSize: 25,
      };
      const controller = build({
        history: jest.fn().mockResolvedValue(page),
      });

      const result = await controller.listTicks({
        page: 1,
        pageSize: 25,
      } as never);

      expect(result.items[0]!.executionFailures).toBeNull();
      expect(() => tickRecordSchema.parse(result.items[0])).not.toThrow();
    });

    it('passes an empty-array executionFailures through as [], distinct from null', async () => {
      const page = {
        items: [tick({ executionFailures: [] })],
        total: 1,
        page: 1,
        pageSize: 25,
      };
      const controller = build({
        history: jest.fn().mockResolvedValue(page),
      });

      const result = await controller.listTicks({
        page: 1,
        pageSize: 25,
      } as never);

      expect(result.items[0]!.executionFailures).toEqual([]);
      expect(result.items[0]!.executionFailures).not.toBeNull();
      expect(() => tickRecordSchema.parse(result.items[0])).not.toThrow();
    });
  });

  describe('GET /reconciler/ticks/:id (getTick)', () => {
    it('passes a null executionFailures through untouched', async () => {
      const controller = build({
        findById: jest
          .fn()
          .mockResolvedValue(tick({ executionFailures: null })),
      });

      const result = await controller.getTick('tick-uuid');

      expect(result.executionFailures).toBeNull();
      expect(() => tickRecordSchema.parse(result)).not.toThrow();
    });

    it('passes a populated executionFailures array through untouched', async () => {
      const populated = [
        {
          source: 'spec-feedback',
          actionType: 'post-spec-feedback',
          repository: 'acme/app',
          issueNumber: 312,
          reason: '502 from GitHub',
        },
      ];
      const controller = build({
        findById: jest
          .fn()
          .mockResolvedValue(tick({ executionFailures: populated })),
      });

      const result = await controller.getTick('tick-uuid');

      expect(result.executionFailures).toEqual(populated);
      expect(() => tickRecordSchema.parse(result)).not.toThrow();
    });

    it('still throws NotFoundException when there is no such tick', async () => {
      const controller = build({
        findById: jest.fn().mockResolvedValue(null),
      });

      await expect(controller.getTick('missing-uuid')).rejects.toThrow(
        'Reconcile tick missing-uuid not found',
      );
    });
  });
});
