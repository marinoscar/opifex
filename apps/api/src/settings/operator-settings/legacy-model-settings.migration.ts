import {
  Injectable,
  Logger,
  Optional,
  type OnModuleInit,
} from '@nestjs/common';

import { open, type SealedSecret } from '../../common/crypto/secret-box';
import { PrismaService } from '../../prisma/prisma.service';
import {
  LEGACY_MODEL_API_KEY_ENV,
  LEGACY_MODEL_BASE_URL_ENV,
  OPERATOR_SETTINGS,
  parseOperatorSetting,
  type OperatorSettingKey,
} from './operator-settings.registry';
import { OperatorSettingsService } from './operator-settings.service';
import {
  DEFAULT_SUPERVISOR_MODEL_PROVIDER,
  modelApiKeySettingKey,
  modelBaseUrlSettingKey,
  type SupervisorModelProvider,
} from '../../supervisor/invocation/supervisor-model.config';

/**
 * Moving the one model credential into its per-provider slot (#422, epic
 * #419).
 *
 * ## Why this is code and not a SQL migration
 *
 * This is the whole difficulty of the issue, and it is worth stating exactly.
 * `common/crypto/secret-box.ts` binds every ciphertext to its SETTING KEY as
 * AES-GCM additional authenticated data, deliberately, so that a stored blob
 * cannot be copied between slots: without it, anyone who can write the
 * settings table could move `github.token`'s ciphertext into a model key slot
 * and have it decrypt cleanly into a use its owner never authorised.
 *
 * The consequence is that
 * `UPDATE operator_settings SET key = 'models.anthropic.apiKey' WHERE key =
 * 'supervisor.model.apiKey'` is not a migration. It is a row that will never
 * open again — the tag was computed over `v1:supervisor.model.apiKey` and
 * verification under the new key fails. It would also SUCCEED, loudly, and
 * leave a deployment whose Control Center says a credential is stored and
 * whose every model call refuses. That is the outcome this issue rules out by
 * name.
 *
 * So the move is decrypt-under-the-old-key, re-encrypt-under-the-new-one, and
 * that can only happen in a process that holds `OPIFEX_SETTINGS_ENCRYPTION_KEY`
 * — which is the API, at boot, here.
 *
 * ## Which slot the old value goes to
 *
 * `models.<supervisor.model.provider>.apiKey`. Not the default provider's
 * slot: the old key's MEANING was "the credential for whichever provider the
 * supervisor is configured with", and preserving that meaning is what makes
 * the migration a no-op from the operator's side. A deployment on OpenAI ends
 * up with its key in the OpenAI slot, which is where it was already being sent.
 *
 * ## What it will never do
 *
 * **Overwrite.** If the destination already holds a credential, the legacy row
 * is left exactly where it is and an error names both keys. Two credentials
 * and no way to tell which one the operator meant is not a situation to
 * resolve by guessing.
 *
 * **Delete something it could not read.** A row that fails to open is left in
 * place and reported at `error` on every boot until an operator acts. Deleting
 * it would destroy the one piece of evidence that a credential was ever
 * configured, and the failure may well be a temporary one — a restored backup,
 * a container started without `OPIFEX_SETTINGS_ENCRYPTION_KEY` — that a later
 * boot recovers from on its own.
 *
 * **Abort the boot.** `secret-box.ts`'s header and `config/env.validation.ts`
 * both reserve startup failure for the case where continuing would make the
 * process lie about its own authorization decisions. A credential that will
 * not open is not in that class: the API answers every other request
 * correctly, the supervisor refuses per invocation and records the refusal,
 * and a process that stays up is the one an operator can ask what went wrong.
 * Loud means `logger.error` naming the key and the remedy, at boot, rather
 * than a warning discovered at the first model call an hour later.
 *
 * ## Idempotent
 *
 * A successful move deletes the legacy row, so the next boot finds nothing and
 * says nothing. Every unsuccessful arm leaves the row untouched, so the next
 * boot retries — and repeats its complaint, which is correct: the deployment
 * is still broken.
 */

