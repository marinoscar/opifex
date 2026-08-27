import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  INPUT_LABEL_PREFIX,
  MIRROR_LABEL_PREFIX,
} from '../../src/github/labels/factory-labels';
import {
  NEEDS_LABEL_PREFIX,
  TIER_LABEL_PREFIX,
} from '../../src/github/labels/ignored-labels';

/**
 * #195's label sync, exercised against the real `scripts/sync-labels.mjs`.
 *
 * The taxonomy was declared in `.github/labels.yml` and had never been applied:
 * none of the seven `factory:*` / `factory/*` labels existed on the repository.
 * That is not cosmetic — VISION §3.3 makes input labels the operator's control
 * surface, and a label that does not exist cannot be put on an issue, so no
 * issue could carry `factory:ready` and the reconciler computed zero actions on
 * every tick, correctly, forever.
 *
 * `input-labels.spec.ts` compares the implemented labels to the file. This
 * compares the file to what a repository actually has, which is the comparison
 * that was missing.
 */

const HARNESS = join(__dirname, 'run-labels.mjs');

interface Label {
  name: string;
  color: string;
  description: string;
}

type Task =
  | { fn: 'declaredLabels'; source: string }
  | { fn: 'diffLabels'; declared: Label[]; actual: Label[] }
  | { fn: 'validateLabels'; labels: Label[] }
  | { fn: 'labelPrefixes' }
  | { fn: 'labelKind'; names: string[] }
  | {
      fn: 'formatDriftReport';
      diff: {
        missing: Label[];
        changed: (Label & { differences: string[] })[];
        extra: string[];
      };
    };

