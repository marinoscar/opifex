import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import {
  OPERATOR_SETTINGS,
  OPERATOR_SETTING_KEYS,
} from '../../src/settings/operator-settings/operator-settings.registry';
import {
  DEFAULT_SUPERVISOR_MODEL_PROVIDER,
  MODEL_CONSUMERS,
  SUPERVISOR_MODEL_PROVIDERS,
  modelApiKeyEnvVar,
  modelApiKeySettingKey,
  modelBaseUrlEnvVar,
  modelBaseUrlSettingKey,
  modelProviderSettingKey,
} from '../../src/supervisor/invocation/supervisor-model.config';

/**
 * **Nothing outside `invocation/` names the supervisor's model provider.**
 * (#392, epic #391, ADR-0015.)
 *
 * `supervisor-model.port.ts` has said this since #89 — "this interface is what
 * a supervisor adapter implements, and nothing outside `invocation/` may name
 * a model provider" — and until #392 there was exactly one vendor behind the
 * seam, so the claim cost nothing and was never checked. A second adapter is
 * the moment it starts to be worth something, and also the moment it becomes
 * easy to break: the natural way to add a provider is a `switch` in whatever
 * file happens to need one, and each such branch is individually reasonable.
 *
 * ## Why a source test and not a behaviour test
 *
 * Same reason `managed-keys-off-config.spec.ts` gives. A behaviour test proves
 * the code paths somebody thought to exercise go through the seam. Only a
 * claim about the SOURCE proves there is no second path left to add one. The
 * failure this guards against is not a wrong answer, it is a provider named in
 * a place that will have to be found and changed when a third one arrives.
 *
 * ## What it claims, precisely
 *
 * Three things, none of them "the word Anthropic appears nowhere":
 *
 * 1. **No provider is named as a VALUE.** A bare `'anthropic'` or `'openai'`
 *    string literal in code is a selection, a comparison or a default — the
 *    three shapes a leak actually takes. Prose that mentions a vendor in a
 *    `help` string is not that, and is left alone deliberately: an operator
 *    reading "a separately metered credential" is owed the vendor's name.
 * 2. **No provider's endpoint is named.** `PROVIDER_BASE_URLS` is the one
 *    place a host belongs, because #392 made the base URL derive from the
 *    provider and a second copy of a host would silently stop deriving.
 * 3. **No module path names a provider.** This is the one the repository was
 *    already failing before #392: `supervisor.module.ts` and the Test-button
 *    probe both imported out of `anthropic-supervisor-model.ts`, so the seam
 *    was vendor-neutral in its code and not in its import graph.
 *
 * And, positively: the registry takes the provider vocabulary FROM
 * `invocation/` rather than restating it, which is what keeps the settings
 * layer honest about (1).
 *
 * ## What it does NOT claim
 *
 * It says nothing about `.spec.ts` files, and skips them exactly as
 * `supervisor-offline.spec.ts` skips them in its own structural half. A spec
 * that proves a consumer FOLLOWS the provider setting has to name a provider
 * to prove it — `runner.seam.spec.ts` lists `anthropic` and `openai` among the
 * vendors it proves the runner seam never types, and the probe suite names one
 * to prove the Test button reaches the configured host rather than a fixed
 * one. A rule that fired on those would be forbidding the assertion instead of
 * the leak.
 *
 * The claim that is left is the one the port's sentence is actually about: no
 * PRODUCTION code outside `invocation/` names a provider. A leak is a branch,
 * a default or an import in shipping code, and a spec cannot put one there.
 *
 * ## When this fails
 *
 * Read the provider through `resolveSupervisorModelConfig` and branch inside
 * `invocation/`, or add an adapter there. Do not add an exclusion list — there
 * is deliberately none, because the one file that would want to be on it is
 * this one, and skipping specs already covers it.
 */

const API_ROOT = join(__dirname, '..', '..');

/** The one directory allowed to know which vendors exist. */
const INVOCATION_DIR = join('src', 'supervisor', 'invocation').concat(sep);

/** Every non-spec `.ts` under a directory. See "What it does NOT claim". */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts'))
      out.push(full);
  }
  return out;
}

