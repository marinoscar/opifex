import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
  | { fn: 'diffLabels'; declared: Label[]; actual: Label[] };

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
});