/** The keys #422 superseded. Not registry keys any more — that is the point. */
export const LEGACY_MODEL_API_KEY_SETTING = 'supervisor.model.apiKey';
export const LEGACY_MODEL_BASE_URL_SETTING = 'supervisor.model.baseUrl';

export type LegacyModelSettingKey =
  typeof LEGACY_MODEL_API_KEY_SETTING | typeof LEGACY_MODEL_BASE_URL_SETTING;

/** One row that has to move, and where to. */
export interface LegacyModelSettingMove {
  readonly from: LegacyModelSettingKey;
  readonly to: OperatorSettingKey;
  /** The superseded environment variable holding the same thing. */
  readonly legacyEnvVar: string;
}

/**
 * Where each superseded key's value belongs, given the selected provider.
 *
 * Pure, so the mapping is assertable without a database — and separate from
 * the executor so that "an OpenAI deployment's key lands in the OpenAI slot"
 * is a statement about a function rather than about a boot sequence.
 */
export function legacyModelSettingMoves(
  provider: SupervisorModelProvider,
): readonly LegacyModelSettingMove[] {
  return [
    {
      from: LEGACY_MODEL_API_KEY_SETTING,
      to: modelApiKeySettingKey(provider),
      legacyEnvVar: LEGACY_MODEL_API_KEY_ENV,
    },
    {
      from: LEGACY_MODEL_BASE_URL_SETTING,
      to: modelBaseUrlSettingKey(provider),
      legacyEnvVar: LEGACY_MODEL_BASE_URL_ENV,
    },
  ];
}

/** What happened to one legacy row. Returned so a spec need not read logs. */
export interface LegacyModelSettingOutcome {
  readonly from: LegacyModelSettingKey;
  readonly to: OperatorSettingKey;
  readonly result:
    /** Decrypted, re-sealed under the new key, old row removed. */
    | 'moved'
    /** The destination already held a value. The old row is untouched. */
    | 'occupied'
    /** The stored value could not be read. The old row is untouched. */
    | 'unreadable'
    /** It read, and the registry refused it for the new key. Untouched. */
    | 'rejected';
  readonly detail: string;
}

/** The shape the overlay stores a row in, as far as this migration cares. */
interface StoredSettingRow {
  key: string;
  value: unknown;
  secretCiphertext: string | null;
  secretIv: string | null;
  secretAuthTag: string | null;
  secretKeyVersion: number | null;
}

@Injectable()
export class LegacyModelSettingsMigration implements OnModuleInit {
  private readonly logger = new Logger(LegacyModelSettingsMigration.name);

  constructor(
    private readonly settings: OperatorSettingsService,
    @Optional() private readonly prisma?: PrismaService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.migrate();

    for (const problem of legacyModelEnvErrors(
      process.env,
      this.settings.get('supervisor.model.provider'),
    )) {
      this.logger.error(problem);
    }
  }

  /**
   * Move every superseded row, reporting what happened to each.
   *
   * Returns only the rows it FOUND: a deployment that never set the old keys —
   * which is every new one — produces an empty array and no log line at all.
   */
  async migrate(): Promise<LegacyModelSettingOutcome[]> {
    if (!this.prisma) return [];

    // The overlay's own loud complaint covers an unavailable database, and
    // migrating against rows we could not read would be guessing. The 15s
    // refresh loop does not retry this; the next boot does, which is the right
    // cadence for a one-shot move.
    if (this.settings.overlay().status !== 'loaded') return [];

    let rows: StoredSettingRow[];
    try {
      rows = (await this.prisma.operatorSetting.findMany({
        select: {
          key: true,
          value: true,
          secretCiphertext: true,
          secretIv: true,
          secretAuthTag: true,
          secretKeyVersion: true,
        },
      })) as unknown as StoredSettingRow[];
    } catch (error) {
      this.logger.error(
        `The superseded model settings could not be checked for migration ` +
          `(${message(error)}). If this deployment stored ` +
          `${LEGACY_MODEL_API_KEY_SETTING}, it is still there and is not in ` +
          `force. The next boot retries.`,
      );
      return [];
    }

    const byKey = new Map(rows.map((row) => [row.key, row]));
    const provider = this.settings.get('supervisor.model.provider');
    const outcomes: LegacyModelSettingOutcome[] = [];

    for (const move of legacyModelSettingMoves(provider)) {
      const row = byKey.get(move.from);
      if (row === undefined) continue;

      outcomes.push(await this.moveOne(move, row, byKey.has(move.to)));
    }

    return outcomes;
  }

