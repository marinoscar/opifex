import {
  BadRequestException,
  Injectable,
  Logger,
  Optional,
  type OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { redactSettingsMeta } from '../../common/crypto/redact';
import {
  resolveSecret,
  seal,
  type OpenFailureReason,
  type SealedSecret,
} from '../../common/crypto/secret-box';
import { PrismaService } from '../../prisma/prisma.service';
import {
  OPERATOR_SETTINGS,
  OPERATOR_SETTING_KEYS,
  isOperatorSettingKey,
  parseOperatorSetting,
  type OperatorSettingKey,
  type OperatorSettingValue,
  type OperatorSettingsSnapshot,
} from './operator-settings.registry';

/** Where a resolved value came from. */
export type OperatorSettingSource = 'default' | 'env' | 'database';

/** One resolved setting, with the provenance the Control Center needs. */
export interface ResolvedOperatorSetting<K extends OperatorSettingKey> {
  readonly key: K;
  readonly value: OperatorSettingValue<K>;
  readonly source: OperatorSettingSource;
  /**
   * Set when a value WAS supplied and could not be parsed, so the default is
   * being used instead. The Control Center shows this rather than presenting a
   * rejected value as if it had taken effect.
   */
  readonly invalid?: {
    readonly source: OperatorSettingSource;
    readonly reason: string;
  };
  /**
   * Set when a stored SECRET exists and will not decrypt (#339).
   *
   * Distinct from `invalid`, and the distinction is the point: `invalid` means
   * "somebody supplied a value the registry rejected", which is a typo. This
   * means "a credential is stored here and cannot be read", which is a broken
   * deployment. In neither case does the environment layer supply the answer —
   * see `resolveSecretSetting` for why falling back here would resurrect the
   * credential the operator rotated away from.
   */
  readonly error?: {
    readonly reason: OpenFailureReason;
    readonly message: string;
  };
}

/**
 * A notification that one or more managed settings changed.
 *
 * Deliberately carries KEYS and not values. A subscriber must re-read through
 * `get()`, because a payload captured at emit time can be overtaken by the
 * next refresh before the subscriber runs — and a subscriber acting on a value
 * the service no longer holds is precisely the class of "appears to work" bug
 * this epic exists to remove.
 */
export interface OperatorSettingsChange {
  readonly keys: readonly OperatorSettingKey[];
  readonly at: Date;
}

export type OperatorSettingsChangeListener = (
  change: OperatorSettingsChange,
) => void;

/**
 * The named warning an unavailable overlay reports.
 *
 * A NAME rather than a message, because the API returns this and the cockpit
 * renders it: a UI cannot branch on prose, and a message that is rewritten for
 * clarity would silently stop matching whatever was keying off it.
 */
export const OPERATOR_SETTINGS_OVERLAY_UNAVAILABLE =
  'operator_settings_overlay_unavailable' as const;

export type OperatorSettingsOverlayWarning =
  typeof OPERATOR_SETTINGS_OVERLAY_UNAVAILABLE;

/**
 * Whether the database overlay is in force, and if not, why not (#339).
 *
 * This is a VALUE the API returns and the cockpit renders, not a log line.
 * `PrismaService` boots the API without a database on purpose (#161), so the
 * overlay genuinely can be missing while everything else answers normally —
 * and an env-only resolution that says nothing about it is indistinguishable
 * from "no overrides exist". That ambiguity is the failure this whole issue
 * exists to remove, so it gets a field rather than a warning nobody reads.
 */
export interface OperatorSettingsOverlayState {
  readonly status: 'loaded' | 'unavailable';
  /** When a load last SUCCEEDED. Null until one has. */
  readonly loadedAt: Date | null;
  /** When a load was last ATTEMPTED, successful or not. */
  readonly attemptedAt: Date | null;
  /**
   * The collection-level counter `If-Match` is checked against (#338). Null
   * until a load has succeeded — there is no honest number to report before
   * the row has been read once.
   */
  readonly revision: number | null;
  /** How many managed keys currently have a row. */
  readonly overriddenKeys: number;
  /** Present exactly when `status` is `'unavailable'`. */
  readonly warning?: OperatorSettingsOverlayWarning;
  /** Present exactly when `status` is `'unavailable'`: the driver's own words. */
  readonly problem?: string;
  /**
   * True when a load has succeeded before and the most recent one did not, so
   * the values in force are a real overlay that may now be out of date —
   * rather than no overlay at all. Both are `'unavailable'`; only one of them
   * means "env values are what you are getting".
   */
  readonly stale?: boolean;
}

/** What a write did, and the counter #338 hands back as an ETag. */
export interface OperatorSettingWriteResult<
  K extends OperatorSettingKey = OperatorSettingKey,
> {
  readonly key: K;
  /** False when there was nothing to do — `clear()` on a key with no row. */
  readonly changed: boolean;
  /** The collection revision AFTER the write. */
  readonly revision: number | null;
  /** How the key resolves now, for the response body. */
  readonly resolved: ResolvedOperatorSetting<K>;
}

/** One row of the overlay, in the shape the resolver actually reads. */
export type OverlayEntry =
  | { readonly kind: 'value'; readonly raw: unknown }
  | { readonly kind: 'secret'; readonly sealed: SealedSecret };

/** The single row of `operator_settings_revision`. */
const REVISION_ROW_ID = 1;

/**
 * How often the overlay is re-read. See `OperatorSettingsRefreshTask` for why
 * a poll rather than a subscription, and why 15 seconds.
 */
export const OPERATOR_SETTINGS_REFRESH_INTERVAL_MS = 15_000;

/**
 * The read AND write path for operator-managed settings (#335, #339, epic
 * #332).
 *
 * ## What this resolves
 *
 * `default -> env -> database row`, in that order, with the database winning.
 * **Absence at any layer falls through to the next; it is never read as a
 * value.** An absent row does not mean `false`, `0` or `''` — it means "ask
 * the layer below", which is ADR-0018 §2 and the same rule
 * `common/schemas/user-settings-namespaces.schema.ts` fought for one layer in.
 *
 * ## Why `get()` is synchronous, and must stay that way
 *
 * Every consumer that will migrate reads its configuration synchronously —
 * `runner-registration.service.ts:536`, `dispatch.service.ts:96`,
 * `run-executor.service.ts:272`, `fleet-state.service.ts:496` — and several
 * are inside pure decision functions or property getters where there is no
 * `await` to add. An async read would turn a one-line swap into a signature
 * change rippling through half the fleet, and every one of those signatures is
 * a place a mistake could hide. So the overlay refreshes into memory on a loop
 * and this stays a memory read. ADR-0018's Consequences flag the cost of that
 * choice — `get()` lands on hot paths — and the loop is what bounds it to one
 * query every 15 seconds regardless of how often anything reads.
 *
 * ## Why an unparseable value falls back instead of throwing
 *
 * A misconfigured environment variable must not be able to take the API down:
 * `configuration.ts` is explicit that unset, misspelled and empty all mean
 * "off" for every switch, and `env.validation.ts` reserves boot failure for
 * `JWT_SECRET`, where continuing would void every authorization decision the
 * process makes. Nothing here is in that class. So a bad value is logged once,
 * the declared default is used, and `resolve()` reports the rejection so the
 * Control Center can show it — silence would leave an operator staring at a
 * value they set which is not the one in force.
 *
 * The test double reverses this and throws, for the reason its own file gives.
 *
 * ## Why a failed decrypt is NOT that fallback
 *
 * See `resolveSecretSetting`. A stored ciphertext that will not open is a
 * different fact from no stored ciphertext, and `secret-box.ts` gives the two
 * different states specifically so this service cannot collapse them.
 */
@Injectable()
export class OperatorSettingsService implements OnModuleInit {
  private readonly logger = new Logger(OperatorSettingsService.name);

  /** Keys already complained about, so a hot path logs once and not per read. */
  private readonly warned = new Set<string>();

  private readonly listeners = new Set<OperatorSettingsChangeListener>();

  /** The database layer. Empty until the first successful refresh. */
  private overlayRows = new Map<OperatorSettingKey, OverlayEntry>();

  /**
   * When each stored row was last written (#338).
   *
   * A SEPARATE map rather than a field on `OverlayEntry`, because the entry is
   * what the resolver reads and the test double supplies — and a double that
   * had to invent an `updatedAt` for an override nobody wrote would be stating
   * a fact it does not have. Absent here simply means "no row", which is the
   * same thing `overlayRows` already means.
   */
  private overlayWrittenAt = new Map<OperatorSettingKey, Date>();

  /**
   * What the most recent refresh announced, so a write can tell whether its
   * own key was already covered. Reset to empty by a failed refresh, because
   * a previous pass's change set says nothing about this one.
   */
  private lastRefreshChanged: readonly OperatorSettingKey[] = [];

  private overlayState: OperatorSettingsOverlayState = {
    status: 'unavailable',
    loadedAt: null,
    attemptedAt: null,
    revision: null,
    overriddenKeys: 0,
    warning: OPERATOR_SETTINGS_OVERLAY_UNAVAILABLE,
    problem: 'the operator settings overlay has not been loaded yet',
  };

  /**
   * `@Optional()` because this class is also constructed directly — by its own
   * specs and by `makeOperatorSettings` — where dragging a Prisma client in
   * would defeat the point of a hermetic double. In the running application
   * `PrismaModule` is `@Global` and registered before `OperatorSettingsModule`
   * in `app.module.ts`, so it is always injected; `onModuleInit` says so out
   * loud if it ever is not, because a silently database-free overlay is
   * exactly the invisible degradation this issue is about.
   */
  constructor(@Optional() private readonly prisma?: PrismaService) {}

  /**
   * Load the overlay once, at boot, before anything reads.
   *
   * On the service rather than on `OperatorSettingsRefreshTask` deliberately:
   * `OperatorSettingsModule` is `@Global` and initialises early, so a consumer
   * in ANOTHER module that reads a managed key in its own `onModuleInit` gets
   * the overlay rather than the environment — Nest runs the module hooks
   * module by module, awaiting each module's before starting the next.
   *
   * It does NOT extend to this module's own providers, and reading it as
   * though it did is #436: `callModuleInitHook` starts every provider hook
   * WITHIN a module in one pass and awaits them together with `Promise.all`,
   * so a sibling's `onModuleInit` runs while this one is still awaiting the
   * query below and sees `status: 'unavailable'`. A sibling's CONSTRUCTOR is
   * worse again: it runs before any hook at all, so it never sees an overlay
   * under any ordering (#437). The three providers that need the overlay at
   * startup — `LegacyModelSettingsMigration`, `UnreadableSecretsBootCheck` and
   * `OperatorSettingsEnvDisagreementService` — therefore use
   * `onApplicationBootstrap`, which runs after every module's `onModuleInit`
   * has settled, and `operator-settings.boot-order.spec.ts` asserts that no
   * fourth one is added reading it any earlier.
   *
   * A failure here does NOT abort the boot, for exactly `PrismaService`'s
   * reason (#161): the process that stays up is the one that can be asked what
   * went wrong, and the 15s loop recovers it without a restart.
   */
  async onModuleInit(): Promise<void> {
    if (!this.prisma) {
      this.logger.error(
        'No PrismaService was injected, so operator settings will resolve ' +
          'from the environment forever and no override will ever apply. ' +
          'This is a wiring bug, not a configuration one.',
      );
      return;
    }

    await this.refresh();
  }

  /**
   * The current value of one managed key. Never throws, never returns
   * `undefined`: every key has a declared default.
   */
  get<K extends OperatorSettingKey>(key: K): OperatorSettingValue<K> {
    return this.resolve(key).value;
  }

  /** The current value plus where it came from. */
  resolve<K extends OperatorSettingKey>(key: K): ResolvedOperatorSetting<K> {
    const definition = OPERATOR_SETTINGS[key];
    const fallback = definition.default as OperatorSettingValue<K>;

    if (definition.secret) {
      const stored = this.storedEntry(key);
      if (stored?.kind === 'secret') {
        return this.resolveSecretSetting(key, stored.sealed, fallback);
      }
      // A secret key with a PLAIN row is legal at the database (the CHECK
      // constraint only forbids both-or-neither, not a plaintext credential in
      // `value`) and can only get there by hand: `set()` always seals. It is
      // used, because refusing it would break a deployment over a row somebody
      // deliberately inserted — but it is said out loud once, because a
      // credential sitting unencrypted in a JSONB column is worth knowing.
      if (stored?.kind === 'value') {
        this.warnOnce(
          `plaintext:${key}`,
          `${key} is a secret, but its database row stores a plain value ` +
            `rather than a sealed one. It is in force; re-saving it through ` +
            `the settings API will encrypt it.`,
        );
      }
    }

    const supplied = this.rawValue(key);

    if (supplied === undefined) {
      return { key, value: fallback, source: 'default' };
    }

    const parsed = parseOperatorSetting(key, supplied.raw);
    if (parsed.ok) {
      return { key, value: parsed.value, source: supplied.source };
    }

    this.onInvalid(key, supplied.source, parsed.error, supplied.raw, fallback);

    return {
      key,
      value: fallback,
      source: 'default',
      invalid: { source: supplied.source, reason: parsed.error },
    };
  }

  /** Every key at once, for a caller that needs a consistent read. */
  snapshot(): OperatorSettingsSnapshot {
    const snapshot = {} as OperatorSettingsSnapshot;
    for (const key of OPERATOR_SETTING_KEYS) {
      // `key` is a union across the whole registry here, so the per-key
      // relationship between key and value type cannot be expressed without a
      // mapped-type gymnastics that buys nothing at the call site — `snapshot`
      // is already correctly typed for its readers.
      //
      // NOTE for #338: this carries secret PLAINTEXT for the three secret
      // keys. It is an internal read, not a response body; anything serving it
      // over HTTP masks first (`maskSecret`).
      (snapshot as Record<string, unknown>)[key] = this.get(key);
    }
    return snapshot;
  }

  /** Whether the database overlay is in force, and if not, why not. */
  overlay(): OperatorSettingsOverlayState {
    return this.overlayState;
  }

  /**
   * When this key's stored override was last written, or null if it has none.
   *
   * For the settings API (#338), which reports `updatedAt` beside every key —
   * and which for a SECRET has nothing else honest to show: the value is never
   * returned, so "when was this last rotated" is most of what an operator can
   * actually be told about a credential slot.
   *
   * Null covers both "no row" and "the overlay has never loaded". The two are
   * distinguishable from `overlay().status`, which the same response carries.
   */
  storedAt(key: OperatorSettingKey): Date | null {
    return this.overlayWrittenAt.get(key) ?? null;
  }

  /**
   * Re-read the whole overlay from the database.
   *
   * Called at boot, by the 15s loop, and after every successful write. Never
   * throws: a database that is away is a state this service REPORTS, and a
   * rejected promise inside a `setInterval` callback has no caller to
   * propagate to and takes the process down under Node's default policy.
   */
  async refresh(): Promise<OperatorSettingsOverlayState> {
    const attemptedAt = new Date();

    if (!this.prisma) {
      return this.markUnavailable(attemptedAt, 'no database client is wired');
    }

    let rows: Array<{
      key: string;
      value: Prisma.JsonValue;
      secretCiphertext: string | null;
      secretIv: string | null;
      secretAuthTag: string | null;
      secretKeyVersion: number | null;
      updatedAt: Date;
    }>;
    let revisionRow: { revision: bigint } | null;

    try {
      // One transaction for the two reads, so the rows and the counter that
      // is meant to describe them cannot come from either side of a write.
      [rows, revisionRow] = await this.prisma.$transaction([
        this.prisma.operatorSetting.findMany({
          select: {
            key: true,
            value: true,
            secretCiphertext: true,
            secretIv: true,
            secretAuthTag: true,
            secretKeyVersion: true,
            updatedAt: true,
          },
        }),
        this.prisma.operatorSettingsRevision.findUnique({
          where: { id: REVISION_ROW_ID },
          select: { revision: true },
        }),
      ]);
    } catch (error) {
      return this.markUnavailable(attemptedAt, asMessage(error));
    }

    const next = new Map<OperatorSettingKey, OverlayEntry>();
    const nextWrittenAt = new Map<OperatorSettingKey, Date>();

    for (const row of rows) {
      if (!isOperatorSettingKey(row.key)) {
        // A row for a key this build does not know — an older or newer
        // deployment sharing the database. Skipped rather than treated as an
        // error: it cannot affect anything this build resolves.
        this.warnOnce(
          `unknown:${row.key}`,
          `The operator settings table has a row for "${row.key}", which is ` +
            `not a managed key in this build. It is being ignored.`,
        );
        continue;
      }

      next.set(row.key, toOverlayEntry(row));
      nextWrittenAt.set(row.key, row.updatedAt);
    }

    if (
      this.overlayState.status === 'unavailable' &&
      this.warned.has('overlay')
    ) {
      // Only when an outage was actually reported, so an ordinary boot does
      // not announce a recovery from nothing. The flag is cleared as well as
      // logged, so a LATER outage warns again rather than being swallowed by
      // the once-per-reason rule — an overlay that flaps must not go quiet
      // after its first trip.
      this.warned.delete('overlay');
      this.logger.log(
        'The operator settings overlay is readable again; stored overrides ' +
          'are back in force.',
      );
    }

    const changed = diffOverlays(this.overlayRows, next);

    this.overlayRows = next;
    this.overlayWrittenAt = nextWrittenAt;
    this.lastRefreshChanged = changed;
    this.overlayState = {
      status: 'loaded',
      loadedAt: attemptedAt,
      attemptedAt,
      revision: revisionRow === null ? null : Number(revisionRow.revision),
      overriddenKeys: next.size,
    };

    // A key whose stored value changed deserves to complain again if the new
    // one is also broken; otherwise the one-shot warning would swallow every
    // later mistake on that key for the life of the process.
    for (const key of changed) {
      this.warned.delete(`invalid:${key}`);
      this.warned.delete(`decrypt:${key}`);
      this.warned.delete(`plaintext:${key}`);
    }

    // AFTER the new overlay is in place and visible to `get()`. Notifying
    // first would have every subscriber re-read the old value and treat it as
    // the new one.
    this.notifyChanged(changed);

    return this.overlayState;
  }

  /**
   * Store an override for one key.
   *
   * `value` is `unknown` on purpose: it arrives from an HTTP body and goes
   * through `parseOperatorSetting`, the registry's single parse path, so that
   * a JSON `true` and the env string `'true'` cannot resolve differently.
   *
   * Secrets are sealed with the setting key as additional authenticated data
   * and land in the ciphertext columns; everything else lands in `value`.
   * Clearing a secret is `clear()`, not `set(key, '')` — an empty plaintext
   * has no honest sealed form, so this routes it there rather than storing a
   * credential of length zero.
   *
   * @throws {BadRequestException} for an unknown key or a value the registry
   *   rejects. Unlike the read path, a write has a caller who asked for
   *   something specific and is owed the news that it did not happen.
   */
  async set<K extends OperatorSettingKey>(
    key: K,
    value: unknown,
    userId: string | null,
  ): Promise<OperatorSettingWriteResult<K>> {
    const definition = this.requireKey(key);
    const parsed = parseOperatorSetting(key, value);

    if (!parsed.ok) {
      // The rejected value is echoed back for a non-secret, because "what you
      // sent" is most of the diagnosis — and is NEVER echoed for a secret. A
      // 400 body and the log line behind it are both places a mistyped
      // credential would otherwise come to rest in the clear, and the operator
      // typing it already knows what they typed.
      throw new BadRequestException(
        definition.secret
          ? `The value supplied for ${key} is not valid: ${parsed.error}`
          : `${String(value)} is not a valid value for ${key}: ${parsed.error}`,
      );
    }

    if (definition.secret && parsed.value === '') {
      return this.clear(key, userId);
    }

    const prisma = this.requireDatabase();
    const before = this.resolve(key);

    const columns: StoredColumns = definition.secret
      ? sealedColumns(seal(String(parsed.value), key))
      : plainColumns(parsed.value);

    const revision = await prisma.$transaction(async (tx) => {
      await tx.operatorSetting.upsert({
        where: { key },
        create: { key, ...columns, updatedByUserId: userId },
        update: {
          ...columns,
          updatedByUserId: userId,
          version: { increment: 1 },
        },
      });

      // In the SAME transaction as the row write, and that is the whole point
      // of the interactive form here: a caller holding an `If-Match` against
      // the counter must never be able to observe a revision that does not yet
      // describe the rows it is meant to version.
      const bumped = await tx.operatorSettingsRevision.update({
        where: { id: REVISION_ROW_ID },
        data: { revision: { increment: 1 } },
        select: { revision: true },
      });

      return Number(bumped.revision);
    });

    return this.afterWrite(
      key,
      before,
      revision,
      'operator_settings:set',
      userId,
    );
  }

  /**
   * Remove the override for one key, so it reverts to the layer below.
   *
   * "The layer below" is whatever the environment currently says, and only the
   * hardcoded default if the environment says nothing — ADR-0018 §2 is
   * explicit that a revert must not erase an env value an operator set outside
   * the running system.
   *
   * Clearing a key with no row is a no-op that bumps nothing. Reporting a new
   * revision for a delete that deleted nothing would invalidate every
   * outstanding `If-Match` to describe a change that did not happen.
   */
  async clear<K extends OperatorSettingKey>(
    key: K,
    userId: string | null,
  ): Promise<OperatorSettingWriteResult<K>> {
    this.requireKey(key);

    const prisma = this.requireDatabase();
    const before = this.resolve(key);

    const outcome = await prisma.$transaction(async (tx) => {
      const deleted = await tx.operatorSetting.deleteMany({ where: { key } });

      if (deleted.count === 0) {
        const current = await tx.operatorSettingsRevision.findUnique({
          where: { id: REVISION_ROW_ID },
          select: { revision: true },
        });
        return {
          changed: false,
          revision: current === null ? null : Number(current.revision),
        };
      }

      const bumped = await tx.operatorSettingsRevision.update({
        where: { id: REVISION_ROW_ID },
        data: { revision: { increment: 1 } },
        select: { revision: true },
      });

      return { changed: true, revision: Number(bumped.revision) };
    });

    if (!outcome.changed) {
      return {
        key,
        changed: false,
        revision: outcome.revision,
        resolved: before,
      };
    }

    return this.afterWrite(
      key,
      before,
      outcome.revision,
      'operator_settings:clear',
      userId,
    );
  }

  /**
   * Subscribe to changes. Returns the unsubscribe.
   */
  onChange(listener: OperatorSettingsChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Announce that some keys now resolve differently.
   *
   * @internal Called by the write path and the refresh loop AFTER a change is
   * committed and visible to `get()`. Calling it before that would have
   * subscribers re-read the old value and treat it as the new one.
   */
  notifyChanged(keys: readonly OperatorSettingKey[]): void {
    if (keys.length === 0) return;

    const change: OperatorSettingsChange = { keys: [...keys], at: new Date() };

    for (const listener of [...this.listeners]) {
      try {
        listener(change);
      } catch (error) {
        // One bad subscriber must not stop the others from being told, and
        // must not surface as a failure of the write that triggered it.
        this.logger.warn(
          `An operator-settings change listener threw: ${asMessage(error)}`,
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Extension points
  //
  // `protected` rather than private so that the test double is a variation on
  // this resolver rather than a reimplementation of it. A second
  // implementation of the layer ordering is a second thing that can disagree
  // with the registry.
  // -------------------------------------------------------------------------

  /**
   * The highest-precedence raw value supplied for a key, unparsed.
   *
   * Two layers, database over environment. The secret branch of `resolve()`
   * intercepts a SEALED row before this is reached, so what arrives here from
   * the database layer is always a plain value.
   */
  protected rawValue(
    key: OperatorSettingKey,
  ): { raw: unknown; source: OperatorSettingSource } | undefined {
    const stored = this.storedEntry(key);
    if (stored?.kind === 'value') {
      return { raw: stored.raw, source: 'database' };
    }

    return this.environmentValue(key);
  }

  /** The database layer for one key, or `undefined` when it holds no row. */
  protected storedEntry(key: OperatorSettingKey): OverlayEntry | undefined {
    return this.overlayRows.get(key);
  }

  /**
   * The environment layer for one key, or `undefined` when it is not set.
   *
   * An empty or whitespace-only variable means "not set". `.env` files are
   * full of `FOO=` written to mean "unset", and treating it as a value makes
   * every string setting resolve to '' rather than to its default — and, worse
   * for this issue, would stop the database layer from ever being reached on a
   * deployment whose `.env` still carries a bare `GITHUB_TOKEN=`.
   */
  protected environmentValue(
    key: OperatorSettingKey,
  ): { raw: string; source: OperatorSettingSource } | undefined {
    const definition = OPERATOR_SETTINGS[key];
    const env = this.environment();

    const primary = trimmedEnv(env, definition.envVar);
    if (primary !== undefined) return { raw: primary, source: 'env' };

    // The superseded name, read ONLY after the current one came back unset
    // (#422). A key whose variable was renamed must not go dark on the
    // restart that picks up the rename — `legacyEnvVar`'s own doc says why —
    // but the operator is told once, by name, so the compatibility path is
    // something they can leave rather than something they never learn about.
    if (definition.legacyEnvVar !== undefined) {
      const legacy = trimmedEnv(env, definition.legacyEnvVar);
      if (legacy !== undefined) {
        this.warnOnce(
          `legacy-env:${key}`,
          `${definition.legacyEnvVar} is still supplying ${key}. It has been ` +
            `superseded by ${definition.envVar}; rename it in your ` +
            `environment. The old name is read only while the new one is ` +
            `unset, and will stop being read.`,
        );
        return { raw: legacy, source: 'env' };
      }
    }

    return undefined;
  }

  /** Overridden by the test double so specs never depend on the host's env. */
  protected environment(): NodeJS.ProcessEnv {
    return process.env;
  }

  /**
   * What to do with a supplied value the registry rejected.
   *
   * ERROR, not warn, and it names the value in force — both because of
   * ADR-0019 (#439). While the switches that spend money or act outwardly all
   * defaulted off, a rejected value failed SAFE: the fallback was the inert
   * posture, and a warning was proportionate. Now the fallback for those keys
   * is the ACTIVE posture, so the same event means "you tried to turn
   * something off, we could not read it, and it is on". An operator who reads
   * their own `.env` and believes it needs to find that line, which means it
   * has to be at a level people filter FOR rather than filter out, and it has
   * to state the resulting value rather than leaving them to infer it.
   *
   * The widened boolean spellings (`booleanSetting`) make this rarer, which is
   * the point: what is left here is genuinely ambiguous input, not a near
   * miss.
   */
  protected onInvalid(
    key: OperatorSettingKey,
    source: OperatorSettingSource,
    reason: string,
    raw?: unknown,
    inForce?: unknown,
  ): void {
    const definition = OPERATOR_SETTINGS[key];
    const where = source === 'env' ? definition.envVar : `${source} value`;
    const supplied = raw === undefined ? '' : ` (${JSON.stringify(raw)})`;
    // The extra sentence only where it is true. For a switch the declared
    // default may be the OPPOSITE of what was meant, which is the whole of
    // why this is an error; for a timeout it is merely a different number.
    const consequence =
      definition.kind === 'boolean'
        ? ', which is the opposite of what was probably meant'
        : '';
    this.logOnce(
      `invalid:${key}`,
      'error',
      `${where}${supplied} is not a valid value for ${key}: ${reason}. ` +
        `The declared default ${JSON.stringify(inForce)} is in force ` +
        `instead${consequence}.`,
    );
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Resolve a key whose database row is a sealed secret.
   *
   * The one place in this service where an absent answer does NOT fall through
   * to the layer below. `resolveSecret` is handed the environment value so the
   * rule lives in one pure function, and it returns `'error'` — never
   * `'absent'` — for a row that will not open. Falling back to the environment
   * there would put the credential the operator rotated AWAY from back into
   * service, and every call would keep working, which is exactly why nobody
   * would look. So the value reported is the registry default (`''` for all
   * three secret keys, i.e. "not configured"), the key carries an `error`, and
   * whatever reads it reports itself unconfigured instead of silently using
   * the old credential.
   */
  private resolveSecretSetting<K extends OperatorSettingKey>(
    key: K,
    sealed: SealedSecret,
    fallback: OperatorSettingValue<K>,
  ): ResolvedOperatorSetting<K> {
    const resolution = resolveSecret({
      sealed,
      settingKey: key,
      envValue: this.environmentValue(key)?.raw ?? null,
    });

    if (resolution.state === 'error') {
      this.warnOnce(`decrypt:${key}`, resolution.message);
      return {
        key,
        value: fallback,
        source: 'default',
        error: { reason: resolution.reason, message: resolution.message },
      };
    }

    /* istanbul ignore next -- `sealed` is non-null, so 'absent' is unreachable */
    if (resolution.state === 'absent') {
      return { key, value: fallback, source: 'default' };
    }

    const parsed = parseOperatorSetting(key, resolution.value);
    if (parsed.ok) {
      return { key, value: parsed.value, source: 'database' };
    }

    this.onInvalid(key, 'database', parsed.error, resolution.value, fallback);
    return {
      key,
      value: fallback,
      source: 'default',
      invalid: { source: 'database', reason: parsed.error },
    };
  }

  /**
   * Everything a committed write still owes: re-read, audit, announce.
   *
   * The refresh comes FIRST so that `to` in the audit row, the resolved value
   * in the response, and whatever a subscriber reads are all the same fact.
   */
  private async afterWrite<K extends OperatorSettingKey>(
    key: K,
    before: ResolvedOperatorSetting<K>,
    revision: number | null,
    action: string,
    userId: string | null,
  ): Promise<OperatorSettingWriteResult<K>> {
    await this.refresh();

    const after = this.resolve(key);

    await this.writeAuditRow(key, before, after, action, userId);

    // Every write announces itself, exactly once. `refresh()` has usually
    // already done it — it diffs the overlay and emits what moved — but two
    // cases slip past that: the refresh failed (the database went away between
    // the commit and the read), or the value written is byte-for-byte the one
    // already stored, which the diff correctly reports as no change. A caller
    // that asked for a write is owed the event either way, so it is emitted
    // here when the refresh did not emit it, and never twice.
    if (!this.lastRefreshChanged.includes(key)) {
      this.notifyChanged([key]);
    }

    return { key, changed: true, revision, resolved: after };
  }

  /**
   * `{ key, from, to }` for one key, redacted — never the whole document.
   *
   * This is #337's hazard on the new path. `system-settings.service.ts` writes
   * its entire settings document into `audit_events.meta`; the moment such a
   * document holds a credential, that line puts a plaintext secret into the
   * one table nobody is allowed to go back and rewrite. Here the meta is one
   * key's before and after, and `redactSettingsMeta` is told that `from` and
   * `to` are secret fields whenever the key is — so what lands on disk is
   * `********abcd`, permanently, on the first write rather than after somebody
   * notices.
   *
   * A failed audit write does not fail the call. The change is already
   * committed and in force; answering 500 would tell the operator it did not
   * apply, which is false and is the more dangerous of the two lies. It is
   * logged at `error` so the gap is visible.
   */
  private async writeAuditRow<K extends OperatorSettingKey>(
    key: K,
    before: ResolvedOperatorSetting<K>,
    after: ResolvedOperatorSetting<K>,
    action: string,
    userId: string | null,
  ): Promise<void> {
    if (!this.prisma) return;

    const secret = OPERATOR_SETTINGS[key].secret;

    const meta = redactSettingsMeta(
      {
        key,
        from: before.value,
        to: after.value,
        fromSource: before.source,
        toSource: after.source,
      },
      // The field names carrying the value, named explicitly. The built-in
      // denylist matches on FIELD names, and `from`/`to` say nothing about
      // what they hold — so without this a sealed GitHub token would be
      // written to the audit log in the clear under a field called `from`.
      { secretKeys: secret ? ['from', 'to'] : [] },
    );

    try {
      await this.prisma.auditEvent.create({
        data: {
          actorUserId: userId,
          action,
          targetType: 'operator_settings',
          targetId: key,
          meta: meta as Prisma.InputJsonObject,
        },
      });
    } catch (error) {
      this.logger.error(
        `The audit row for ${action} on ${key} could not be written ` +
          `(${asMessage(error)}). The change itself is committed and in force.`,
      );
    }
  }

  private requireKey(key: string) {
    if (!isOperatorSettingKey(key)) {
      throw new BadRequestException(`"${key}" is not a managed setting key`);
    }
    return OPERATOR_SETTINGS[key];
  }

  private requireDatabase(): PrismaService {
    if (!this.prisma) {
      throw new Error(
        'OperatorSettingsService was constructed without a database client, ' +
          'so it cannot write. This is a wiring bug.',
      );
    }
    return this.prisma;
  }

  /**
   * Record that the overlay is not in force, keeping whatever was last loaded.
   *
   * The rows are DELIBERATELY not dropped. A transient blip — the external
   * PostgreSQL container this deployment shares being restarted by somebody
   * else — must not silently revert every operator override to its env value
   * mid-flight; that would be a configuration change nobody made. `stale`
   * distinguishes the two cases the status alone cannot: an overlay that was
   * loaded and may now be out of date, versus no overlay at all, which is the
   * boot-without-database case where env values really are what is in force.
   */
  private markUnavailable(
    attemptedAt: Date,
    problem: string,
  ): OperatorSettingsOverlayState {
    const stale = this.overlayState.loadedAt !== null;

    this.lastRefreshChanged = [];
    this.overlayState = {
      status: 'unavailable',
      loadedAt: this.overlayState.loadedAt,
      attemptedAt,
      revision: this.overlayState.revision,
      overriddenKeys: this.overlayRows.size,
      warning: OPERATOR_SETTINGS_OVERLAY_UNAVAILABLE,
      problem,
      stale,
    };

    this.warnOnce(
      'overlay',
      `${OPERATOR_SETTINGS_OVERLAY_UNAVAILABLE}: the operator settings ` +
        `overlay could not be read (${problem}). ` +
        (stale
          ? 'The last loaded overrides stay in force and may be out of date.'
          : 'Environment values are in force and NO stored override is applied.') +
        ` Retrying every ${OPERATOR_SETTINGS_REFRESH_INTERVAL_MS}ms.`,
    );

    return this.overlayState;
  }

  /**
   * Log once per reason.
   *
   * `refresh()` runs every 15 seconds and `get()` runs on hot paths; without
   * this, one broken row would produce a log line per read forever, which is
   * how a real warning becomes invisible.
   */
  private warnOnce(reason: string, message: string): void {
    this.logOnce(reason, 'warn', message);
  }

  /** The same de-duplication, for the one reason that is an error (#439). */
  private logOnce(
    reason: string,
    level: 'warn' | 'error',
    message: string,
  ): void {
    if (this.warned.has(reason)) return;
    this.warned.add(reason);
    this.logger[level](message);
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** The five columns that carry a value, in either of the two legal shapes. */
type StoredColumns = Pick<
  Prisma.OperatorSettingUncheckedCreateInput,
  | 'value'
  | 'secretCiphertext'
  | 'secretIv'
  | 'secretAuthTag'
  | 'secretKeyVersion'
>;

/**
 * A non-secret value, with the whole ciphertext group explicitly nulled.
 *
 * Explicitly, and not by omission, because this is also the UPDATE path: a key
 * that used to hold a secret and is now being given a plain value would
 * otherwise keep its old ciphertext columns and the row would violate
 * `operator_settings_value_xor_secret_check` at the database.
 *
 * `Prisma.JsonNull` and not `null` for a null value, because
 * `dispatch.maxConcurrent` legitimately resolves to `null` meaning "no
 * ceiling", and the row must still carry a `value` the CHECK can see.
 *
 * The cast is required regardless: `Prisma.InputJsonValue` does not include
 * `null`, so a bare `null` does not compile. What it is NOT is a runtime
 * guard against writing SQL NULL — that was measured against the pinned
 * `@prisma/client@7.8.0` with `@prisma/adapter-pg`, and a bare `null` produces
 * byte-identical JSONB (`value = 'null'::jsonb`, `IS NOT NULL`) to the
 * sentinel. Stated precisely because a comment that claims a guarantee the
 * code does not provide is worse than no comment: the next person to touch
 * this would trust it.
 *
 * The neighbouring mistake IS real and IS caught: `Prisma.DbNull` writes SQL
 * NULL and trips `operator_settings_value_xor_secret_check` with a 23514,
 * proven in `operator-settings-service-write-path.integration.spec.ts`.
 */
function plainColumns(value: unknown): StoredColumns {
  return {
    value: value === null ? Prisma.JsonNull : (value as Prisma.InputJsonValue),
    secretCiphertext: null,
    secretIv: null,
    secretAuthTag: null,
    secretKeyVersion: null,
  };
}

/** A sealed secret, with `value` explicitly set to SQL NULL for the same reason. */
function sealedColumns(sealed: SealedSecret): StoredColumns {
  return {
    value: Prisma.DbNull,
    secretCiphertext: sealed.ciphertext,
    secretIv: sealed.iv,
    secretAuthTag: sealed.authTag,
    secretKeyVersion: sealed.keyVersion,
  };
}

/**
 * Which of the two shapes a row is in.
 *
 * Decided by the ciphertext column and not by `value`, because a JSON `null`
 * comes back from Prisma as JavaScript `null` and is indistinguishable from an
 * absent column at this level. The CHECK constraint guarantees the ciphertext
 * group is all-or-nothing, so one field is enough to tell them apart.
 */
function toOverlayEntry(row: {
  value: Prisma.JsonValue;
  secretCiphertext: string | null;
  secretIv: string | null;
  secretAuthTag: string | null;
  secretKeyVersion: number | null;
}): OverlayEntry {
  if (row.secretCiphertext !== null) {
    return {
      kind: 'secret',
      sealed: {
        ciphertext: row.secretCiphertext,
        iv: row.secretIv ?? '',
        authTag: row.secretAuthTag ?? '',
        keyVersion: row.secretKeyVersion ?? -1,
      },
    };
  }

  return { kind: 'value', raw: row.value };
}

/** A stable identity for an overlay entry, for change detection. */
function fingerprint(entry: OverlayEntry): string {
  return entry.kind === 'value'
    ? `v:${JSON.stringify(entry.raw) ?? 'undefined'}`
    : // The ciphertext and nonce together: a re-seal of the same plaintext
      // produces a different nonce, so this reports a change on every write,
      // which is correct — the row was written, and a subscriber re-reads
      // rather than acting on a payload.
      `s:${entry.sealed.keyVersion}:${entry.sealed.iv}:${entry.sealed.ciphertext}`;
}

/** Keys that were added, removed, or changed between two overlays. */
function diffOverlays(
  previous: ReadonlyMap<OperatorSettingKey, OverlayEntry>,
  next: ReadonlyMap<OperatorSettingKey, OverlayEntry>,
): OperatorSettingKey[] {
  const changed: OperatorSettingKey[] = [];

  for (const [key, entry] of next) {
    const before = previous.get(key);
    if (before === undefined || fingerprint(before) !== fingerprint(entry)) {
      changed.push(key);
    }
  }

  for (const key of previous.keys()) {
    if (!next.has(key)) changed.push(key);
  }

  return changed;
}

/**
 * One environment variable, with empty-means-unset applied.
 *
 * Shared by the current and the superseded name so the two cannot disagree
 * about what "set" means — a `.env` full of `FOO=` written to mean "unset"
 * would otherwise stop the legacy fallback from ever being reached.
 */
function trimmedEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
