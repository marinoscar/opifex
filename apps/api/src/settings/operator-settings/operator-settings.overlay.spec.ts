import { BadRequestException, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ENCRYPTION_KEY_ENV_VAR, seal } from '../../common/crypto/secret-box';
import { MASK } from '../../common/crypto/redact';
import type { PrismaService } from '../../prisma/prisma.service';
import {
  OPERATOR_SETTINGS_OVERLAY_UNAVAILABLE,
  OperatorSettingsService,
  type OperatorSettingsChange,
} from './operator-settings.service';

// ---------------------------------------------------------------------------
// A fake database that enforces the constraints the real one does
// ---------------------------------------------------------------------------

interface FakeRow {
  key: string;
  /** Whether the `value` column is anything other than SQL NULL. */
  valuePresent: boolean;
  value: unknown;
  secretCiphertext: string | null;
  secretIv: string | null;
  secretAuthTag: string | null;
  secretKeyVersion: number | null;
  version: number;
  updatedByUserId: string | null;
}

interface FakeAudit {
  actorUserId: string | null;
  action: string;
  targetType: string;
  targetId: string;
  meta: unknown;
}

/**
 * An in-memory stand-in for the two operator-settings tables and
 * `audit_events`.
 *
 * It enforces `operator_settings_value_xor_secret_check` itself, and that is
 * the point of writing one rather than a bag of `jest.fn()`s: a write that set
 * both storage shapes, or neither, would fail at PostgreSQL in production and
 * pass silently against a mock that only records arguments. The two failures a
 * mock cannot catch — a value written as SQL NULL instead of `Prisma.JsonNull`
 * for `dispatch.maxConcurrent`, and a secret-to-plain update leaving its old
 * ciphertext columns behind — are exactly the two this class makes visible.
 *
 * It also records how many `$transaction` calls happened and which client each
 * write went through, which is how the "row write and revision bump share one
 * transaction" requirement is asserted rather than assumed.
 */
class FakePrisma {
  readonly rows = new Map<string, FakeRow>();
  readonly audits: FakeAudit[] = [];
  revision = 0n;

  /** When set, every read and write rejects with this message. */
  down: string | null = null;

  /** How many transactions have been opened. */
  transactionCount = 0;

  /**
   * The client each write was issued through, in order.
   *
   * `'top-level'` for a write outside any transaction, and a distinct `{ tx }`
   * tag per transaction otherwise. This is what makes "the row write and the
   * revision bump share ONE transaction" an assertion rather than a hope: a
   * bump moved out of the callback records `'top-level'` here and the
   * comparison fails, which it could not do if the fake handed the callback
   * itself back as the transaction client.
   */
  readonly writeClients: unknown[] = [];

  /** Rejects the audit insert only, leaving the settings write intact. */
  auditFails = false;

  private txCounter = 0;

  readonly operatorSetting = {
    findMany: (_args: unknown): Promise<FakeRow[]> => this.doFindMany(),
    upsert: (args: UpsertArgs): Promise<FakeRow> =>
      this.doUpsert(args, 'top-level'),
    deleteMany: (args: {
      where: { key: string };
    }): Promise<{ count: number }> => this.doDeleteMany(args, 'top-level'),
  };

  readonly operatorSettingsRevision = {
    findUnique: (_args: unknown): Promise<{ revision: bigint } | null> =>
      this.doFindRevision(),
    update: (_args: unknown): Promise<{ revision: bigint }> =>
      this.doBumpRevision('top-level'),
  };

  readonly auditEvent = {
    create: (args: { data: FakeAudit }): Promise<FakeAudit> => {
      if (this.auditFails) {
        return Promise.reject(new Error('audit table is on fire'));
      }
      if (this.down !== null) return Promise.reject(new Error(this.down));
      this.audits.push(args.data);
      return Promise.resolve(args.data);
    },
  };

  $transaction<T>(
    work: Promise<unknown>[] | ((tx: unknown) => Promise<T>),
  ): Promise<T | unknown[]> {
    this.transactionCount += 1;

    if (Array.isArray(work)) {
      return Promise.all(work);
    }

    const tag = { tx: ++this.txCounter };

    return work({
      operatorSetting: {
        findMany: (_args: unknown) => this.doFindMany(),
        upsert: (args: UpsertArgs) => this.doUpsert(args, tag),
        deleteMany: (args: { where: { key: string } }) =>
          this.doDeleteMany(args, tag),
      },
      operatorSettingsRevision: {
        findUnique: (_args: unknown) => this.doFindRevision(),
        update: (_args: unknown) => this.doBumpRevision(tag),
      },
    });
  }

  asPrisma(): PrismaService {
    return this as unknown as PrismaService;
  }

  private doFindMany(): Promise<FakeRow[]> {
    if (this.down !== null) return Promise.reject(new Error(this.down));
    return Promise.resolve([...this.rows.values()]);
  }

  private doFindRevision(): Promise<{ revision: bigint } | null> {
    if (this.down !== null) return Promise.reject(new Error(this.down));
    return Promise.resolve({ revision: this.revision });
  }

  private doUpsert(args: UpsertArgs, client: unknown): Promise<FakeRow> {
    if (this.down !== null) return Promise.reject(new Error(this.down));
    this.writeClients.push(client);

    const existing = this.rows.get(args.where.key);
    const row: FakeRow = existing
      ? {
          ...existing,
          ...applyColumns(args.update),
          version: existing.version + 1,
        }
      : {
          key: args.where.key,
          version: 1,
          updatedByUserId: null,
          ...blankColumns(),
          ...applyColumns(args.create),
        };

    assertValueXorSecret(row);
    this.rows.set(row.key, row);
    return Promise.resolve(row);
  }

