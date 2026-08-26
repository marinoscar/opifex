import {
  isOperatorSettingKey,
  parseOperatorSetting,
  type OperatorSettingKey,
  type OperatorSettingValue,
  type OperatorSettingsOverrides,
} from './operator-settings.registry';
import {
  OperatorSettingsService,
  type OperatorSettingSource,
  type OperatorSettingsChange,
} from './operator-settings.service';

/**
 * The test double for `OperatorSettingsService` (#335).
 *
 * ## Why this ships in the same PR as the registry, and not later
 *
 * Roughly 200 specs currently stub `ConfigService.get`. When #340 moves a
 * consumer onto `OperatorSettingsService`, every one of those stubs stops
 * being read — and the spec does not fail. It quietly starts exercising the
 * registry's defaults, which for `dispatch.enabled`, `github.writesEnabled`,
 * `reconciler.enabled`, `supervisor.enabled` and the runner are all *off*. A
 * spec written to prove that dispatch happens would then pass by proving that
 * nothing happened.
 *
 * Green for the wrong reason is the highest-probability quiet failure in this
 * epic, and it is invisible in review precisely because the diff that causes it
 * touches production code and not the spec. So the double exists before the
 * first consumer moves, and a migrating PR replaces a `ConfigService` stub with
 * `makeOperatorSettings({ overrides: { ... } })` in the same commit.
 *
 * ## Three deliberate differences from the real service
 *
 * 1. **It ignores `process.env` by default.** A spec that resolved the host's
 *    environment would pass or fail depending on whose machine ran it, and
 *    `RECONCILER_ENABLED` being exported in a developer's shell is not a thing
 *    CI should be able to disagree with. Pass `env` explicitly to test the
 *    environment layer itself.
 * 2. **An invalid override throws.** The real service falls back to the default
 *    and warns, because a misconfigured deployment must still boot. A spec has
 *    no such claim on charity: an override that does not parse is a spec
 *    asserting against a value it never actually set, which is the exact
 *    failure this file exists to prevent.
 * 3. **Emitted changes are recorded**, so a spec can assert that a write
 *    announced itself without having to attach a listener first.
 *
 * ## Values still go through the registry
 *
 * `overrides` are parsed by `parseOperatorSetting`, not assigned. A double that
 * bypassed the registry's parsing would let a spec set a value the real service
 * could never produce — and then the code under test would be proven correct
 * against an input that cannot occur.
 */
export class FakeOperatorSettingsService extends OperatorSettingsService {
  private readonly overrides = new Map<OperatorSettingKey, unknown>();

  /** Every change announced through `notifyChanged`, in order. */
  readonly changes: OperatorSettingsChange[] = [];

  constructor(
    overrides: OperatorSettingsOverrides,
    private readonly env: NodeJS.ProcessEnv,
  ) {
    super();
    for (const [key, value] of Object.entries(overrides)) {
      // Applied WITHOUT announcing: a spec's starting configuration is not a
      // change, and `changes` must begin empty or every assertion about what a
      // write announced would have to subtract the setup first.
      this.applyOverride(key as OperatorSettingKey, value as never);
    }
  }

  private applyOverride<K extends OperatorSettingKey>(
    key: K,
    value: OperatorSettingValue<K>,
  ): void {
    if (!isOperatorSettingKey(key)) {
      throw new Error(
        `makeOperatorSettings: "${key}" is not a managed setting key`,
      );
    }

    const parsed = parseOperatorSetting(key, value);
    if (!parsed.ok) {
      throw new Error(
        `makeOperatorSettings: ${String(value)} is not a valid value for ${key} (${parsed.error})`,
      );
    }

    this.overrides.set(key, parsed.value);
  }

  /**
   * Set one override, as the real write path (#338) eventually will.
   *
   * Announces the change, so a spec can drive the "operator flips a switch
   * while the system is running" scenario the three `reload` semantics exist to
   * describe — which is what #352 has to test.
   */
  setOverride<K extends OperatorSettingKey>(
    key: K,
    value: OperatorSettingValue<K>,
  ): this {
    this.applyOverride(key, value);
    this.notifyChanged([key]);
    return this;
  }

  /** Drop one override, or all of them, falling back to env and defaults. */
  clearOverride(key?: OperatorSettingKey): this {
    const cleared = key ? [key] : [...this.overrides.keys()];
    if (key) this.overrides.delete(key);
    else this.overrides.clear();
    this.notifyChanged(cleared);
    return this;
  }

  override notifyChanged(keys: readonly OperatorSettingKey[]): void {
    if (keys.length > 0) {
      this.changes.push({ keys: [...keys], at: new Date() });
    }
    super.notifyChanged(keys);
  }

  protected override rawValue(
    key: OperatorSettingKey,
  ): { raw: unknown; source: OperatorSettingSource } | undefined {
    if (this.overrides.has(key)) {
      // Reported as 'database' rather than inventing a fourth source: an
      // override stands in for the operator-set value the overlay (#339) will
      // supply, and any code branching on provenance should be exercised on
      // the branch it will really take.
      return { raw: this.overrides.get(key), source: 'database' };
    }
    return super.rawValue(key);
  }

  protected override environment(): NodeJS.ProcessEnv {
    return this.env;
  }

  protected override onInvalid(
    key: OperatorSettingKey,
    source: OperatorSettingSource,
    reason: string,
  ): void {
    if (source === 'database') {
      throw new Error(
        `makeOperatorSettings: the override for ${key} is invalid (${reason})`,
      );
    }
    super.onInvalid(key, source, reason);
  }
}

export interface MakeOperatorSettingsOptions {
  /** Values that win over both the environment and the declared defaults. */
  overrides?: OperatorSettingsOverrides;
  /**
   * The environment layer. Empty by default so specs are hermetic — pass
   * `process.env` explicitly if that is genuinely what is under test.
   */
  env?: NodeJS.ProcessEnv;
}

/**
 * Build an `OperatorSettingsService` for a spec.
 *
 * ```ts
 * const settings = makeOperatorSettings({
 *   overrides: { 'dispatch.enabled': true, 'dispatch.maxConcurrent': 2 },
 * });
 *
 * const moduleRef = await Test.createTestingModule({ providers: [MyService] })
 *   .useMocker(...)
 *   .overrideProvider(OperatorSettingsService)
 *   .useValue(settings)
 *   .compile();
 * ```
 *
 * Unspecified keys resolve to their registry defaults, which are the same
 * defaults production uses — so a spec that needs a switch ON has to say so,
 * out loud, in a line a reviewer can see.
 */
export function makeOperatorSettings(
  options: MakeOperatorSettingsOptions = {},
): FakeOperatorSettingsService {
  return new FakeOperatorSettingsService(
    options.overrides ?? {},
    options.env ?? {},
  );
}
