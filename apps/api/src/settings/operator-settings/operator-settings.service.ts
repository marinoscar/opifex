import { Injectable, Logger } from '@nestjs/common';

import {
  OPERATOR_SETTINGS,
  OPERATOR_SETTING_KEYS,
  parseOperatorSetting,
  type OperatorSettingKey,
  type OperatorSettingValue,
  type OperatorSettingsSnapshot,
} from './operator-settings.registry';

/**
 * Where a resolved value came from.
 *
 * `'database'` is not produced yet — #339 adds the overlay. It is named here
 * so that the layer ordering is stated in one place from the start, rather
 * than being a thing the overlay invents when it arrives.
 */
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
 * The read path for operator-managed settings (#335, epic #332).
 *
 * ## What this resolves, in this issue
 *
 * `default -> env`, and nothing else. There is no database, no HTTP and no
 * migrated consumer here: #336 adds the table, #339 adds the overlay and the
 * refresh loop, #340-#344 move the consumers across. What ships now is the
 * vocabulary everything downstream is built against.
 *
 * ## Why `get()` is synchronous, and must stay that way
 *
 * Every consumer that will migrate reads its configuration synchronously —
 * `runner-registration.service.ts:536`, `dispatch.service.ts:96`,
 * `run-executor.service.ts:272`, `fleet-state.service.ts:496` — and several
 * are inside pure decision functions or property getters where there is no
 * `await` to add. An async read would turn a one-line swap into a signature
 * change rippling through half the fleet, and every one of those signatures is
 * a place a mistake could hide. So the overlay in #339 refreshes into memory
 * on a loop and this stays a memory read.
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
 */
@Injectable()
export class OperatorSettingsService {
  private readonly logger = new Logger(OperatorSettingsService.name);

  /** Keys already complained about, so a hot path logs once and not per read. */
  private readonly warned = new Set<OperatorSettingKey>();

  private readonly listeners = new Set<OperatorSettingsChangeListener>();

  /**
   * The current value of one managed key. Never throws, never returns
   * `undefined`: every key has a declared default.
   */
  get<K extends OperatorSettingKey>(key: K): OperatorSettingValue<K> {
    return this.resolve(key).value;
  }

  /** The current value plus where it came from. */
  resolve<K extends OperatorSettingKey>(key: K): ResolvedOperatorSetting<K> {
    const supplied = this.rawValue(key);
    const fallback = OPERATOR_SETTINGS[key].default as OperatorSettingValue<K>;

    if (supplied === undefined) {
      return { key, value: fallback, source: 'default' };
    }

    const parsed = parseOperatorSetting(key, supplied.raw);
    if (parsed.ok) {
      return { key, value: parsed.value, source: supplied.source };
    }

    this.onInvalid(key, supplied.source, parsed.error);

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
      (snapshot as Record<string, unknown>)[key] = this.get(key);
    }
    return snapshot;
  }

  /**
   * Subscribe to changes. Returns the unsubscribe.
   *
   * Nothing subscribes yet, and that is expected: the emitter exists so that
   * #339's refresh loop and #343's interval re-registration have something to
   * hang off, rather than each inventing its own notification and them
   * disagreeing about ordering.
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
   * @internal Called by the write path (#338) and the refresh loop (#339)
   * AFTER a change is committed and visible to `get()`. Calling it before that
   * would have subscribers re-read the old value and treat it as the new one.
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
          `An operator-settings change listener threw: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Extension points
  //
  // Both are `protected` rather than private so that the test double and
  // #339's database overlay are variations on this resolver rather than
  // reimplementations of it. A second implementation of the layer ordering is
  // a second thing that can disagree with the registry.
  // -------------------------------------------------------------------------

  /**
   * The highest-precedence raw value supplied for a key, unparsed.
   *
   * The base implementation has one layer: the process environment. #339 adds
   * the database above it.
   */
  protected rawValue(
    key: OperatorSettingKey,
  ): { raw: unknown; source: OperatorSettingSource } | undefined {
    const raw = this.environment()[OPERATOR_SETTINGS[key].envVar];
    if (raw === undefined) return undefined;

    // An empty or whitespace-only variable means "not set". `.env` files are
    // full of `FOO=` written to mean "unset", and treating it as a value makes
    // every string setting resolve to '' rather than to its default.
    const trimmed = raw.trim();
    if (trimmed === '') return undefined;

    return { raw: trimmed, source: 'env' };
  }

  /** Overridden by the test double so specs never depend on the host's env. */
  protected environment(): NodeJS.ProcessEnv {
    return process.env;
  }

  /** What to do with a supplied value the registry rejected. */
  protected onInvalid(
    key: OperatorSettingKey,
    source: OperatorSettingSource,
    reason: string,
  ): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);

    const where =
      source === 'env' ? OPERATOR_SETTINGS[key].envVar : `${source} value`;
    this.logger.warn(
      `${where} is not a valid value for ${key} (${reason}); using the default instead`,
    );
  }
}
