import { Prisma } from '@prisma/client';

import { seal } from '../../src/common/crypto/secret-box';
import type { PrismaService } from '../../src/prisma/prisma.service';
import {
  OperatorSettingsService,
  type OperatorSettingSource,
} from '../../src/settings/operator-settings/operator-settings.service';
import type { OperatorSettingKey } from '../../src/settings/operator-settings/operator-settings.registry';

/**
 * A minimal `operator_settings` stand-in for the #338 endpoint specs.
 *
 * Deliberately NOT a copy of the fuller fake in
 * `operator-settings.overlay.spec.ts`. That one exists to enforce the
 * `value XOR secret` CHECK against the WRITE path, which is the property that
 * file is about. These specs are about what the endpoints return, so what they
 * need is the ability to state "there is a sealed row here" and have the real
 * resolver read it — plus a write path real enough that a `PATCH` spec can
 * assert what landed and what the revision became.
 *
 * Everything under test is the production code: the real
 * `OperatorSettingsService`, the real registry, the real secret box, the real
 * view builder. Only the two tables and the environment are stood in for.
 */
export class FakeOperatorSettingsPrisma {
  readonly rows = new Map<string, StoredRow>();
  readonly audits: Array<Record<string, unknown>> = [];
  revision = 0n;

  /** When set, every read and write rejects with this message. */
  down: string | null = null;

  readonly operatorSetting = {
    findMany: (): Promise<StoredRow[]> => this.guard([...this.rows.values()]),
    upsert: (args: {
      where: { key: string };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }): Promise<StoredRow> => {
      const existing = this.rows.get(args.where.key);
      const row = toRow(
        args.where.key,
        existing ? args.update : args.create,
        existing,
      );
      this.rows.set(row.key, row);
      return this.guard(row);
    },
    deleteMany: (args: {
      where: { key: string };
    }): Promise<{ count: number }> =>
      this.guard({ count: this.rows.delete(args.where.key) ? 1 : 0 }),
  };

  readonly operatorSettingsRevision = {
    findUnique: (): Promise<{ revision: bigint }> =>
      this.guard({ revision: this.revision }),
    update: (): Promise<{ revision: bigint }> => {
      this.revision += 1n;
      return this.guard({ revision: this.revision });
    },
  };

  readonly auditEvent = {
    create: (args: { data: Record<string, unknown> }): Promise<unknown> => {
      this.audits.push(args.data);
      return this.guard(args.data);
    },
  };

  readonly repository = {
    findFirst: (): Promise<null> => Promise.resolve(null),
    findUnique: (): Promise<null> => Promise.resolve(null),
  };

  /** Put a sealed secret in the table, exactly as `set()` would have. */
  sealInto(key: OperatorSettingKey, plaintext: string): void {
    const sealed = seal(plaintext, key);
    this.rows.set(key, {
      key,
      value: null,
      secretCiphertext: sealed.ciphertext,
      secretIv: sealed.iv,
      secretAuthTag: sealed.authTag,
      secretKeyVersion: sealed.keyVersion,
      updatedAt: new Date('2026-08-20T09:00:00.000Z'),
    });
    this.revision += 1n;
  }

  /** Put a plain override in the table. */
  put(key: OperatorSettingKey, value: unknown): void {
    this.rows.set(key, {
      key,
      value: value as Prisma.JsonValue,
      secretCiphertext: null,
      secretIv: null,
      secretAuthTag: null,
      secretKeyVersion: null,
      updatedAt: new Date('2026-08-20T09:00:00.000Z'),
    });
    this.revision += 1n;
  }

  /** A row whose ciphertext has been tampered with, so it will not open. */
  corrupt(key: OperatorSettingKey): void {
    const row = this.rows.get(key);
    if (!row) throw new Error(`no row for ${key} to corrupt`);
    row.secretCiphertext = Buffer.from('not the ciphertext').toString('base64');
  }

  $transaction<T>(
    work: Array<Promise<unknown>> | ((tx: unknown) => Promise<T>),
  ): Promise<T | unknown[]> {
    if (Array.isArray(work)) return Promise.all(work);
    return work(this);
  }

  asPrisma(): PrismaService {
    return this as unknown as PrismaService;
  }

  private guard<T>(value: T): Promise<T> {
    return this.down === null
      ? Promise.resolve(value)
      : Promise.reject(new Error(this.down));
  }
}

export interface StoredRow {
  key: string;
  value: Prisma.JsonValue;
  secretCiphertext: string | null;
  secretIv: string | null;
  secretAuthTag: string | null;
  secretKeyVersion: number | null;
  updatedAt: Date;
}

function toRow(
  key: string,
  data: Record<string, unknown>,
  existing?: StoredRow,
): StoredRow {
  const value = data.value;

  return {
    key,
    value:
      value === Prisma.DbNull
        ? null
        : value === Prisma.JsonNull
          ? null
          : (value as Prisma.JsonValue),
    secretCiphertext: (data.secretCiphertext as string | null) ?? null,
    secretIv: (data.secretIv as string | null) ?? null,
    secretAuthTag: (data.secretAuthTag as string | null) ?? null,
    secretKeyVersion: (data.secretKeyVersion as number | null) ?? null,
    updatedAt: existing?.updatedAt ?? new Date('2026-08-21T10:00:00.000Z'),
  };
}

/**
 * The real service with only `environment()` replaced, so specs never depend
 * on the host's environment — the same seam `operator-settings.overlay.spec.ts`
 * uses, for the same reason.
 */
export class TestOperatorSettingsService extends OperatorSettingsService {
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

/** 32 bytes, base64. Not secret; it is a fixture. */
export const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 11).toString('base64');

export async function makeOperatorSettings(
  options: {
    prisma?: FakeOperatorSettingsPrisma;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<{
  settings: OperatorSettingsService;
  prisma: FakeOperatorSettingsPrisma;
}> {
  const prisma = options.prisma ?? new FakeOperatorSettingsPrisma();
  const settings = new TestOperatorSettingsService(
    prisma.asPrisma(),
    options.env ?? {},
  );
  await settings.refresh();
  return { settings, prisma };
}

export type { OperatorSettingSource };
