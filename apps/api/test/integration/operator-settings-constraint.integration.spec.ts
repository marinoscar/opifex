import { Prisma } from '@prisma/client';

import { PrismaService } from '../../src/prisma/prisma.service';

/**
 * #336: the `operator_settings_value_xor_secret_check` CHECK constraint,
 * proven against a real database rather than asserted about.
 *
 * `value` and the ciphertext group are two mutually exclusive ways of
 * storing one settings row — see the doc comment on `OperatorSetting` in
 * `prisma/schema.prisma` for why a row with both, or with neither, is a
 * bug the database itself must refuse. Prisma's schema language cannot
 * express a multi-column CHECK, so nothing at the ORM layer stops a caller
 * from building a payload with both fields set — the SAME gap
 * `reconciler-actions-executed.integration.spec.ts` closes for
 * `actionsExecuted`, just one layer lower: a Prisma mock would happily
 * `create()` an invalid row and this test would pass for the wrong reason.
 * Only a real Postgres connection can show the constraint actually fires.
 *
 * Requires the test database from `infra/compose/test.compose.yml`
 * (`opifex_test`, host port 5433) reachable via `DATABASE_URL` /
 * `POSTGRES_*`. Skips itself, loudly, when it is not — the same guard
 * `reconciler-actions-executed.integration.spec.ts` uses.
 */

function databaseReachable(): boolean {
  return Boolean(process.env.DATABASE_URL || process.env.POSTGRES_HOST);
}

const describeIfDb = databaseReachable() ? describe : describe.skip;

if (!databaseReachable()) {
  console.warn(
    'Skipping operator-settings-constraint.integration.spec.ts: no DATABASE_URL/POSTGRES_HOST ' +
      'in the environment. Point it at opifex_test (infra/compose/test.compose.yml) to run it.',
  );
}

describeIfDb(
  'operator_settings CHECK constraints, against a real database (#336)',
  () => {
    let prisma: PrismaService;
    let createdKeys: string[];

    beforeAll(() => {
      prisma = new PrismaService();
    });

    afterAll(async () => {
      await prisma.$disconnect();
    });

    beforeEach(() => {
      createdKeys = [];
    });

    afterEach(async () => {
      if (createdKeys.length > 0) {
        await prisma.operatorSetting.deleteMany({
          where: { key: { in: createdKeys } },
        });
      }
    });

    /** Unique per test run, so parallel jest workers never collide on `key`. */
    function uniqueKey(label: string): string {
      return `test.${label}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
    }

    async function expectCheckViolation(
      data: Prisma.OperatorSettingUncheckedCreateInput,
    ) {
      await expect(prisma.operatorSetting.create({ data })).rejects.toThrow(
        /operator_settings_value_xor_secret_check/,
      );
    }

    it('rejects a row with both value and a full ciphertext group set', async () => {
      const key = uniqueKey('both');
      createdKeys.push(key);

      await expectCheckViolation({
        key,
        value: { enabled: true },
        secretCiphertext: 'ciphertext',
        secretIv: 'iv',
        secretAuthTag: 'authTag',
        secretKeyVersion: 1,
      });

      // The rejected INSERT must not have landed a row for a later query to
      // find — the constraint fires inside the same transaction as the write.
      const row = await prisma.operatorSetting.findUnique({ where: { key } });
      expect(row).toBeNull();
    });

    it('rejects a row with neither value nor any ciphertext column set', async () => {
      const key = uniqueKey('neither');
      createdKeys.push(key);

      await expectCheckViolation({ key });

      const row = await prisma.operatorSetting.findUnique({ where: { key } });
      expect(row).toBeNull();
    });

    it('rejects a row with a partially-written ciphertext group', async () => {
      const key = uniqueKey('partial-secret');
      createdKeys.push(key);

      // secretIv and secretAuthTag are missing — a secret that could never be
      // decrypted, and the constraint refuses it as strictly as the "both" case.
      await expectCheckViolation({
        key,
        secretCiphertext: 'ciphertext',
        secretKeyVersion: 1,
      });

      const row = await prisma.operatorSetting.findUnique({ where: { key } });
      expect(row).toBeNull();
    });

    it('accepts a row with only value set', async () => {
      const key = uniqueKey('value-only');
      createdKeys.push(key);

      const row = await prisma.operatorSetting.create({
        data: { key, value: { maxConcurrent: 3 } },
      });

      expect(row.value).toEqual({ maxConcurrent: 3 });
      expect(row.secretCiphertext).toBeNull();
    });

    it('accepts a row with only a complete ciphertext group set', async () => {
      const key = uniqueKey('secret-only');
      createdKeys.push(key);

      const row = await prisma.operatorSetting.create({
        data: {
          key,
          secretCiphertext: 'ciphertext',
          secretIv: 'iv',
          secretAuthTag: 'authTag',
          secretKeyVersion: 1,
        },
      });

      expect(row.value).toBeNull();
      expect(row.secretCiphertext).toBe('ciphertext');
    });

    /**
     * #336's other acceptance criterion: the document-level revision counter
     * is created BY THE MIGRATION, not lazily on first write, and is pinned to
     * exactly one row by `operator_settings_revision_id_check`.
     */
    describe('operator_settings_revision, the migration-seeded singleton', () => {
      it('already has exactly one row, at id 1, with no test setup', async () => {
        const rows = await prisma.operatorSettingsRevision.findMany();

        expect(rows).toHaveLength(1);
        expect(rows[0].id).toBe(1);
        // Deliberately NOT `toBe(0n)`. The row's EXISTENCE without setup is
        // what #336 claims -- that the migration seeds it rather than the
        // first write creating it lazily. Its VALUE is not this spec's
        // property: `OperatorSettingsService.set()` bumps the counter through
        // the real write path, so on a persistent local test database the
        // first run of the write-path spec would break this one permanently,
        // and in an order-dependent way that looks like a real regression.
        // A test that fails because a sibling did its job is a false alarm
        // with a long half-life.
        expect(rows[0].revision).toBeGreaterThanOrEqual(0n);
      });

      it('rejects a second row', async () => {
        await expect(
          prisma.operatorSettingsRevision.create({
            data: { id: 2, revision: 0n },
          }),
        ).rejects.toThrow(/operator_settings_revision_id_check/);

        const rows = await prisma.operatorSettingsRevision.findMany();
        expect(rows).toHaveLength(1);
      });
    });
  },
);