  private doDeleteMany(
    args: { where: { key: string } },
    client: unknown,
  ): Promise<{ count: number }> {
    if (this.down !== null) return Promise.reject(new Error(this.down));
    this.writeClients.push(client);
    const had = this.rows.delete(args.where.key);
    return Promise.resolve({ count: had ? 1 : 0 });
  }

  private doBumpRevision(client: unknown): Promise<{ revision: bigint }> {
    if (this.down !== null) return Promise.reject(new Error(this.down));
    this.writeClients.push(client);
    this.revision += 1n;
    return Promise.resolve({ revision: this.revision });
  }
}

interface UpsertArgs {
  where: { key: string };
  create: Record<string, unknown>;
  update: Record<string, unknown>;
}

function blankColumns() {
  return {
    valuePresent: false,
    value: null as unknown,
    secretCiphertext: null,
    secretIv: null,
    secretAuthTag: null,
    secretKeyVersion: null,
  };
}

/**
 * Translates Prisma's two JSON null sentinels the way PostgreSQL sees them:
 * `Prisma.DbNull` is SQL NULL (no value), `Prisma.JsonNull` is the JSON scalar
 * `null` (a value, and `IS NOT NULL`). Collapsing them is precisely the bug
 * that would make `dispatch.maxConcurrent = null` violate the CHECK.
 */
function applyColumns(data: Record<string, unknown>) {
  const out: Partial<FakeRow> = {};

  if ('value' in data) {
    if (data.value === Prisma.DbNull) {
      out.valuePresent = false;
      out.value = null;
    } else if (data.value === Prisma.JsonNull) {
      out.valuePresent = true;
      out.value = null;
    } else if (data.value === null) {
      // What Prisma itself does with a bare `null` on a `Json?` field: it
      // refuses, because `null` is ambiguous between the JSON scalar and SQL
      // NULL. Reproduced rather than accepted, so a write that reaches for the
      // convenient spelling fails here instead of at runtime.
      throw new Error(
        'Argument `value`: a bare null is ambiguous on a Json field; use ' +
          'Prisma.JsonNull or Prisma.DbNull.',
      );
    } else {
      out.valuePresent = true;
      out.value = data.value;
    }
  }

  for (const column of [
    'secretCiphertext',
    'secretIv',
    'secretAuthTag',
    'secretKeyVersion',
  ] as const) {
    if (column in data) {
      (out as Record<string, unknown>)[column] = data[column];
    }
  }

  if ('updatedByUserId' in data) {
    out.updatedByUserId = data.updatedByUserId as string | null;
  }

  return out;
}

/** `operator_settings_value_xor_secret_check`, in TypeScript. */
function assertValueXorSecret(row: FakeRow): void {
  const secretColumns = [
    row.secretCiphertext,
    row.secretIv,
    row.secretAuthTag,
    row.secretKeyVersion,
  ];
  const wholeSecret = secretColumns.every((column) => column !== null);
  const noSecret = secretColumns.every((column) => column === null);

  const legal =
    (row.valuePresent && noSecret) || (!row.valuePresent && wholeSecret);

  if (!legal) {
    throw new Error(
      `operator_settings_value_xor_secret_check violated for "${row.key}": ` +
        `valuePresent=${String(row.valuePresent)}, secret columns=` +
        JSON.stringify(secretColumns),
    );
  }
}

/**
 * The real service with one seam moved: only `environment()` is replaced, so
 * the overlay, the write path, the parse path and the logging under test are
 * all the production ones.
 */
class TestOperatorSettingsService extends OperatorSettingsService {
  constructor(
    prisma: PrismaService | undefined,
    private readonly fixture: NodeJS.ProcessEnv,
  ) {
    super(prisma);
  }

  protected override environment(): NodeJS.ProcessEnv {
    return this.fixture;
  }
}

/** 32 bytes of nothing in particular, base64. Two different keys. */
const KEY_A = Buffer.alloc(32, 7).toString('base64');
const KEY_B = Buffer.alloc(32, 9).toString('base64');

function makeService(
  options: {
    prisma?: FakePrisma;
    env?: NodeJS.ProcessEnv;
  } = {},
): { settings: OperatorSettingsService; prisma: FakePrisma } {
  const prisma = options.prisma ?? new FakePrisma();
  const settings = new TestOperatorSettingsService(
    prisma.asPrisma(),
    options.env ?? {},
  );
  return { settings, prisma };
}

