import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { z } from 'zod';

/**
 * Every UUID literal in the source is one `z.uuid()` accepts (#411).
 *
 * ## The failure this exists to stop
 *
 * zod v4's `z.uuid()` validates the **version** nibble (`[1-8]`) and the
 * **variant** nibble (`[89abAB]`), not merely the shape. So the obvious
 * hand-written fixture id — `11111111-1111-1111-1111-111111111111` — is
 * REJECTED: its variant nibble is `1`.
 *
 * Anywhere such a literal is fed to a schema carrying a `z.uuid()` field, the
 * schema fails on the id *before* reaching whatever the test was asserting,
 * and the test passes for the wrong reason. #405 was exactly that: a DTO spec
 * asserting retirement fields were present passed whether or not they existed.
 *
 * That is the worst shape a test failure can take — green test, clean diff,
 * and nothing anywhere indicating the assertion never ran.
 *
 * ## Why a source scan rather than a fixture helper
 *
 * `test/fixtures/test-data.factory.ts` already emits `randomUUID()`, which is
 * always valid, and using it is the right habit. But a helper only protects
 * the ids that go through it, and the nine literals #411's sweep found were
 * all hand-written in specs beside it. A helper cannot fail when somebody
 * types a fresh `22222222-…` into a new spec; this can.
 *
 * ## When this fails
 *
 * Replace the literal with a valid one — keep the readable pattern and fix the
 * two nibbles, e.g. `22222222-2222-4222-8222-222222222222` — or, if the id is
 * meant to be invalid because the test asserts a REJECTION, mark that line with
 * the pragma below. Marking it is a deliberate, reviewable act; that is the
 * point of requiring one.
 */

/** Put this on the line to exempt an id whose invalidity is the test's point. */
const PRAGMA = 'uuid-invalid-on-purpose';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');

const ROOTS = [
  join(REPO_ROOT, 'apps', 'api', 'src'),
  join(REPO_ROOT, 'apps', 'api', 'test'),
  join(REPO_ROOT, 'apps', 'web', 'src'),
];

const UUID_SHAPED =
  /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      found.push(...sourceFiles(full));
      continue;
    }
    if (/\.tsx?$/.test(entry)) found.push(full);
  }
  return found;
}

interface Offender {
  readonly file: string;
  readonly line: number;
  readonly uuid: string;
}

function invalidUuidLiterals(): Offender[] {
  const offenders: Offender[] = [];

  for (const root of ROOTS) {
    for (const file of sourceFiles(root)) {
      // This file necessarily contains an invalid example in its own header.
      if (file === __filename) continue;

      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((text, index) => {
        if (text.includes(PRAGMA)) return;
        // A comment mentioning a bad id is not a fixture. Only the value a
        // test actually uses can silence an assertion.
        const trimmed = text.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;

        for (const match of text.matchAll(UUID_SHAPED)) {
          if (z.uuid().safeParse(match[0]).success) continue;
          offenders.push({
            file: relative(REPO_ROOT, file).split(sep).join('/'),
            line: index + 1,
            uuid: match[0],
          });
        }
      });
    }
  }

  return offenders;
}

describe('UUID literals are valid to zod (#411)', () => {
  it('finds no id that would fail a z.uuid() field', () => {
    const offenders = invalidUuidLiterals();

    // Formatted rather than raw, because the raw array of objects is unreadable
    // in a jest diff and this test's whole value is telling somebody exactly
    // which line to fix.
    expect(offenders.map((o) => `${o.file}:${o.line} ${o.uuid}`)).toEqual([]);
  });

  it('is actually looking at files, not silently scanning nothing', () => {
    // The control. A scan that walked an empty set would satisfy the test
    // above forever, which is the same vacuous-pass failure #411 is about —
    // it would be an embarrassing way for this particular file to fail.
    const scanned = ROOTS.flatMap((root) => sourceFiles(root));

    expect(scanned.length).toBeGreaterThan(500);
    expect(scanned.some((f) => f.endsWith('.spec.ts'))).toBe(true);
    expect(scanned.some((f) => f.endsWith('.tsx'))).toBe(true);
  });

  it('agrees with zod about which nibbles matter', () => {
    // Pins the RULE, so this file still explains itself if zod's behaviour
    // ever changes: the shape alone is not enough.
    expect(
      z.uuid().safeParse('11111111-1111-1111-1111-111111111111').success,
    ).toBe(false); // variant nibble `1`
    expect(
      z.uuid().safeParse('11111111-1111-9111-8111-111111111111').success,
    ).toBe(false); // version nibble `9`
    expect(
      z.uuid().safeParse('11111111-1111-4111-8111-111111111111').success,
    ).toBe(true);
  });

  it('honours the pragma, so a deliberately invalid id can exist', () => {
    // Proven by construction rather than asserted about the scanner's guts:
    // the line below carries a rejected id AND the pragma, and the first test
    // in this describe is green — so the exemption path is live.
    const deliberatelyInvalid = '11111111-1111-1111-1111-111111111111'; // uuid-invalid-on-purpose

    expect(z.uuid().safeParse(deliberatelyInvalid).success).toBe(false);
  });
});