function run<T>(task: Task): T {
  const output = execFileSync('node', [HARNESS], {
    input: JSON.stringify([task]),
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  return (JSON.parse(output) as T[])[0];
}

const declaredFrom = (source: string) =>
  run<{ labels: Label[] }>({ fn: 'declaredLabels', source }).labels;

const diff = (declared: Label[], actual: Label[]) =>
  run<{
    missing: Label[];
    changed: (Label & { differences: string[] })[];
    extra: string[];
  }>({ fn: 'diffLabels', declared, actual });

const validate = (labels: Label[]) =>
  run<{ problems: string[] }>({ fn: 'validateLabels', labels }).problems;

const prefixes = () =>
  run<{ prefixes: Record<string, string> }>({ fn: 'labelPrefixes' }).prefixes;

const kindsOf = (names: string[]) =>
  run<{ kinds: string[] }>({ fn: 'labelKind', names }).kinds;

const kindOf = (name: string) => kindsOf([name])[0];

const report = (diff: {
  missing?: Label[];
  changed?: (Label & { differences: string[] })[];
  extra?: string[];
}) =>
  run<{ lines: string[] }>({
    fn: 'formatDriftReport',
    diff: { missing: [], changed: [], extra: [], ...diff },
  }).lines;

const label = (over: Partial<Label> = {}): Label => ({
  name: 'factory:hold',
  color: 'b60205',
  description: 'Human intent: stop.',
  ...over,
});

describe('sync-labels.mjs', () => {
  describe('reading the declared taxonomy', () => {
    it('normalizes a leading # and upper case in colours', () => {
      // GitHub stores colours bare and lower-case. Comparing '#B60205' against
      // 'b60205' would report every label as drifted, forever.
      const [parsed] = declaredFrom(
        '- name: "x"\n  color: "#B60205"\n  description: "d"\n',
      );
      expect(parsed.color).toBe('b60205');
    });

    it('defaults a missing description to empty rather than undefined', () => {
      const [parsed] = declaredFrom('- name: "x"\n  color: "b60205"\n');
      expect(parsed.description).toBe('');
    });

    it('refuses a label with no name', () => {
      expect(() => declaredFrom('- color: "b60205"\n')).toThrow();
    });

    it("reads this repository's real taxonomy, factory labels included", () => {
      const source = readFileSync(
        join(__dirname, '..', '..', '..', '..', '.github', 'labels.yml'),
        'utf8',
      );
      const names = declaredFrom(source).map((l) => l.name);

      // The separator split is load-bearing (VISION §3.3) and the file says so
      // in as many words. If a rename ever collapsed it, this is where it shows.
      expect(names).toEqual(
        expect.arrayContaining(['factory:hold', 'factory:ready']),
      );
      expect(names).toEqual(
        expect.arrayContaining(['factory/dispatched', 'factory/blocked']),
      );
    });
  });

  describe('validating before writing anything (#197)', () => {
    // The first real --apply created four labels and died on the fifth with
    // HTTP 422. Half-applied is the worst state available: the drift report
    // shrinks, the label list looks partly right, and nothing says the run did
    // not finish.

    it('rejects a description longer than GitHub allows', () => {
      const problems = validate([label({ description: 'x'.repeat(101) })]);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('101 characters');
      expect(problems[0]).toContain('100');
    });

    it('accepts one of exactly 100', () => {
      expect(validate([label({ description: 'x'.repeat(100) })])).toEqual([]);
    });

    it('rejects a colour that is not six hex digits', () => {
      expect(validate([label({ color: 'fff' })])[0]).toContain(
        'not six hex digits',
      );
    });

    it('rejects a duplicate name, which would apply twice and drift once', () => {
      expect(validate([label(), label()])[0]).toContain('more than once');
    });

    it('names every offender at once, not the first', () => {
      // One per attempt would mean discovering the file's problems one round
      // trip at a time, which is how #197 was found.
      const problems = validate([
        label({ name: 'a', description: 'x'.repeat(101) }),
        label({ name: 'b', color: 'nothex' }),
      ]);
      expect(problems).toHaveLength(2);
    });

    it("passes this repository's real taxonomy", () => {
      // The file was unappliable as written until #197: three mirror labels had
      // descriptions over the cap. This is the assertion that keeps it
      // appliable.
      const source = readFileSync(
        join(__dirname, '..', '..', '..', '..', '.github', 'labels.yml'),
        'utf8',
      );
      expect(validate(declaredFrom(source))).toEqual([]);
    });
  });

  describe('the diff', () => {
    it('reports a declared label that does not exist', () => {
      const result = diff([label()], []);
      expect(result.missing.map((l) => l.name)).toEqual(['factory:hold']);
      expect(result.changed).toEqual([]);
    });

    it('reports a colour that has drifted', () => {
      const result = diff([label()], [label({ color: 'ededed' })]);
      expect(result.changed).toHaveLength(1);
      expect(result.changed[0].differences.join()).toContain('color');
    });

    it('reports a description that has drifted, because meaning moved', () => {
      // The description is the only place the input/mirror distinction is
      // written where an operator reads it.
      const result = diff(
        [label()],
        [label({ description: 'something else' })],
      );
      expect(result.changed[0].differences).toContain('description');
    });

    it('says nothing when everything matches', () => {
      const result = diff([label()], [label()]);
      expect(result).toEqual({ missing: [], changed: [], extra: [] });
    });

    it('reports an undeclared label as extra, and never as a deletion', () => {
      // Deleting a label strips it from every issue carrying it, and this file
      // cannot restore that — it knows the name and colour, not which issues
      // had it. An unrecognised label is far more likely to be a human's.
      const result = diff(
        [label()],
        [label(), label({ name: 'someone-elses' })],
      );
      expect(result.extra).toEqual(['someone-elses']);
      expect(result.missing).toEqual([]);
      expect(result.changed).toEqual([]);
    });

    it('treats colour comparison case-insensitively on both sides', () => {
      const result = diff(
        [label({ color: 'b60205' })],
        [label({ color: 'b60205' })],
      );
      expect(result.changed).toEqual([]);
    });
  });

  describe('telling the kinds apart in the report (#303)', () => {
    // A missing `tier:large` used to print identically to a missing
    // `factory:ready`, which reads as one flat pile of drift. They are not the
    // same news: without the input label the repository cannot be steered at
    // all, while without the routing label work still runs and simply never
    // leaves the defaults.

    it('restates the prefixes the code owns, and no others', () => {
      // The script is plain .mjs and cannot import factory-labels.ts, so the
      // four prefixes are copied into it. This is the assertion that stops the
      // copy drifting — a separator changed on one side and not the other
      // would silently reclassify every label in the report, and the report is
      // the only place an operator sees the taxonomy applied.
      expect(prefixes()).toEqual({
        input: INPUT_LABEL_PREFIX,
        mirror: MIRROR_LABEL_PREFIX,
        needs: NEEDS_LABEL_PREFIX,
        tier: TIER_LABEL_PREFIX,
      });
    });

    it('classifies by separator and prefix, not by a list of names', () => {
      expect(kindOf('factory:hold')).toBe('input');
      expect(kindOf('factory/dispatched')).toBe('mirror');
      expect(kindOf('needs:cost-reporting')).toBe('routing');
      expect(kindOf('tier:large')).toBe('routing');
      // Not in any vocabulary, and still classified: the report describes the
      // family, and whether the factory understands the value is a different
      // question that input-labels.spec.ts answers.
      expect(kindOf('factory:hold-please')).toBe('input');
      expect(kindOf('tier:huge')).toBe('routing');
    });

    it('files a label matching no prefix under "other" rather than dropping it', () => {
      // This script never deletes and never hides. A label it does not
      // recognise is far more likely to be a human's than a mistake.
      expect(kindsOf(['bug', 'phase:4', 'api'])).toEqual([
        'other',
        'other',
        'other',
      ]);
    });

    it('treats Tier:Large as routing, because the projection does', () => {
      // MODEL_TIER_BY_LABEL is looked up lower-cased, so this label really
      // does set a tier. Filing it under "other" would tell an operator their
      // label means nothing when it means everything.
      expect(kindOf('Tier:Large')).toBe('routing');
    });

    it('groups missing labels under one heading per kind, most urgent first', () => {
      const lines = report({
        missing: [
          label({ name: 'bug' }),
          label({ name: 'tier:large' }),
          label({ name: 'factory/review' }),
          label({ name: 'factory:ready' }),
        ],
      });

      const headings = lines.filter((line) => !line.startsWith('  ') && line);
      expect(headings).toHaveLength(4);
      expect(headings[0]).toContain('Input labels');
      expect(headings[1]).toContain('Mirror labels');
      expect(headings[2]).toContain('Routing labels');
      expect(headings[3]).toContain('Other labels');
    });

    it('says what a missing label of each kind costs', () => {
      const input = report({ missing: [label({ name: 'factory:ready' })] });
      const routing = report({ missing: [label({ name: 'tier:large' })] });

      expect(input[0]).toContain('cannot be steered');
      expect(routing[0]).toContain('only on the defaults');
      // And the two are not the same sentence, which was the whole complaint.
      expect(input[0]).not.toEqual(routing[0]);
    });

    it('prints no heading for a kind with nothing wrong', () => {
      const lines = report({ missing: [label({ name: 'tier:small' })] });

      expect(lines.filter((line) => line.includes('Input labels'))).toEqual([]);
      expect(lines).toContain('  + tier:small (missing)');
    });

    it('groups a drifted label the same way it groups a missing one', () => {
      const lines = report({
        changed: [
          {
            ...label({ name: 'needs:cost-reporting' }),
            differences: ['description'],
          },
        ],
      });

      expect(lines[0]).toContain('Routing labels');
      expect(lines[1]).toBe('  ± needs:cost-reporting (description)');
    });

    it('still reports an undeclared label, tagged with its kind', () => {
      const lines = report({ extra: ['tier:huge', 'someone-elses'] });

      expect(lines[0]).toContain('tier:huge [routing]');
      expect(lines[0]).toContain('never deleted');
      expect(lines[1]).toContain('someone-elses [other]');
    });

    it('says nothing at all when nothing has drifted', () => {
      // main() prints its own "all present and match" line; an empty report
      // must not put a bare heading above it.
      expect(report({})).toEqual([]);
    });
  });
});
