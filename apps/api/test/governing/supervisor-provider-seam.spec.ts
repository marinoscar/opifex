import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { OPERATOR_SETTINGS } from '../../src/settings/operator-settings/operator-settings.registry';
import {
  DEFAULT_SUPERVISOR_MODEL_PROVIDER,
  SUPERVISOR_MODEL_PROVIDERS,
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
 * ## When this fails
 *
 * Read the provider through `resolveSupervisorModelConfig` and branch inside
 * `invocation/`, or add an adapter there. Do not add a file to the exclusion
 * list below — there are two, both of them tests that name vendors in order to
 * forbid them, which is what this file does too.
 */

const API_ROOT = join(__dirname, '..', '..');

/** The one directory allowed to know which vendors exist. */
const INVOCATION_DIR = join('src', 'supervisor', 'invocation').concat(sep);

/**
 * The two files that name vendors in order to assert their absence.
 *
 * `runner.seam.spec.ts` is #60's version of this same test for the RUNNER
 * seam, and it lists `anthropic` and `openai` among the vendors it proves the
 * seam never types. Excluding it is not a hole: it is the same claim, made
 * about a different seam, and a rule that fired on it would be forbidding the
 * assertion rather than the leak.
 */
const EXCLUDED = [
  join('src', 'runners', 'runner.seam.spec.ts'),
  join('test', 'governing', 'supervisor-provider-seam.spec.ts'),
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Every `.ts` under `src/` and `test/`, as API-relative paths. */
function scannedFiles(): string[] {
  return [
    ...sourceFiles(join(API_ROOT, 'src')),
    ...sourceFiles(join(API_ROOT, 'test')),
  ]
    .map((full) => relative(API_ROOT, full))
    .filter((path) => !EXCLUDED.includes(path));
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
    it('offers exactly the providers there are adapters for', () => {
      // Not a copy that happens to agree today. `values` IS the exported
      // array, so a third adapter appears in the Control Center's dropdown
      // without anyone remembering to widen the registry — and, more to the
      // point, a provider cannot appear there that no adapter implements.
      expect(OPERATOR_SETTINGS['supervisor.model.provider'].values).toBe(
        SUPERVISOR_MODEL_PROVIDERS,
      );
    });

    it('defaults to the provider ADR-0015 shipped, so nothing changes for an existing deployment', () => {
      // #392's first acceptance criterion. A default that changed which vendor
      // an unchanged deployment calls would be a silent outage at best, and a
      // call billed to the wrong account at worst.
      expect(OPERATOR_SETTINGS['supervisor.model.provider'].default).toBe(
        DEFAULT_SUPERVISOR_MODEL_PROVIDER,
      );
      expect(DEFAULT_SUPERVISOR_MODEL_PROVIDER).toBe('anthropic');
    });

    it('no longer defaults the base URL to one vendor’s host', () => {
      // The key that made switching provider a two-step operation. Empty means
      // "follow the provider"; see `effectiveBaseUrl` for why "overridden" is
      // a property of the value rather than of where the value came from.
      expect(OPERATOR_SETTINGS['supervisor.model.baseUrl'].default).toBe('');
    });
  });
});