describe('OperatorSettingsService: the database overlay (#339)', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    process.env[ENCRYPTION_KEY_ENV_VAR] = KEY_A;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env[ENCRYPTION_KEY_ENV_VAR];
  });

  // -------------------------------------------------------------------------
  // Resolution order
  // -------------------------------------------------------------------------

  describe('resolution: default -> env -> database row', () => {
    it('lets a row win over the environment', async () => {
      const { settings, prisma } = makeService({
        env: { DISPATCH_MAX_CONCURRENT: '2' },
      });
      storeValue(prisma, 'dispatch.maxConcurrent', 9);

      await settings.refresh();

      expect(settings.get('dispatch.maxConcurrent')).toBe(9);
      expect(settings.resolve('dispatch.maxConcurrent').source).toBe(
        'database',
      );
    });

    it('falls through to the environment when there is NO row — an absent row is not `false`', async () => {
      // The acceptance criterion this issue was filed for. `reconciler.enabled`
      // defaults to false and the environment turns it on; a lookup that read
      // "no row" as a value would resolve it back off, silently, and the
      // reconciler would simply never tick.
      const { settings } = makeService({ env: { RECONCILER_ENABLED: 'true' } });

      await settings.refresh();

      expect(settings.get('reconciler.enabled')).toBe(true);
      expect(settings.resolve('reconciler.enabled').source).toBe('env');
    });

    it('falls all the way through to the declared default when neither layer has anything', async () => {
      const { settings } = makeService();

      await settings.refresh();

      expect(settings.get('supervisor.standDownWhenBlocked')).toBe(true);
      expect(settings.resolve('supervisor.standDownWhenBlocked').source).toBe(
        'default',
      );
    });

    it('parses a JSON row through the registry, so `true` and "true" agree', async () => {
      const { settings, prisma } = makeService();
      storeValue(prisma, 'dispatch.enabled', true);

      await settings.refresh();

      const value = settings.get('dispatch.enabled');
      expect(value).toBe(true);
      expect(typeof value).toBe('boolean');
    });

    it('falls back to the default, not to the environment, when a row will not parse', async () => {
      const { settings, prisma } = makeService({
        env: { RECONCILER_INTERVAL_MS: '30000' },
      });
      storeValue(prisma, 'reconciler.intervalMs', 'whenever');

      await settings.refresh();

      const resolved = settings.resolve('reconciler.intervalMs');
      expect(resolved.value).toBe(60_000);
      expect(resolved.source).toBe('default');
      expect(resolved.invalid?.source).toBe('database');
    });

    it('ignores a row for a key this build does not know', async () => {
      const { settings, prisma } = makeService();
      storeValue(prisma, 'settings.fromTheFuture', 42);

      await expect(settings.refresh()).resolves.toMatchObject({
        status: 'loaded',
        overriddenKeys: 0,
      });
      expect(warn.mock.calls.flat().join(' ')).toContain(
        'settings.fromTheFuture',
      );
    });
  });

  // -------------------------------------------------------------------------
  // Boot without a database
  // -------------------------------------------------------------------------

  describe('booting without a database', () => {
    it('keeps env values in force and reports `unavailable`, then recovers on the next refresh', async () => {
      const prisma = new FakePrisma();
      prisma.down = "Can't reach database server at 127.0.0.1:5432";
      const { settings } = makeService({
        prisma,
        env: { DISPATCH_MAX_CONCURRENT: '3' },
      });

      await settings.onModuleInit();

      // Env is in force, and the service SAYS so rather than resolving
      // silently — the whole point of the status being a value.
      expect(settings.get('dispatch.maxConcurrent')).toBe(3);
      const failed = settings.overlay();
      expect(failed.status).toBe('unavailable');
      expect(failed.warning).toBe(OPERATOR_SETTINGS_OVERLAY_UNAVAILABLE);
      expect(failed.problem).toContain("Can't reach database server");
      expect(failed.loadedAt).toBeNull();
      // Not stale: there is no overlay at all, which is a different fact from
      // an overlay that loaded once and may now be out of date.
      expect(failed.stale).toBe(false);
      expect(failed.revision).toBeNull();

      // The database comes back, with an override in it.
      prisma.down = null;
      storeValue(prisma, 'dispatch.maxConcurrent', 11);
      prisma.revision = 4n;

      const recovered = await settings.refresh();

      expect(recovered.status).toBe('loaded');
      expect(recovered.warning).toBeUndefined();
      expect(recovered.problem).toBeUndefined();
      expect(recovered.loadedAt).toBeInstanceOf(Date);
      expect(recovered.revision).toBe(4);
      expect(settings.get('dispatch.maxConcurrent')).toBe(11);
    });

    it('says so when the overlay comes back, and warns again if it goes away twice', async () => {
      // The once-per-reason rule would otherwise swallow every outage after
      // the first, so an overlay that flaps would go quiet.
      const log = jest
        .spyOn(Logger.prototype, 'log')
        .mockImplementation(() => undefined);
      const prisma = new FakePrisma();
      prisma.down = 'connection refused';
      const { settings } = makeService({ prisma });
      await settings.onModuleInit();
      expect(warn).toHaveBeenCalledTimes(1);

      prisma.down = null;
      await settings.refresh();
      expect(log.mock.calls.flat().join(' ')).toContain('readable again');

      prisma.down = 'connection refused again';
      await settings.refresh();

      expect(warn).toHaveBeenCalledTimes(2);
    });

    it('names the warning in the log too, so a boot without one is diagnosable', async () => {
      const prisma = new FakePrisma();
      prisma.down = 'connection refused';
      const { settings } = makeService({ prisma });

      await settings.onModuleInit();

      const logged = warn.mock.calls.flat().join(' ');
      expect(logged).toContain(OPERATOR_SETTINGS_OVERLAY_UNAVAILABLE);
      expect(logged).toContain('NO stored override is applied');
    });

    it('keeps the last loaded overlay when a LATER refresh fails, and says it is stale', async () => {
      // A transient blip — the shared external PostgreSQL container being
      // restarted by somebody else — must not silently revert every override
      // to its env value mid-flight. That would be a configuration change
      // nobody made.
      const { settings, prisma } = makeService({
        env: { DISPATCH_MAX_CONCURRENT: '3' },
      });
      storeValue(prisma, 'dispatch.maxConcurrent', 11);
      await settings.refresh();

      prisma.down = 'connection reset by peer';
      const state = await settings.refresh();

      expect(state.status).toBe('unavailable');
      expect(state.stale).toBe(true);
      expect(state.loadedAt).toBeInstanceOf(Date);
      expect(settings.get('dispatch.maxConcurrent')).toBe(11);
    });

    it('reports unavailable rather than throwing when no database client is wired at all', async () => {
      const settings = new TestOperatorSettingsService(undefined, {
        DISPATCH_ENABLED: 'true',
      });

      await settings.onModuleInit();

      expect(settings.overlay().status).toBe('unavailable');
      expect(settings.get('dispatch.enabled')).toBe(true);
      await expect(
        settings.set('dispatch.enabled', false, null),
      ).rejects.toThrow(/wiring bug/);
    });
  });

  // -------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------

  describe('set()', () => {
    it('stores a non-secret value and puts it in force immediately', async () => {
      const { settings, prisma } = makeService({
        env: { DISPATCH_MAX_CONCURRENT: '3' },
      });
      await settings.refresh();

      const result = await settings.set('dispatch.maxConcurrent', 7, 'user-1');

      expect(result.changed).toBe(true);
      expect(result.resolved.value).toBe(7);
      expect(result.resolved.source).toBe('database');
      expect(settings.get('dispatch.maxConcurrent')).toBe(7);
      expect(prisma.rows.get('dispatch.maxConcurrent')).toMatchObject({
        valuePresent: true,
        value: 7,
        updatedByUserId: 'user-1',
        secretCiphertext: null,
      });
    });

    it('stores a null ceiling as a JSON null, not as SQL NULL', async () => {
      // SQL NULL in `value` with no ciphertext group is a row with NEITHER
      // storage shape, which `operator_settings_value_xor_secret_check`
      // refuses — the FakePrisma above enforces the same rule, so getting this
      // wrong fails here rather than in production.
      const { settings, prisma } = makeService({
        env: { DISPATCH_MAX_CONCURRENT: '3' },
      });
      await settings.refresh();

      await settings.set('dispatch.maxConcurrent', null, 'user-1');

      expect(prisma.rows.get('dispatch.maxConcurrent')).toMatchObject({
        valuePresent: true,
        value: null,
      });
      expect(settings.get('dispatch.maxConcurrent')).toBeNull();
      expect(settings.resolve('dispatch.maxConcurrent').source).toBe(
        'database',
      );
    });

    it('accepts the environment string form and the JSON form identically', async () => {
      const { settings, prisma } = makeService();
      await settings.refresh();

      await settings.set('dispatch.enabled', 'true', null);
      expect(settings.get('dispatch.enabled')).toBe(true);
      expect(prisma.rows.get('dispatch.enabled')?.value).toBe(true);

      await settings.set('dispatch.enabled', false, null);
      expect(settings.get('dispatch.enabled')).toBe(false);
    });

    it('refuses a value the registry rejects, and writes nothing', async () => {
      const { settings, prisma } = makeService();
      await settings.refresh();

      await expect(
        settings.set('reconciler.intervalMs', 'soon', null),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.rows.size).toBe(0);
      expect(prisma.revision).toBe(0n);
    });

    it('never echoes a rejected SECRET back in the error message', async () => {
      // A 400 body and the log line behind it are both places a mistyped
      // credential would otherwise come to rest in the clear.
      const { settings } = makeService();
      await settings.refresh();

      // An ARRAY, deliberately: every string parses for a secret key (they all
      // allow empty), and `String({...})` is '[object Object]', which would
      // make this assertion pass no matter what the message said.
      // `String(['ghp_...'])` is the credential itself.
      await expect(
        settings.set('github.token', ['ghp_thewholewrongthing'], null),
      ).rejects.toThrow(
        expect.objectContaining({
          message: expect.not.stringContaining('ghp_thewholewrongthing'),
        }) as Error,
      );
    });

    it('still echoes a rejected NON-secret, because that is most of the diagnosis', async () => {
      const { settings } = makeService();
      await settings.refresh();

      await expect(
        settings.set('reconciler.intervalMs', 'soonish', null),
      ).rejects.toThrow(/soonish/);
    });

    it('refuses a key that is not in the registry', async () => {
      const { settings } = makeService();
      await expect(
        settings.set('nope.notAKey' as never, 1, null),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('bumps the collection revision in the SAME transaction as the row write', async () => {
      // `If-Match` is checked against this counter. If the row write and the
      // bump were two transactions, a reader between them would see a revision
      // that does not describe the rows it is meant to version, and its
      // conditional write would be validated against a state that never
      // existed.
      const { settings, prisma } = makeService();
      await settings.refresh();

      const before = prisma.transactionCount;
      prisma.writeClients.length = 0;

      const result = await settings.set('dispatch.enabled', true, null);

      // The upsert and the revision update, both through the same
      // transaction client — and neither through the top-level one.
      expect(prisma.writeClients).toHaveLength(2);
      expect(prisma.writeClients[0]).toBe(prisma.writeClients[1]);
      expect(prisma.writeClients).not.toContain('top-level');
      // One transaction for the write; the second is the refresh that follows.
      expect(prisma.transactionCount).toBe(before + 2);
      expect(prisma.revision).toBe(1n);
      expect(result.revision).toBe(1);
    });

    it('re-reads the overlay after the write, so the next read is not the loop away', async () => {
      const { settings, prisma } = makeService();
      await settings.refresh();
      const loadedAt = settings.overlay().loadedAt;

      await settings.set('github.maxRetries', 5, null);

      expect(settings.overlay().status).toBe('loaded');
      expect(settings.overlay().loadedAt).not.toBe(loadedAt);
      expect(settings.overlay().revision).toBe(1);
      expect(prisma.rows.size).toBe(1);
    });

    it('announces the change on the emitter', async () => {
      const { settings } = makeService();
      await settings.refresh();
      const seen: OperatorSettingsChange[] = [];
      settings.onChange((change) => seen.push(change));

      await settings.set('dispatch.enabled', true, null);

      expect(seen).toHaveLength(1);
      expect(seen[0]?.keys).toEqual(['dispatch.enabled']);
    });

    it('announces a write that stored the value already there, exactly once', async () => {
      // The overlay diff correctly reports no change, because nothing moved.
      // A caller that asked for a write is still owed the event — and must not
      // get two.
      const { settings } = makeService();
      await settings.refresh();
      await settings.set('github.maxRetries', 5, null);

      const seen: OperatorSettingsChange[] = [];
      settings.onChange((change) => seen.push(change));

      await settings.set('github.maxRetries', 5, null);

      expect(seen).toHaveLength(1);
      expect(seen[0]?.keys).toEqual(['github.maxRetries']);
    });
  });

  // -------------------------------------------------------------------------
  // Clearing
  // -------------------------------------------------------------------------

  describe('clear()', () => {
    it('removes the row so the value reverts to the ENVIRONMENT, not to the default', async () => {
      // ADR-0018 §2: an operator who set DISPATCH_MAX_CONCURRENT=3 outside the
      // running system, then overrode it to 11 in the UI, then cleared the
      // override, gets 3 back — not the code's own default. The env layer is a
      // real choice they already made and a revert must not erase it.
      const { settings, prisma } = makeService({
        env: { DISPATCH_MAX_CONCURRENT: '3' },
      });
      await settings.set('dispatch.maxConcurrent', 11, 'user-1');
      expect(settings.get('dispatch.maxConcurrent')).toBe(11);

      const result = await settings.clear('dispatch.maxConcurrent', 'user-1');

      expect(result.changed).toBe(true);
      expect(prisma.rows.size).toBe(0);
      expect(settings.get('dispatch.maxConcurrent')).toBe(3);
      expect(settings.resolve('dispatch.maxConcurrent').source).toBe('env');
    });

    it('reverts all the way to the declared default when the environment is silent', async () => {
      const { settings } = makeService();
      await settings.set('reconciler.intervalMs', 5_000, null);

      await settings.clear('reconciler.intervalMs', null);

      expect(settings.get('reconciler.intervalMs')).toBe(60_000);
      expect(settings.resolve('reconciler.intervalMs').source).toBe('default');
    });

    it('bumps the revision in the same transaction as the delete', async () => {
      const { settings, prisma } = makeService();
      await settings.set('dispatch.enabled', true, null);
      prisma.writeClients.length = 0;

      const result = await settings.clear('dispatch.enabled', null);

      expect(prisma.writeClients).toHaveLength(2);
      expect(prisma.writeClients[0]).toBe(prisma.writeClients[1]);
      expect(prisma.writeClients).not.toContain('top-level');
      expect(result.revision).toBe(2);
      expect(prisma.revision).toBe(2n);
    });

    it('does nothing, and bumps nothing, for a key with no row', async () => {
      // Reporting a new revision for a delete that deleted nothing would
      // invalidate every outstanding `If-Match` to describe a change that did
      // not happen.
      const { settings, prisma } = makeService();
      await settings.refresh();
      const seen: OperatorSettingsChange[] = [];
      settings.onChange((change) => seen.push(change));

      const result = await settings.clear('dispatch.enabled', null);

      expect(result.changed).toBe(false);
      expect(result.revision).toBe(0);
      expect(prisma.revision).toBe(0n);
      expect(prisma.audits).toHaveLength(0);
      expect(seen).toHaveLength(0);
    });

    it('announces the change on the emitter', async () => {
      const { settings } = makeService();
      await settings.set('dispatch.enabled', true, null);
      const seen: OperatorSettingsChange[] = [];
      settings.onChange((change) => seen.push(change));

      await settings.clear('dispatch.enabled', null);

      expect(seen).toHaveLength(1);
      expect(seen[0]?.keys).toEqual(['dispatch.enabled']);
    });
  });

  // -------------------------------------------------------------------------
  // Secrets
  // -------------------------------------------------------------------------

  describe('secrets', () => {
    const TOKEN = 'ghp_averyrealisticlookinggithubtoken';

    it('seals a secret into the ciphertext columns and leaves `value` SQL NULL', async () => {
      const { settings, prisma } = makeService();
      await settings.refresh();

      await settings.set('github.token', TOKEN, 'user-1');

      const row = prisma.rows.get('github.token');
      expect(row?.valuePresent).toBe(false);
      expect(row?.secretCiphertext).toEqual(expect.any(String));
      expect(row?.secretIv).toEqual(expect.any(String));
      expect(row?.secretAuthTag).toEqual(expect.any(String));
      expect(row?.secretKeyVersion).toBe(1);
      // The credential itself is nowhere in the row.
      expect(JSON.stringify(row)).not.toContain(TOKEN);
    });

    it('decrypts a stored secret on the read path', async () => {
      const { settings, prisma } = makeService({
        env: { GITHUB_TOKEN: 'ghp_theoldrotatedawaytoken' },
      });
      await settings.set('github.token', TOKEN, null);

      expect(settings.get('github.token')).toBe(TOKEN);
      expect(settings.resolve('github.token').source).toBe('database');
      expect(prisma.rows.get('github.token')?.secretCiphertext).toBeTruthy();
    });

    it('falls through to the environment when NO secret is stored', async () => {
      const { settings } = makeService({
        env: { GITHUB_TOKEN: 'ghp_fromtheenvironment' },
      });
      await settings.refresh();

      expect(settings.get('github.token')).toBe('ghp_fromtheenvironment');
      expect(settings.resolve('github.token').source).toBe('env');
    });

    it('clears a secret when it is set to the empty string', async () => {
      // `seal` refuses an empty plaintext, because a credential of length zero
      // that opens successfully is a second representation of "no secret".
      const { settings, prisma } = makeService({
        env: { GITHUB_TOKEN: 'ghp_fromtheenvironment' },
      });
      await settings.set('github.token', TOKEN, null);

      const result = await settings.set('github.token', '', null);

      expect(result.changed).toBe(true);
      expect(prisma.rows.size).toBe(0);
      expect(settings.get('github.token')).toBe('ghp_fromtheenvironment');
    });

    it('seals over a hand-inserted PLAIN row on a secret key, nulling `value`', async () => {
      // Reachable only by hand — `set()` always seals — but the update path
      // has to null the column it is not writing, or the row ends up with
      // BOTH shapes and `operator_settings_value_xor_secret_check` refuses it.
      const { settings, prisma } = makeService();
      storeValue(prisma, 'github.token', 'ghp_pastedstraightintopostgres');
      await settings.refresh();
      // It is in force, and said out loud, rather than being silently ignored.
      expect(settings.get('github.token')).toBe(
        'ghp_pastedstraightintopostgres',
      );
      expect(warn.mock.calls.flat().join(' ')).toContain(
        'stores a plain value',
      );

      await settings.set('github.token', TOKEN, null);

      const row = prisma.rows.get('github.token') as FakeRow;
      expect(row.valuePresent).toBe(false);
      expect(row.secretCiphertext).toEqual(expect.any(String));
      expect(() => assertValueXorSecret(row)).not.toThrow();
      expect(settings.get('github.token')).toBe(TOKEN);
    });

    it('writes a plain value over a hand-inserted CIPHERTEXT row, nulling the secret group', async () => {
      // The mirror case, and the reason `plainColumns` nulls all four columns
      // explicitly rather than by omission: an upsert leaves the columns it
      // does not name, so a row that used to hold a ciphertext would keep it
      // alongside the new `value` — both shapes at once, which the database
      // refuses.
      const { settings, prisma } = makeService();
      const sealed = seal('ghp_wherethisdoesnotbelong', 'dispatch.enabled');
      prisma.rows.set('dispatch.enabled', {
        key: 'dispatch.enabled',
        ...blankColumns(),
        secretCiphertext: sealed.ciphertext,
        secretIv: sealed.iv,
        secretAuthTag: sealed.authTag,
        secretKeyVersion: sealed.keyVersion,
        version: 1,
        updatedByUserId: null,
      });
      await settings.refresh();

      await settings.set('dispatch.enabled', true, null);

      const row = prisma.rows.get('dispatch.enabled') as FakeRow;
      expect(row.valuePresent).toBe(true);
      expect(row.value).toBe(true);
      expect(row.secretCiphertext).toBeNull();
      expect(row.secretIv).toBeNull();
      expect(row.secretAuthTag).toBeNull();
      expect(row.secretKeyVersion).toBeNull();
      expect(() => assertValueXorSecret(row)).not.toThrow();
      expect(settings.get('dispatch.enabled')).toBe(true);
    });

    it('replaces a stored secret with a fresh one without violating the CHECK', async () => {
      // The update path has to null the columns it is not writing. Leaving the
      // old ciphertext behind next to a new `value` is a row with BOTH shapes,
      // which the database refuses — and which a jest.fn() mock would happily
      // accept.
      const { settings, prisma } = makeService();
      await settings.set('github.token', TOKEN, null);

      await settings.set('supervisor.model.name', 'claude-opus-4', null);
      // And the reverse direction, on the same key.
      await settings.set('github.token', 'ghp_asecondtokenentirely', null);

      const row = prisma.rows.get('github.token');
      expect(row?.valuePresent).toBe(false);
      expect(() => assertValueXorSecret(row as FakeRow)).not.toThrow();
    });

    it('marks a key that will not decrypt as `error`, and NEVER falls back to the environment', async () => {
      // The failure this whole separation exists for. An operator rotated the
      // GitHub token, stored the new one, and the row later fails to open
      // under a restored or mismatched key. Falling back to
      // `process.env.GITHUB_TOKEN` would silently resurrect the OLD token, and
      // every call would keep working — which is exactly why nobody would
      // look.
      const { settings, prisma } = makeService({
        env: { GITHUB_TOKEN: 'ghp_theoldrotatedawaytoken' },
      });
      await settings.set('github.token', TOKEN, null);
      expect(settings.get('github.token')).toBe(TOKEN);

      // The data key changes underneath the stored row.
      process.env[ENCRYPTION_KEY_ENV_VAR] = KEY_B;
      await settings.refresh();

      const resolved = settings.resolve('github.token');
      expect(resolved.error?.reason).toBe('decrypt_failed');
      expect(resolved.value).toBe('');
      expect(resolved.source).toBe('default');
      // The specific thing that must not happen.
      expect(resolved.value).not.toBe('ghp_theoldrotatedawaytoken');
      expect(settings.get('github.token')).not.toBe(
        'ghp_theoldrotatedawaytoken',
      );
      expect(prisma.rows.get('github.token')?.secretCiphertext).toBeTruthy();
    });

    it('marks a key `error` when the data key is missing entirely', async () => {
      const { settings } = makeService({
        env: { GITHUB_TOKEN: 'ghp_theoldrotatedawaytoken' },
      });
      await settings.set('github.token', TOKEN, null);

      delete process.env[ENCRYPTION_KEY_ENV_VAR];
      await settings.refresh();

      const resolved = settings.resolve('github.token');
      expect(resolved.error?.reason).toBe('key_unavailable');
      expect(resolved.value).toBe('');
    });

    it('refuses a ciphertext moved into a different setting slot', async () => {
      // The AAD is the setting key. Without it a row is a portable blob and
      // anyone who can write the table can put the GitHub token to work as the
      // supervisor's API key.
      const { settings, prisma } = makeService();
      await settings.set('github.token', TOKEN, null);
      const stolen = prisma.rows.get('github.token') as FakeRow;
      prisma.rows.set('models.anthropic.apiKey', {
        ...stolen,
        key: 'models.anthropic.apiKey',
      });

      await settings.refresh();

      expect(settings.resolve('models.anthropic.apiKey').error?.reason).toBe(
        'decrypt_failed',
      );
      expect(settings.get('models.anthropic.apiKey')).toBe('');
    });
  });

  // -------------------------------------------------------------------------
  // Audit
  // -------------------------------------------------------------------------

  describe('the audit row', () => {
    it('records `{ key, from, to }` for the one key, and not the whole document', async () => {
      const { settings, prisma } = makeService({
        env: { DISPATCH_MAX_CONCURRENT: '3' },
      });
      await settings.set('github.maxRetries', 5, 'user-1');
      prisma.audits.length = 0;

      await settings.set('dispatch.maxConcurrent', 11, 'user-1');

      expect(prisma.audits).toHaveLength(1);
      const [event] = prisma.audits;
      expect(event).toMatchObject({
        actorUserId: 'user-1',
        action: 'operator_settings:set',
        targetType: 'operator_settings',
        targetId: 'dispatch.maxConcurrent',
      });
      expect(event.meta).toMatchObject({
        key: 'dispatch.maxConcurrent',
        from: 3,
        to: 11,
        fromSource: 'env',
        toSource: 'database',
      });
      // The other key that has a row is NOT in it.
      expect(JSON.stringify(event.meta)).not.toContain('github.maxRetries');
    });

    it('records the revert on a clear', async () => {
      const { settings, prisma } = makeService({
        env: { DISPATCH_MAX_CONCURRENT: '3' },
      });
      await settings.set('dispatch.maxConcurrent', 11, 'user-1');
      prisma.audits.length = 0;

      await settings.clear('dispatch.maxConcurrent', 'user-2');

      expect(prisma.audits[0]).toMatchObject({
        actorUserId: 'user-2',
        action: 'operator_settings:clear',
        targetId: 'dispatch.maxConcurrent',
        meta: { from: 11, to: 3, toSource: 'env' },
      });
    });

    it("never writes a sealed secret's plaintext, in any field, on either side", async () => {
      // The audit log is the one table nobody is allowed to go back and
      // rewrite: a redaction added after the fact protects the next write and
      // none of the ones already on disk.
      const OLD = 'ghp_theoriginaltokenbeingrotated';
      const NEW = 'ghp_thereplacementtokenjustpasted';

      const { settings, prisma } = makeService({ env: { GITHUB_TOKEN: OLD } });
      await settings.refresh();

      await settings.set('github.token', NEW, 'user-1');

      const serialised = JSON.stringify(prisma.audits);
      expect(serialised).not.toContain(NEW);
      expect(serialised).not.toContain(OLD);
      expect(prisma.audits[0]?.meta).toMatchObject({
        key: 'github.token',
        from: expect.stringContaining(MASK),
        to: expect.stringContaining(MASK),
      });
    });

    it("never writes a cleared secret's plaintext either", async () => {
      const TOKEN = 'ghp_thetokenbeingremovedrightnow';
      const { settings, prisma } = makeService();
      await settings.set('github.token', TOKEN, 'user-1');
      prisma.audits.length = 0;

      await settings.clear('github.token', 'user-1');

      expect(JSON.stringify(prisma.audits)).not.toContain(TOKEN);
      expect(prisma.audits[0]?.meta).toMatchObject({
        from: expect.stringContaining(MASK),
      });
    });

    it('leaves a non-secret value readable, because that is what an audit log is for', async () => {
      const { settings, prisma } = makeService();
      await settings.set('supervisor.model.name', 'claude-opus-4', null);

      expect(prisma.audits[0]?.meta).toMatchObject({ to: 'claude-opus-4' });
    });

    it('records a spend ceiling change, because that is now a security-relevant operation', async () => {
      // #345's acceptance criterion, and the one property that partly
      // compensates for what ADR-0018 §6 gave up. Until #345 there was nothing
      // to audit: the ceiling could not move inside a running process at all.
      // Now it can, and the whole access-controlled guarantee rests on a
      // change being attributable — so a raise that left no row would be
      // indistinguishable from a ceiling nobody touched.
      const { settings, prisma } = makeService({
        env: { OPIFEX_HARD_SPEND_CEILING_USD: '25' },
      });
      await settings.refresh();
      prisma.audits.length = 0;

      await settings.set('dispatch.hardSpendCeilingUsd', '5000', 'admin-1');

      expect(prisma.audits).toHaveLength(1);
      expect(prisma.audits[0]).toMatchObject({
        actorUserId: 'admin-1',
        action: 'operator_settings:set',
        targetType: 'operator_settings',
        targetId: 'dispatch.hardSpendCeilingUsd',
      });
      // The figures themselves, in the clear, on both sides. A ceiling is not
      // a credential: an audit row that masked it would record that somebody
      // changed the budget without recording what they changed it to, which is
      // the half that matters.
      expect(prisma.audits[0].meta).toMatchObject({
        key: 'dispatch.hardSpendCeilingUsd',
        from: '25',
        to: '5000',
        fromSource: 'env',
        toSource: 'database',
      });
    });

    it('records the supervisor ceiling and a revert to the environment too', async () => {
      const { settings, prisma } = makeService({
        env: { SUPERVISOR_HARD_SPEND_CEILING_USD: '5' },
      });
      await settings.set('supervisor.hardSpendCeilingUsd', '50', 'admin-1');
      prisma.audits.length = 0;

      await settings.clear('supervisor.hardSpendCeilingUsd', 'admin-1');

      expect(prisma.audits).toHaveLength(1);
      expect(prisma.audits[0]).toMatchObject({
        action: 'operator_settings:clear',
        targetId: 'supervisor.hardSpendCeilingUsd',
      });
      expect(prisma.audits[0].meta).toMatchObject({
        from: '50',
        to: '5',
        toSource: 'env',
      });
    });

    it('does not fail the write when the audit row cannot be written', async () => {
      // The change is already committed and in force. Answering 500 would tell
      // the operator it did not apply, which is false — and is the more
      // dangerous of the two lies.
      const error = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      const { settings, prisma } = makeService();
      await settings.refresh();
      prisma.auditFails = true;

      await expect(
        settings.set('dispatch.enabled', true, null),
      ).resolves.toMatchObject({ changed: true });
      expect(settings.get('dispatch.enabled')).toBe(true);
      expect(error.mock.calls.flat().join(' ')).toContain(
        'operator_settings:set',
      );
    });
  });

  // -------------------------------------------------------------------------
  // The refresh loop's own behaviour
  // -------------------------------------------------------------------------

  describe('refresh()', () => {
    it('announces only the keys that actually moved', async () => {
      const { settings, prisma } = makeService();
      storeValue(prisma, 'dispatch.enabled', true);
      storeValue(prisma, 'github.maxRetries', 5);
      await settings.refresh();

      const seen: OperatorSettingsChange[] = [];
      settings.onChange((change) => seen.push(change));

      // Another replica writes one key and deletes another.
      storeValue(prisma, 'github.maxRetries', 9);
      prisma.rows.delete('dispatch.enabled');
      storeValue(prisma, 'reconciler.enabled', true);

      await settings.refresh();

      expect(seen).toHaveLength(1);
      expect([...(seen[0]?.keys ?? [])].sort()).toEqual([
        'dispatch.enabled',
        'github.maxRetries',
        'reconciler.enabled',
      ]);
    });

    it('says nothing when nothing moved', async () => {
      const { settings, prisma } = makeService();
      storeValue(prisma, 'dispatch.enabled', true);
      await settings.refresh();

      const listener = jest.fn();
      settings.onChange(listener);
      await settings.refresh();

      expect(listener).not.toHaveBeenCalled();
    });

    it('picks up a change another replica made, which is what bounds staleness', async () => {
      const { settings, prisma } = makeService();
      await settings.refresh();
      expect(settings.get('dispatch.enabled')).toBe(false);

      storeValue(prisma, 'dispatch.enabled', true);
      prisma.revision = 7n;
      await settings.refresh();

      expect(settings.get('dispatch.enabled')).toBe(true);
      expect(settings.overlay().revision).toBe(7);
    });

    it('reads the rows and the revision counter in one transaction', async () => {
      const { settings, prisma } = makeService();
      const before = prisma.transactionCount;

      await settings.refresh();

      expect(prisma.transactionCount).toBe(before + 1);
    });
  });

  // -------------------------------------------------------------------------
  // snapshot
  // -------------------------------------------------------------------------

  describe('snapshot()', () => {
    it('reflects the overlay', async () => {
      const { settings, prisma } = makeService({
        env: { RECONCILER_ENABLED: 'true' },
      });
      storeValue(prisma, 'dispatch.enabled', true);
      await settings.refresh();

      const snapshot = settings.snapshot();

      expect(snapshot['dispatch.enabled']).toBe(true);
      expect(snapshot['reconciler.enabled']).toBe(true);
      expect(snapshot['supervisor.enabled']).toBe(false);
    });
  });
});

/** Put a plain value row into the fake table, the way another replica would. */
function storeValue(prisma: FakePrisma, key: string, value: unknown): void {
  prisma.rows.set(key, {
    key,
    ...blankColumns(),
    valuePresent: true,
    value,
    version: 1,
    updatedByUserId: null,
  });
}