  private async moveOne(
    move: LegacyModelSettingMove,
    row: StoredSettingRow,
    destinationOccupied: boolean,
  ): Promise<LegacyModelSettingOutcome> {
    const secret = OPERATOR_SETTINGS[move.to].secret;

    if (destinationOccupied) {
      return this.report({
        ...move,
        result: 'occupied',
        detail:
          `${move.from} still holds a value, and ${move.to} — where it would ` +
          `go — already has one. Nothing has been moved or overwritten. ` +
          (secret
            ? `Confirm which credential you want in ${move.to}, save it in ` +
              `the Control Center, `
            : `Confirm the value in ${move.to} is the one you want, `) +
          `and delete the ${move.from} row.`,
      });
    }

    const read = readStoredValue(row, move.from);
    if (!read.ok) {
      return this.report({
        ...move,
        result: 'unreadable',
        detail:
          `${move.from} holds a value that cannot be read (${read.reason}), ` +
          `so it could not be moved to ${move.to} and NOTHING is configured ` +
          `there. ` +
          (secret
            ? `Re-enter the credential against ${move.to} in the Control ` +
              `Center — or restore the OPIFEX_SETTINGS_ENCRYPTION_KEY this ` +
              `deployment sealed it with and restart, and this will complete ` +
              `on its own. `
            : `Set ${move.to} in the Control Center. `) +
          `The old row has been left exactly as it is.`,
      });
    }

    const parsed = parseOperatorSetting(move.to, read.value);
    if (!parsed.ok) {
      return this.report({
        ...move,
        result: 'rejected',
        detail:
          `${move.from} was read, and ${move.to} refuses the value ` +
          `(${parsed.error}), so nothing has been moved. Set ${move.to} in ` +
          `the Control Center. The old row has been left exactly as it is.`,
      });
    }

    // Through the ordinary write path, so the value is parsed once by the
    // registry, sealed under the NEW setting key by the same `seal` every
    // other write uses, versioned by the same collection counter and audited
    // by the same row builder. A bespoke insert here would be a second write
    // path for credentials, which is exactly the kind of second declaration
    // epic #332 exists to remove.
    await this.settings.set(move.to, read.value, null);

    // Second, and deliberately not in the same transaction as the write above.
    // If the process dies between them the credential exists in BOTH slots,
    // which the next boot reports as `occupied` and an operator resolves by
    // deleting one row. The other order — delete first — has a failure mode
    // where the credential exists in NEITHER, and a lost credential is not
    // recoverable by reading a message.
    await this.dropLegacyRow(move.from);

    return this.report({
      ...move,
      result: 'moved',
      detail:
        `${move.from} has been migrated to ${move.to}` +
        (secret
          ? `, re-encrypted under its new setting key — a sealed value cannot ` +
            `simply be re-pointed, because the setting key is part of what ` +
            `authenticates it`
          : '') +
        `. Nothing needs to be re-entered. Remove ${move.legacyEnvVar} from ` +
        `your environment if it is still set there.`,
    });
  }

  /**
   * Delete the superseded row and bump the collection revision with it.
   *
   * In one transaction for the reason `OperatorSettingsService.clear` gives:
   * a caller holding an `If-Match` against the counter must not be able to
   * observe a revision that does not describe the rows it versions.
   */
  private async dropLegacyRow(key: LegacyModelSettingKey): Promise<void> {
    const prisma = this.prisma;
    /* istanbul ignore next -- `migrate` returns early without a client */
    if (!prisma) return;

    try {
      await prisma.$transaction(async (tx) => {
        const deleted = await tx.operatorSetting.deleteMany({ where: { key } });
        if (deleted.count === 0) return;
        await tx.operatorSettingsRevision.update({
          where: { id: 1 },
          data: { revision: { increment: 1 } },
        });
      });
    } catch (error) {
      // The new slot is already written and in force, so the deployment works.
      // What is left is a stale row that the next boot will report as
      // `occupied` — noisy, not harmful, and worth saying once here so the
      // eventual message is not a surprise.
      this.logger.error(
        `${key} was migrated but the superseded row could not be deleted ` +
          `(${message(error)}). The new setting is in force; delete the ` +
          `${key} row when you can.`,
      );
    }
  }