/** Every production `.ts` under `src/` and `test/`, as API-relative paths. */
function scannedFiles(): string[] {
  return [
    ...sourceFiles(join(API_ROOT, 'src')),
    ...sourceFiles(join(API_ROOT, 'test')),
  ].map((full) => relative(API_ROOT, full));
}

/**
 * The file with comment lines removed and whitespace flattened.
 *
 * Comments go first, for the reason `managed-keys-off-config.spec.ts` gives:
 * these files DISCUSS Anthropic and OpenAI at length in order to explain the
 * seam, and a whole-file search would fire on the documentation that makes the
 * change legible. Whitespace is flattened after, so a call Prettier wrapped
 * over three lines is matched by the same expression as one that fits on one.
 */
function codeOf(path: string): string {
  return readFileSync(join(API_ROOT, path), 'utf8')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return (
        !trimmed.startsWith('*') &&
        !trimmed.startsWith('//') &&
        !trimmed.startsWith('/*')
      );
    })
    .join('\n')
    .replace(/\s+/g, ' ');
}

/** A provider id used as a value: `'openai'`, `"anthropic"`. */
const PROVIDER_LITERAL = /['"](?:anthropic|openai)['"]/i;

/** A provider's API host, however it is spelled into a URL. */
const PROVIDER_HOST = /api\.(?:anthropic|openai)\.com/i;

/** An import whose MODULE PATH names a vendor. */
const PROVIDER_IMPORT = /from\s+['"][^'"]*(?:anthropic|openai)[^'"]*['"]/i;

const RULES: readonly { what: string; pattern: RegExp }[] = [
  { what: 'names a provider as a value', pattern: PROVIDER_LITERAL },
  { what: "names a provider's API host", pattern: PROVIDER_HOST },
  { what: 'imports from a provider-named module', pattern: PROVIDER_IMPORT },
];

describe('GOVERNING TEST: the supervisor model seam names no vendor (#392)', () => {
  const files = scannedFiles();
  const inside = files.filter((path) => path.startsWith(INVOCATION_DIR));
  const outside = files.filter((path) => !path.startsWith(INVOCATION_DIR));

  it('scans a plausible number of files, so a broken walk cannot pass vacuously', () => {
    // Without this, a `sourceFiles` that returned nothing would make every
    // assertion below trivially true — the exact shape of green-for-the-wrong-
    // reason a structural test is most exposed to.
    expect(files.length).toBeGreaterThan(200);
    expect(outside.length).toBeGreaterThan(200);
    // A production file that would obviously be tempted to name a vendor: the
    // module whose import list did exactly that before #392.
    expect(outside).toContain(
      join('src', 'supervisor', 'supervisor.module.ts'),
    );
    expect(inside).toContain(
      join('src', 'supervisor', 'invocation', 'supervisor-model.config.ts'),
    );
  });

  describe.each(RULES)('$what', ({ pattern }) => {
    it('matches inside invocation/, so the rule is not a dead regex', () => {
      // The other half of the vacuity guard. A pattern that had stopped
      // matching anything — a renamed file, an escaped dot, a lost alternation
      // — would report zero offenders forever and look like a passing test.
      expect(inside.filter((path) => pattern.test(codeOf(path)))).not.toEqual(
        [],
      );
    });

    it('matches nowhere outside it', () => {
      expect(outside.filter((path) => pattern.test(codeOf(path)))).toEqual([]);
    });
  });

  describe('the settings layer takes the vocabulary from invocation/', () => {
    it('offers exactly the providers there are adapters for, to EVERY consumer', () => {
      // Not a copy that happens to agree today. `values` IS the exported
      // array, so a third adapter appears in the Control Center's dropdown
      // without anyone remembering to widen the registry — and, more to the
      // point, a provider cannot appear there that no adapter implements.
      //
      // Asserted per consumer since #423, by IDENTITY rather than by value.
      // A second consumer is exactly where a hand-written vendor list would
      // reappear: writing `values: ['anthropic', 'openai']` into the chat's
      // row would satisfy every regex above — the strings sit inside an array
      // literal that the rules do scan, but a `toEqual` here would pass on a
      // copy that agrees today and drifts on the day a third adapter lands.
      // `toBe` is what makes the registry take the vocabulary rather than
      // restate it.
      expect(MODEL_CONSUMERS.length).toBeGreaterThan(1);

      for (const consumer of MODEL_CONSUMERS) {
        expect(
          OPERATOR_SETTINGS[modelProviderSettingKey(consumer)].values,
        ).toBe(SUPERVISOR_MODEL_PROVIDERS);
      }
    });

    it('defaults every consumer to the provider ADR-0015 shipped, so nothing changes for an existing deployment', () => {
      // #392's first acceptance criterion. A default that changed which vendor
      // an unchanged deployment calls would be a silent outage at best, and a
      // call billed to the wrong account at worst. The chat inherits the same
      // default for a weaker but real reason: it is inert until a model is
      // named, so the provider it starts on decides only which credential
      // slot an operator is offered first.
      for (const consumer of MODEL_CONSUMERS) {
        expect(
          OPERATOR_SETTINGS[modelProviderSettingKey(consumer)].default,
        ).toBe(DEFAULT_SUPERVISOR_MODEL_PROVIDER);
      }
      expect(DEFAULT_SUPERVISOR_MODEL_PROVIDER).toBe('anthropic');
    });

    it('gives a consumer no credential of its own to name a vendor with', () => {
      // The credential/consumer split, stated as the absence it is (#422,
      // #423). A `chat.model.apiKey` would not name a vendor in its KEY, so
      // the regexes above would not fire — and it would still be the thing
      // both issues exist to prevent: a credential that belongs to a consumer
      // instead of to the provider it is sent to.
      const consumerCredentials = OPERATOR_SETTING_KEYS.filter(
        (key) =>
          MODEL_CONSUMERS.some((consumer) => key.startsWith(`${consumer}.`)) &&
          (key.endsWith('.apiKey') || key.endsWith('.baseUrl')),
      );

      expect(consumerCredentials).toEqual([]);
    });

    it('offers one credential slot per provider, generated from the same list', () => {
      // #422's structural claim, and the reason this belongs in THIS file
      // rather than in the registry's own spec. The credential keys are
      // GENERATED from `SUPERVISOR_MODEL_PROVIDERS`, so a third adapter gets
      // its own key slot, base URL, env variables and Control Center card
      // without an edit to the settings layer — and, more to the point, the
      // settings layer cannot grow a hand-written vendor list that drifts from
      // the adapters. A registry that hard-coded two entries would satisfy the
      // regexes above (`'models.anthropic.apiKey'` is not a bare provider
      // literal) and still be the second declaration point #332 exists to
      // remove, so the regexes cannot carry this claim on their own.
      for (const provider of SUPERVISOR_MODEL_PROVIDERS) {
        const apiKey = OPERATOR_SETTINGS[modelApiKeySettingKey(provider)];
        const baseUrl = OPERATOR_SETTINGS[modelBaseUrlSettingKey(provider)];

        expect(apiKey.secret).toBe(true);
        expect(apiKey.envVar).toBe(modelApiKeyEnvVar(provider));
        // No vendor's host as a default, per provider — #392's rule, which
        // survived the split. Empty means "follow the provider"; see
        // `effectiveBaseUrl` for why "overridden" is a property of the value
        // rather than of where the value came from.
        expect(baseUrl.default).toBe('');
        expect(baseUrl.envVar).toBe(modelBaseUrlEnvVar(provider));
      }

      // And no slot survives for a provider that has no adapter.
      const slots = OPERATOR_SETTING_KEYS.filter((key) =>
        key.startsWith('models.'),
      );
      expect(slots.length).toBe(SUPERVISOR_MODEL_PROVIDERS.length * 2);
    });

    it('no longer pairs one credential with one provider', () => {
      // The regression #422 closes, stated as the absence it is. The old key
      // WAS the coupling: one secret slot next to one provider setting, so
      // that switching provider found the same credential and posted it to a
      // host that would reject it — and re-entering was the only way to try
      // the other vendor, destroying the first key.
      expect(OPERATOR_SETTING_KEYS).not.toContain('supervisor.model.apiKey');
      expect(OPERATOR_SETTING_KEYS).not.toContain('supervisor.model.baseUrl');
    });
  });
});
