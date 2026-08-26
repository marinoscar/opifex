import { randomBytes } from 'node:crypto';

import { Prisma } from '@prisma/client';

import { ENCRYPTION_KEY_ENV_VAR } from '../../src/common/crypto/secret-box';
import { PrismaService } from '../../src/prisma/prisma.service';
import { OPERATOR_SETTINGS } from '../../src/settings/operator-settings/operator-settings.registry';
import { OperatorSettingsService } from '../../src/settings/operator-settings/operator-settings.service';

/**
 * #339 (epic #332): `OperatorSettingsService`'s WRITE path — `set()`,
 * `clear()`, `refresh()` and the `overlay()` status — against a real
 * database, closing the specific gap the service's otherwise-thorough unit
 * suite cannot: those 358 tests run entirely against a hand-written Prisma
 * fake, so two things are MODELLED rather than proven there:
 *
 *   1. The `operator_settings_value_xor_secret_check` CHECK constraint — the
 *      fake happily accepts whatever shape `set()`/`clear()` build; only
 *      Postgres can show the row this service actually writes is legal, and
 *      that OVERWRITING a row (plain -> secret, secret -> plain) leaves it
 *      legal too. A fake `set()` twice on one key can never change the row's
 *      SHAPE, because the fake has no shape to violate — only a real table
 *      with the constraint attached can catch a write that gets this wrong.
 *   2. `Prisma.JsonNull` vs a bare `null` — the fake was itself wrong about
 *      this once (a bare `null` writes SQL NULL, which the CHECK refuses,
 *      not the JSON scalar `null` a nullable key legitimately resolves to).
 *
 * This is a companion to `operator-settings-constraint.integration.spec.ts`,
 * which proves the CHECK constraint in isolation with hand-built rows. This
 * file proves the SERVICE's own write path produces rows the constraint
 * accepts, and that a caller reading back through `get()`/`resolve()` sees
 * what was actually stored.
 *
 * `OperatorSettingsService`'s constructor is `@Optional() prisma?:
 * PrismaService`, so it is instantiated directly here with a real
 * `PrismaService` — no Nest test module needed, same as
 * `operator-settings-constraint.integration.spec.ts`.
 *
 * Requires the test database from `infra/compose/test.compose.yml`
 * (`opifex_test`, host port 5433) reachable via `DATABASE_URL` /
 * `POSTGRES_*`, and `OPIFEX_SETTINGS_ENCRYPTION_KEY` set (generated below in
 * `beforeAll`) so the secret-key assertions can actually seal and open.
 * Skips itself, loudly, when the database is not reachable — the same guard
 * `operator-settings-constraint.integration.spec.ts` uses.
 */

function databaseReachable(): boolean {
  return Boolean(process.env.DATABASE_URL || process.env.POSTGRES_HOST);
}

const describeIfDb = databaseReachable() ? describe : describe.skip;

if (!databaseReachable()) {
  console.warn(
    'Skipping operator-settings-service-write-path.integration.spec.ts: no ' +
      'DATABASE_URL/POSTGRES_HOST in the environment. Point it at opifex_test ' +
      '(infra/compose/test.compose.yml) to run it.',
  );
}

