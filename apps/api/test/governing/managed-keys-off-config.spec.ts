import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { DEFAULT_DEADLINE_GRACE_MINUTES } from '../../src/budget/run-deadline';
import {
  OPERATOR_SETTINGS,
  OPERATOR_SETTING_KEYS,
  operatorSettingEntries,
} from '../../src/settings/operator-settings/operator-settings.registry';

/**
 * A managed key has exactly ONE read path, asserted over the source (#340).
 *
 * ## Why a source test and not a behaviour test
 *
 * The failure this guards against is not a wrong value, it is a value nobody
 * reads. #340's problem statement is exact: *"while a managed key can be read
 * from both `configuration.ts` and the resolver, a consumer that was missed is
 * a setting that appears to work in the UI and changes nothing."* A behaviour
 * test proves the consumers somebody thought to test read the resolver. Only a
 * claim about the source proves there is no second path left to read.
 *
 * It is also the thing that stops the old path growing back. Adding
 * `config.get('dispatch.enabled')` back to a service is a one-line change that
 * typechecks, passes every existing suite, and produces a setting the Control
 * Center cannot move. Written in the style of `autonomy-purity.spec.ts` and
 * `supervisor-offline.spec.ts`, which make the same kind of claim for the same
 * kind of reason.
 *
 * ## What it does NOT claim
 *
 * It does not claim `ConfigService` is unused — it is the right home for
 * `POSTGRES_*`, `JWT_*`, `GOOGLE_*`, AWS/S3, `OTEL_*`, ports and URLs, and
 * epic #332 deliberately leaves those there. The claim is narrower: no MANAGED
 * key is reachable through it.
 *
 * When this fails, the fix is to read the key through `OperatorSettingsService`
 * — not to add the file to an exclusion list. The two exclusions below are the
 * settings module itself, which necessarily names every key, and this file.
 */

const API_ROOT = join(__dirname, '..', '..');

/** Where the registry, the resolver and the double live. */
const OPERATOR_SETTINGS_DIR = join(
  'src',
  'settings',
  'operator-settings',
).concat(sep);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Every `.ts` under `src/` and `test/`, as repository-relative paths. */
function scannedFiles(): string[] {
  return [
    ...sourceFiles(join(API_ROOT, 'src')),
    ...sourceFiles(join(API_ROOT, 'test')),
  ]
    .map((full) => relative(API_ROOT, full))
    .filter(
      (path) =>
        !path.startsWith(OPERATOR_SETTINGS_DIR) &&
        !path.endsWith('managed-keys-off-config.spec.ts'),
    );
}

/**
 * The file with comment lines removed and whitespace flattened.
 *
 * Comments go first, for the reason `autonomy-purity.spec.ts` gives: these
 * files discuss `config.get('dispatch.enabled')` at length in order to explain
 * why they no longer call it, and a whole-file search would fire on the
 * documentation that makes the change legible.
 *
 * Whitespace is flattened AFTER that, so a call Prettier wrapped over three
 * lines — `this.config\n  .get<string>('github.token')` — is matched by the
 * same expression as a call that fits on one. A regex that only matched the
 * single-line form would be defeated by a formatter.
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

/**
 * A `ConfigService` read of one specific key, however it is spelled.
 *
 * Covers `config.get('k')`, `configService.get('k')`, `this.config.get('k')`
 * and the generic forms `get<string>('k')` / `get<number | null>('k')`, in
 * single or double quotes. The receiver has to LOOK like a config service:
 * matching a bare `.get('k')` would fire on `settings.get('k')`, which is the
 * call this whole issue exists to produce.
 */
function configReadOf(key: string): RegExp {
  const escaped = key.replace(/\./g, '\\.');
  return new RegExp(
    String.raw`\bconfig(?:Service)?\s*\.\s*get\s*(?:<[^>]*>)?\s*\(\s*['"]${escaped}['"]`,
    'i',
  );
}

describe('managed settings have one read path (#340, epic #332)', () => {
  const files = scannedFiles();

  it('scans a plausible number of files, so a broken walk cannot pass vacuously', () => {
    // Without this, a `sourceFiles` that returned nothing would make every
    // assertion below trivially true — the exact shape of green-for-the-wrong-
    // reason this issue is most exposed to.
    expect(files.length).toBeGreaterThan(200);
    expect(files).toContain(join('src', 'dispatch', 'dispatch.service.ts'));
  });

  it('enumerates the registry rather than a hand-written list', () => {
    // The list this file checks IS the registry. A key added tomorrow is
    // covered without anyone remembering to add it here, which is the only
    // version of this test that stays true.
    expect(OPERATOR_SETTING_KEYS.length).toBeGreaterThan(0);
    expect(OPERATOR_SETTING_KEYS).toContain('dispatch.enabled');
  });

  describe.each(OPERATOR_SETTING_KEYS)('%s', (key) => {
    it('is never read through ConfigService', () => {
      const pattern = configReadOf(key);
      const offenders = files.filter((path) => pattern.test(codeOf(path)));

      expect(offenders).toEqual([]);
    });
  });

  it('is not manufactured by configuration.ts under any of its variable names', () => {
    // The complementary half. A key could vanish from every `config.get()`
    // call and still be built here, which would leave the old path one line of
    // rediscovery away — and would leave `configuration.ts` documenting a
    // default that no longer decides anything.
    const configuration = codeOf(join('src', 'config', 'configuration.ts'));

    const present = operatorSettingEntries()
      .map(([, definition]) => definition.envVar)
      .filter((envVar) =>
        new RegExp(String.raw`process\.env\.${envVar}\b`).test(configuration),
      );

    expect(present).toEqual([]);
  });

  it('is not validated by env.validation.ts either', () => {
    // #340's third acceptance criterion: nothing may validate a key that no
    // longer resolves through `ConfigService`. The file's own gates —
    // JWT_SECRET, COOKIE_SECRET and POSTGRES_PASSWORD — are deliberately NOT
    // managed keys (#278, #299), so this assertion does not touch them.
    const validation = codeOf(join('src', 'config', 'env.validation.ts'));

    const present = operatorSettingEntries()
      .map(([, definition]) => definition.envVar)
      .filter((envVar) => validation.includes(envVar));

    expect(present).toEqual([]);
  });

  it('keeps the deadline grace default tied to the constant it came from', () => {
    // `run-poller.service.ts` used to fall back to `DEFAULT_DEADLINE_GRACE_MINUTES`
    // and now takes the registry's default instead. `run-deadline.ts` argues
    // for that number at length — longer than RUNNER_KILL_GRACE_MS plus a poll
    // interval — and two independent copies of a number with an argument
    // attached to one of them is how the argument stops being true.
    expect(OPERATOR_SETTINGS['runners.deadlineGraceMinutes'].default).toBe(
      DEFAULT_DEADLINE_GRACE_MINUTES,
    );
  });
});
