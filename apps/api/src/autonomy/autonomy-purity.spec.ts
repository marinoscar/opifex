import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The guarantee ADR-0013 rests on, asserted over the SOURCE (#95).
 *
 * Written in the style of `supervisor-isolation.spec.ts`, and for the same
 * reason it gives: behaviour tests prove the forbidden thing was not read on
 * the paths someone thought to test; this proves there is nothing to read.
 * #95 asks that the ceiling be "provably unreachable from config", and the
 * only proof that survives a refactor is a claim about what these files do not
 * import.
 *
 * It is deliberately blunt. A blunt test that fires on the pull request adding
 * a `ConfigService` to the guard is worth more than a subtle one that reasons
 * about whether the value is used, because the failure this guards against
 * arrives as a convenient afternoon rather than as a decision.
 *
 * When it fails, the question is not "how do I satisfy it" but "is the
 * never-trustable list still unreachable from configuration". If the answer
 * has genuinely changed, that is an ADR, and this file changes with it.
 */
const PURE_FILES = ['never-trustable.ts', 'action-effects.ts'];

function sourceOf(file: string): string {
  return readFileSync(join(__dirname, file), 'utf8');
}

/**
 * The source with comment lines removed.
 *
 * `supervisor-isolation.spec.ts` makes the same distinction when it matches
 * only import statements: "a word appearing in a comment — and these files
 * discuss the dispatcher at length — is not a capability." These files discuss
 * `process.env` and `ConfigService` at length too, in order to explain why
 * they do not use them, and a whole-file substring search would fire on the
 * documentation that makes the guarantee legible.
 *
 * Line-based rather than a comment-stripping regex on purpose: the forbidden
 * path patterns contain the character pairs that open and close block
 * comments (`/**`, `**` + `/`), and a regex stripper would eat real code.
 */
function codeOf(file: string): string {
  return sourceOf(file)
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return (
        trimmed !== '' &&
        !trimmed.startsWith('*') &&
        !trimmed.startsWith('//') &&
        !trimmed.startsWith('/*')
      );
    })
    .join('\n');
}

/** The forbidden-path list as it appears in the source, declaration only. */
function forbiddenListSource(): string {
  const source = sourceOf('never-trustable.ts');
  const start = source.indexOf('FORBIDDEN_WRITE_PATHS: readonly');
  const end = source.indexOf('export function checkNeverTrustable');

  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);

  return source.slice(start, end);
}

describe('autonomy module purity (#95, ADR-0013)', () => {
  /**
   * Each needle is a way a value someone can change at runtime would get into
   * the guard's evaluation path.
   *
   * `ConfigService` is on the list even though the codebase uses it everywhere
   * else, for the reason `budget/hard-spend-ceiling.ts` already documents: it
   * has a public `set()`, so any holder of the injected instance can raise a
   * limit at runtime with nothing recording that it happened.
   */
  const IMPURE = [
    'process.env',
    'ConfigService',
    '@nestjs/config',
    'prisma',
    'Prisma',
    'this.config',
    'systemSetting',
    'userSetting',
  ];

  it.each(PURE_FILES)('finds %s at all', (file) => {
    // Guards every assertion below from passing vacuously over a file that was
    // renamed or deleted, which is how a structural test quietly stops testing.
    expect(sourceOf(file).length).toBeGreaterThan(1_000);
  });

  describe.each(PURE_FILES)('%s', (file) => {
    it.each(IMPURE)('reads no %s', (needle) => {
      expect(codeOf(file)).not.toContain(needle);
    });

    it('is not injectable, so nothing can be handed to it', () => {
      expect(codeOf(file)).not.toContain('@Injectable');
      expect(codeOf(file)).not.toContain('@Inject');
    });

    it('imports only types', () => {
      // A value import is a runtime dependency, and a runtime dependency is
      // something that can read configuration on this module's behalf. The
      // `HardCeiling` and `ActionClassId` imports are erased at compile time.
      const imports = [...sourceOf(file).matchAll(/^\s*import\s[^;]+;/gm)].map(
        (match) => match[0],
      );

      for (const statement of imports) {
        expect(statement).toMatch(/^\s*import type\s/);
      }
    });
  });

  describe('the hard spend ceiling lives in exactly one place (#65)', () => {
    it('is not redeclared in never-trustable.ts', () => {
      // A second constant would be the drift ADR-0011 and ADR-0013 both refuse,
      // and a guard checking a stale copy of the ceiling is worse than no
      // guard: it reports success. The ceiling is #65's, at
      // `budget/hard-spend-ceiling.ts`, resolved there through
      // `OperatorSettingsService` since #345 and passed in here as a value.
      // That this file holds no copy of its own is what makes an admin's edit
      // reach the guard at all, as well as what stops the two disagreeing.
      expect(codeOf('never-trustable.ts')).not.toContain('HARD_SPEND_CEILING');
    });

    it('takes the ceiling as a parameter, not from anywhere it could reach', () => {
      expect(sourceOf('never-trustable.ts')).toMatch(
        /export function checkNeverTrustable\(\s*effects: readonly AutonomyEffect\[\],\s*ceiling: HardCeiling,\s*\)/,
      );
    });

    it('takes no grant, scope or actor', () => {
      // VISION §8: "hardcoded, not policy-configurable, regardless of any
      // grant." A parameter for one would imply some grant could change the
      // answer.
      const signature = /export function checkNeverTrustable\(([^)]*)\)/.exec(
        sourceOf('never-trustable.ts'),
      )?.[1];

      expect(signature).toBeDefined();
      expect(signature).not.toMatch(/grant/i);
      expect(signature).not.toMatch(/scope/i);
      expect(signature).not.toMatch(/actor/i);
    });
  });

  describe('the forbidden-path list still protects the guard and CI', () => {
    // The point of these two: a future pull request that removes
    // self-protection fails a test rather than passing review. VISION §8 calls
    // this the item that matters most — "an agent that can edit the check
    // enforcing its own trailers, or grant itself trust, has the appearance of
    // guardrails and none of the substance."
    it.each([
      ['apps/api/src/autonomy', 'the guard cannot be edited by what it guards'],
      [
        '.github/workflows',
        'CI workflows are the checks that enforce the rest',
      ],
      ['.github/actions', 'a composite action is a workflow, indirected'],
      ['scripts/', 'CI invokes these as gates'],
      ['apps/api/src/supervisor/action-classes.ts', 'the policy table'],
      ['.env', 'budget and credential configuration'],
    ])('forbids writes under %s (%s)', (fragment) => {
      expect(forbiddenListSource()).toContain(fragment);
    });

    it('does not forbid the Prisma schema', () => {
      // Schema changes are ordinary work — most of the roadmap is schema
      // changes. A guard that fired on routine pull requests would be routed
      // around rather than respected.
      expect(forbiddenListSource()).not.toContain('schema.prisma');
    });
  });
});