describeIfDb(
  'OperatorSettingsService write path, against a real database (#339)',
  () => {
    // A non-secret, nullable-integer key: exercises `plainColumns()` and the
    // `Prisma.JsonNull` branch.
    const NON_SECRET_KEY = 'dispatch.maxConcurrent' as const;
    const NON_SECRET_ENV_VAR = OPERATOR_SETTINGS[NON_SECRET_KEY].envVar;

    // A secret string key: exercises `sealedColumns()`.
    const SECRET_KEY = 'github.token' as const;
    const SECRET_ENV_VAR = OPERATOR_SETTINGS[SECRET_KEY].envVar;

    // A boolean key that defaults ON, so "absent reads as the default" and
    // "absent reads as false" are DIFFERENT assertions and the test can only
    // pass for the right reason.
    const BOOLEAN_DEFAULT_TRUE_KEY = 'supervisor.standDownWhenBlocked' as const;
    const BOOLEAN_ENV_VAR = OPERATOR_SETTINGS[BOOLEAN_DEFAULT_TRUE_KEY].envVar;

    const TEST_KEYS = [NON_SECRET_KEY, SECRET_KEY, BOOLEAN_DEFAULT_TRUE_KEY];
    const ENV_VARS = [NON_SECRET_ENV_VAR, SECRET_ENV_VAR, BOOLEAN_ENV_VAR];

    let prisma: PrismaService;
    let service: OperatorSettingsService;
    let originalEncryptionKey: string | undefined;
    const originalEnvValues = new Map<string, string | undefined>();

    beforeAll(() => {
      prisma = new PrismaService();
      service = new OperatorSettingsService(prisma);

      originalEncryptionKey = process.env[ENCRYPTION_KEY_ENV_VAR];
      process.env[ENCRYPTION_KEY_ENV_VAR] = randomBytes(32).toString('base64');

      for (const envVar of ENV_VARS) {
        originalEnvValues.set(envVar, process.env[envVar]);
      }
    });

    afterAll(async () => {
      if (originalEncryptionKey === undefined) {
        delete process.env[ENCRYPTION_KEY_ENV_VAR];
      } else {
        process.env[ENCRYPTION_KEY_ENV_VAR] = originalEncryptionKey;
      }

      for (const [envVar, value] of originalEnvValues) {
        if (value === undefined) delete process.env[envVar];
        else process.env[envVar] = value;
      }

      await cleanupRows();
      await prisma.$disconnect();
    });

    async function cleanupRows(): Promise<void> {
      await prisma.operatorSetting.deleteMany({
        where: { key: { in: TEST_KEYS } },
      });
      await prisma.auditEvent.deleteMany({
        where: { targetType: 'operator_settings', targetId: { in: TEST_KEYS } },
      });
    }

    beforeEach(async () => {
      // Leftover state from a previous crashed run must not leak into this
      // one — every test starts from "no row, no env override" for every key
      // it touches, and refreshes the service's in-memory overlay to match.
      for (const envVar of ENV_VARS) delete process.env[envVar];
      await cleanupRows();
      await service.refresh();
    });

    afterEach(async () => {
      for (const envVar of ENV_VARS) delete process.env[envVar];
      await cleanupRows();
    });

    it('set() on a non-secret key writes a legal row, and get() returns the typed value', async () => {
      await service.set(NON_SECRET_KEY, 5, null);

      const row = await prisma.operatorSetting.findUnique({
        where: { key: NON_SECRET_KEY },
      });

      expect(row).not.toBeNull();
      expect(row!.value).toBe(5);
      expect(row!.secretCiphertext).toBeNull();
      expect(row!.secretIv).toBeNull();
      expect(row!.secretAuthTag).toBeNull();
      expect(row!.secretKeyVersion).toBeNull();

      expect(service.get(NON_SECRET_KEY)).toBe(5);
    });

    it('set() on a secret key writes the ciphertext columns with value NULL, and get() returns the plaintext', async () => {
      const plaintext = `ghp_${randomBytes(12).toString('hex')}`;

      await service.set(SECRET_KEY, plaintext, null);

      const row = await prisma.operatorSetting.findUnique({
        where: { key: SECRET_KEY },
      });

      expect(row).not.toBeNull();
      expect(row!.value).toBeNull();
      expect(row!.secretCiphertext).toEqual(expect.any(String));
      expect(row!.secretIv).toEqual(expect.any(String));
      expect(row!.secretAuthTag).toEqual(expect.any(String));
      expect(row!.secretKeyVersion).toEqual(expect.any(Number));

      expect(service.get(SECRET_KEY)).toBe(plaintext);
    });

    it('never stores the secret plaintext anywhere in the row', async () => {
      const plaintext = `super-secret-${randomBytes(16).toString('hex')}`;

      await service.set(SECRET_KEY, plaintext, null);

      const row = await prisma.operatorSetting.findUnique({
        where: { key: SECRET_KEY },
      });

      expect(row).not.toBeNull();
      // A raw-string search over the whole row, not just the columns the
      // service itself reasons about — the point is that the plaintext does
      // not leak into ANY column, including ones a future change might add.
      expect(JSON.stringify(row)).not.toContain(plaintext);
    });

    it('overwriting a plain-value row with a secret leaves a legal row', async () => {
      // A row this service could never write for a SECRET key by itself
      // (`set()` on a secret key always seals) — it exists here to model the
      // hand-inserted row `resolve()`'s own doc comment describes as legal:
      // "a secret key with a PLAIN row ... can only get there by hand."
      await prisma.operatorSetting.create({
        data: { key: SECRET_KEY, value: 'hand-inserted-plaintext' },
      });

      const newPlaintext = `rotated-${randomBytes(12).toString('hex')}`;
      await service.set(SECRET_KEY, newPlaintext, null);

      const row = await prisma.operatorSetting.findUnique({
        where: { key: SECRET_KEY },
      });

      expect(row).not.toBeNull();
      expect(row!.value).toBeNull();
      expect(row!.secretCiphertext).toEqual(expect.any(String));
      expect(row!.secretIv).toEqual(expect.any(String));
      expect(row!.secretAuthTag).toEqual(expect.any(String));
      expect(row!.secretKeyVersion).toEqual(expect.any(Number));

      expect(service.get(SECRET_KEY)).toBe(newPlaintext);
    });

    it('overwriting a secret-shaped row with a plain value leaves a legal row', async () => {
      // A row `set()` could never produce for a NON-secret key by itself — it
      // exists here to model a hand-inserted (or stale-build) sealed row
      // sitting under a key this build treats as plain.
      await prisma.operatorSetting.create({
        data: {
          key: NON_SECRET_KEY,
          secretCiphertext: 'ciphertext',
          secretIv: 'iv',
          secretAuthTag: 'authTag',
          secretKeyVersion: 1,
        },
      });

      await service.set(NON_SECRET_KEY, 9, null);

      const row = await prisma.operatorSetting.findUnique({
        where: { key: NON_SECRET_KEY },
      });

      expect(row).not.toBeNull();
      expect(row!.value).toBe(9);
      expect(row!.secretCiphertext).toBeNull();
      expect(row!.secretIv).toBeNull();
      expect(row!.secretAuthTag).toBeNull();
      expect(row!.secretKeyVersion).toBeNull();

      expect(service.get(NON_SECRET_KEY)).toBe(9);
    });

    it('clear() deletes the row and the value reverts to the ENVIRONMENT value, not the code default', async () => {
      await service.set(NON_SECRET_KEY, 3, null);

      // Set AFTER the row exists, so the row (not the env var) is what
      // `get()` is reading beforehand — and so this proves the fall-through
      // to `env`, not merely that the env var was already in force.
      process.env[NON_SECRET_ENV_VAR] = '11';

      await service.clear(NON_SECRET_KEY, null);

      const row = await prisma.operatorSetting.findUnique({
        where: { key: NON_SECRET_KEY },
      });
      expect(row).toBeNull();

      // The code default for dispatch.maxConcurrent is `null` — so a bug that
      // fell through past `env` all the way to the default would ALSO not
      // read back as `3`, but it would read back as `null`, not `11`.
      const resolved = service.resolve(NON_SECRET_KEY);
      expect(resolved.value).toBe(11);
      expect(resolved.source).toBe('env');
    });

    it('an absent row does not read as false', async () => {
      // No row (beforeEach already cleared it) and no env override — pure
      // fall-through to the registry default, which for this key is `true`.
      // A resolver that collapsed "absent" to `false` would fail this exact
      // assertion while passing every boolean-default-false key.
      const resolved = service.resolve(BOOLEAN_DEFAULT_TRUE_KEY);

      expect(resolved.source).toBe('default');
      expect(resolved.value).toBe(true);
      expect(resolved.value).not.toBe(false);
    });

    it('bumps the revision counter, with the row write and the bump both present after set()', async () => {
      const before = await prisma.operatorSettingsRevision.findUnique({
        where: { id: 1 },
      });
      expect(before).not.toBeNull();

      const result = await service.set(NON_SECRET_KEY, 42, null);

      const after = await prisma.operatorSettingsRevision.findUnique({
        where: { id: 1 },
      });
      expect(after).not.toBeNull();
      expect(after!.revision).toBe(before!.revision + 1n);
      expect(result.revision).toBe(Number(after!.revision));

      const row = await prisma.operatorSetting.findUnique({
        where: { key: NON_SECRET_KEY },
      });
      expect(row).not.toBeNull();
      expect(row!.value).toBe(42);
    });

    it('setting a nullable key to null round-trips (the Prisma.JsonNull case)', async () => {
      await service.set(NON_SECRET_KEY, null, null);

      // The typed client's own read: JSON `null` and SQL NULL both surface as
      // JS `null` here, so this alone cannot distinguish them — the raw query
      // below is what actually proves which one was written.
      const row = await prisma.operatorSetting.findUnique({
        where: { key: NON_SECRET_KEY },
      });
      expect(row).not.toBeNull();
      expect(row!.value).toBeNull();

      // `Prisma.JsonNull` writes the JSON scalar `null` — `value IS NOT
      // NULL` at the SQL level, and the CHECK constraint requires exactly
      // that for this to be a legal "plain value" row at all. A bare
      // JS `null` would instead write SQL NULL, which `value IS NOT NULL`
      // reports as false and the CHECK constraint refuses outright (neither
      // shape). If `set()` regressed to a bare `null`, this row would not
      // exist at all — the `create`/`upsert` above would have thrown.
      const [raw] = await prisma.$queryRaw<
        Array<{ value_is_sql_null: boolean }>
      >(
        Prisma.sql`SELECT (value IS NULL) AS value_is_sql_null FROM operator_settings WHERE key = ${NON_SECRET_KEY}`,
      );
      expect(raw).toBeDefined();
      expect(raw.value_is_sql_null).toBe(false);

      expect(service.get(NON_SECRET_KEY)).toBeNull();
    });
  },
);