  private report(
    outcome: LegacyModelSettingOutcome,
  ): LegacyModelSettingOutcome {
    if (outcome.result === 'moved') this.logger.log(outcome.detail);
    else this.logger.error(outcome.detail);
    return outcome;
  }
}

/**
 * The superseded environment variables, when they cannot do what an operator
 * would expect of them.
 *
 * `SUPERVISOR_MODEL_API_KEY` still WORKS — it is the default provider's
 * `legacyEnvVar` — so a deployment on the default provider gets no line here;
 * the resolver already says once that the name has moved. The case worth an
 * error is the narrow one the compatibility shim deliberately does not cover:
 * the old variable set while a NON-default provider is selected. There the
 * value feeds a slot nothing is currently reading, and the supervisor has no
 * credential at all — a state that would otherwise present as "I set the key
 * and it is ignored".
 *
 * PURE, and takes the environment as an argument, for the reason
 * `retiredSupervisorWarnings` and `operatorEnvDisagreements` do: the wording
 * an operator will actually read is then testable without a Nest container or
 * a mutated `process.env`.
 */
export function legacyModelEnvErrors(
  env: NodeJS.ProcessEnv,
  provider: SupervisorModelProvider,
): string[] {
  if (provider === DEFAULT_SUPERVISOR_MODEL_PROVIDER) return [];

  const problems: string[] = [];

  for (const move of legacyModelSettingMoves(provider)) {
    const raw = env[move.legacyEnvVar];
    if (raw === undefined || raw.trim() === '') continue;

    problems.push(
      `${move.legacyEnvVar} is set, and it is NOT supplying ${move.to}. ` +
        `The superseded name is read only for ` +
        `${DEFAULT_SUPERVISOR_MODEL_PROVIDER}, because one variable cannot ` +
        `honestly name a credential for two providers — mapping it onto both ` +
        `would post one vendor's key to the other. This deployment selects ` +
        `"${provider}", so rename it to ${OPERATOR_SETTINGS[move.to].envVar}, ` +
        `or set ${move.to} in the Control Center.`,
    );
  }

  return problems;
}

/** The plaintext behind a stored row, in either of the two legal shapes. */
type StoredRead =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Read one stored row, sealed or plain.
 *
 * The plain arm is not hypothetical: `OperatorSettingsService.resolve` already
 * documents that a secret key with a plaintext `value` row is legal at the
 * database and reachable by hand. Migrating it too means an operator who
 * inserted one does not silently lose it here.
 *
 * Exported so the decision — which reasons are reported, and that a failed
 * open never yields a string — is testable without a Nest container.
 */
export function readStoredValue(
  row: {
    value: unknown;
    secretCiphertext: string | null;
    secretIv: string | null;
    secretAuthTag: string | null;
    secretKeyVersion: number | null;
  },
  settingKey: string,
): StoredRead {
  if (row.secretCiphertext !== null) {
    const sealed: SealedSecret = {
      ciphertext: row.secretCiphertext,
      iv: row.secretIv ?? '',
      authTag: row.secretAuthTag ?? '',
      // -1 is not a supported version, so a row missing the column reports
      // `unsupported_key_version` rather than throwing inside the cipher.
      keyVersion: row.secretKeyVersion ?? -1,
    };

    const opened = open(sealed, settingKey);
    // No environment fallback and no empty-string substitute. `secret-box.ts`
    // is explicit that "stored but unreadable" must never collapse into "not
    // stored": doing so here would re-encrypt nothing, delete the old row, and
    // report a successful migration of a credential that no longer exists.
    return opened.ok
      ? { ok: true, value: opened.plaintext }
      : { ok: false, reason: opened.reason };
  }

  return typeof row.value === 'string'
    ? { ok: true, value: row.value }
    : { ok: false, reason: 'malformed_envelope' };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
