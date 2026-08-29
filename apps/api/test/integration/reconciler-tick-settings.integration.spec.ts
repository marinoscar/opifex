import { describeIfDb } from '../helpers/database-guard.helper';
import { PrismaService } from '../../src/prisma/prisma.service';
import { ReconcileLogService } from '../../src/reconciler/log/reconcile-log.service';
import type {
  TickRecord,
  TickSettings,
} from '../../src/reconciler/reconciler.types';

/**
 * #342's acceptance criterion — "The snapshot is persisted on the tick record
 * and visible on the tick endpoints" — proven against a real database rather
 * than asserted about, the same reasoning
 * `reconciler-actions-executed.integration.spec.ts` and
 * `operator-settings-constraint.integration.spec.ts` give for their own real
 * connections: a mocked Prisma would happily accept a payload the actual
 * `reconcile_ticks` table has no column for, or silently coerce `undefined`
 * into whatever the mock felt like, and this file exists to close exactly
 * that gap for `settings` the way #317 closed it for `actionsExecuted`.
 *
 * Two things are load-bearing here and neither is provable at the unit level
 * with a mocked Prisma:
 *
 *  1. The column actually exists and actually round-trips a `TickSettings`
 *     object through real JSONB, under the exact name
 *     `ReconcileLogService.toResponse` reads back (`settings`) — a typo in
 *     either the migration or the mapper would pass a mock and fail here.
 *  2. Two ticks recorded with two DIFFERENT snapshots keep them apart in
 *     storage: tick A's row must read back tick A's numbers, never tick B's,
 *     and never "whatever the values happen to be by the time someone reads
 *     the row". `ReconcileLogService` holds no settings of its own to leak
 *     from one call into the next, but that is exactly the kind of property
 *     a hollow implementation (writing a shared/global value, or dropping the
 *     field and reading some other row's) could still pass a shallow test.
 *
 * Requires the test database from `infra/compose/test.compose.yml`
 * (`opifex_test`, host port 5433) reachable via `DATABASE_URL` /
 * `POSTGRES_*`. Skips itself, loudly, when it is not — the same guard the two
 * files above use.
 */

function tickRecord(overrides: Partial<TickRecord> = {}): TickRecord {
  const now = new Date();
  return {
    startedAt: now,
    finishedAt: now,
    durationMs: 5,
    outcome: 'completed',
    repositoriesObserved: 1,
    failures: [],
    allFromCache: false,
    rateLimitRemaining: 4999,
    settings: { retryCeiling: 3, rateLimitReserve: 100, writesEnabled: false },
    projections: [],
    workOrdersCreated: 0,
    rejections: [],
    actions: [],
    ...overrides,
  };
}

describeIfDb(
  'reconciler-tick-settings.integration.spec.ts',
  'reconcile_ticks.settings, persisted to a real database (#342)',
  () => {
    let prisma: PrismaService;
    let log: ReconcileLogService;
    let createdIds: string[];

    beforeAll(() => {
      prisma = new PrismaService();
      log = new ReconcileLogService(prisma);
    });

    afterAll(async () => {
      await prisma.$disconnect();
    });

    beforeEach(() => {
      createdIds = [];
    });

    afterEach(async () => {
      if (createdIds.length > 0) {
        await prisma.reconcileTick.deleteMany({
          where: { id: { in: createdIds } },
        });
      }
    });

    async function record(record: TickRecord): Promise<string> {
      const id = await log.record(record);
      expect(id).not.toBeNull();
      createdIds.push(id!);
      return id!;
    }

    /**
     * The basic round trip: what goes in through `record` comes back out
     * through `findById` — the exact function `ReconcilerController.getTick`
     * calls — unchanged.
     */
    it('round-trips a settings snapshot through findById', async () => {
      const settings: TickSettings = {
        retryCeiling: 7,
        rateLimitReserve: 250,
        writesEnabled: true,
      };
      const id = await record(tickRecord({ settings }));

      const tick = await log.findById(id);

      expect(tick?.settings).toEqual(settings);
    });

    /** The same round trip through `history` — what `listTicks` calls. */
    it('round-trips a settings snapshot through history', async () => {
      const settings: TickSettings = {
        retryCeiling: 9,
        rateLimitReserve: 50,
        writesEnabled: false,
      };
      const id = await record(tickRecord({ settings }));

      const { items } = await log.history({ page: 1, pageSize: 25 });
      const found = items.find((item) => item.id === id);

      expect(found?.settings).toEqual(settings);
    });

    /**
     * The property the unit-level spec cannot demonstrate: two ticks with two
     * DIFFERENT snapshots — the shape a live setting change between ticks
     * actually produces — must keep their own numbers in storage rather than
     * converging on one shared value. Tick A's retryCeiling was 3 when it ran;
     * tick B's was 9. Both must still say so after both are written, which is
     * the persisted analogue of "a tick's decisions used the snapshot" that
     * `reconciler.service.spec.ts`'s in-memory version already proves.
     */
    it('keeps two ticks recorded with different snapshots apart in storage', async () => {
      const settingsA: TickSettings = {
        retryCeiling: 3,
        rateLimitReserve: 100,
        writesEnabled: false,
      };
      const settingsB: TickSettings = {
        retryCeiling: 9,
        rateLimitReserve: 400,
        writesEnabled: true,
      };

      const idA = await record(tickRecord({ settings: settingsA }));
      const idB = await record(tickRecord({ settings: settingsB }));

      const [tickA, tickB] = await Promise.all([
        log.findById(idA),
        log.findById(idB),
      ]);

      expect(tickA?.settings).toEqual(settingsA);
      expect(tickB?.settings).toEqual(settingsB);
      // The point stated as its own assertion: neither row picked up the
      // other's numbers.
      expect(tickA?.settings).not.toEqual(tickB?.settings);
    });

    /**
     * `null` is a value this column has to be able to carry honestly: a row
     * written before this migration existed never captured a settings snapshot
     * at all. Built with a direct `create()` that OMITS `settings` — exactly
     * what such a row looks like — rather than through `ReconcileLogService`,
     * which always sets it now. `findById` must return that `null` as-is,
     * never coerced into a default object that would misstate what that tick
     * actually ran under.
     */
    it('reads back null, unmodified, for a row that predates the column', async () => {
      const now = new Date();
      const row = await prisma.reconcileTick.create({
        select: { id: true },
        data: {
          startedAt: now,
          finishedAt: now,
          durationMs: 5,
          outcome: 'completed',
          repositoriesObserved: 1,
          actionsComputed: 0,
          allFromCache: false,
          failures: [],
          // `settings` deliberately absent — Postgres stores NULL, the same
          // state every row written before this migration is actually in.
        },
      });
      createdIds.push(row.id);

      const tick = await log.findById(row.id);

      expect(tick?.settings).toBeNull();
    });
  },
);
