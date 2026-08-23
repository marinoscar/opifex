import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * #28's CI provenance check, exercised against the real
 * `scripts/check-provenance.mjs` — not a reimplementation of its rules.
 *
 * `scripts/check-provenance.mjs` is native ESM with no type declarations.
 * apps/api's Jest suite runs specs through ts-jest, compiled to CommonJS, and
 * a plain `await import('...check-provenance.mjs')` from inside a Jest test
 * gets intercepted by Jest's own CJS module registry rather than Node's
 * native ESM loader — it has no transform configured for `.mjs`, and this
 * repo has neither `@babel/preset-env` nor
 * `@babel/plugin-transform-modules-commonjs` installed to give it one
 * (confirmed empirically: `SyntaxError: Cannot use import statement outside
 * a module`). Turning on `--experimental-vm-modules` would fix that, but only
 * by changing how every spec in this suite runs, for the sake of one file.
 *
 * So this spec shells out to `run-checker.mjs`, a small real-ESM harness
 * (colocated in this directory) that imports the checker normally and runs
 * its actual exported functions against JSON task descriptions. See that
 * file's header comment for the full reasoning.
 */

const HARNESS = join(__dirname, 'run-checker.mjs');

interface Commit {
  sha: string;
  parents: string[];
  subject: string;
  message: string;
}

type Task =
  | { fn: 'checkCommit'; commit: Commit }
  | { fn: 'parseTrailers'; message: string };

type CheckCommitResult = { problems: string[] };
type ParseTrailersResult = { trailers: { key: string; value: string }[]; malformed: string[] };

function runTasks(tasks: Task[]): (CheckCommitResult | ParseTrailersResult)[] {
  const output = execFileSync('node', [HARNESS], {
    input: JSON.stringify(tasks),
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(output);
}

function checkCommit(message: string, overrides: Partial<Commit> = {}): string[] {
  const commit: Commit = {
    sha: 'a'.repeat(40),
    parents: ['b'.repeat(40)],
    subject: message.split('\n')[0],
    message,
    ...overrides,
  };
  const [result] = runTasks([{ fn: 'checkCommit', commit }]) as [CheckCommitResult];
  return result.problems;
}

function parseTrailers(message: string): ParseTrailersResult {
  const [result] = runTasks([{ fn: 'parseTrailers', message }]) as [ParseTrailersResult];
  return result;
}

/** The complete, valid agent trailer block used throughout #28's write-up. */
const AGENT_TRAILERS = [
  'Work-Order: wo_opifex_312_a3f91c2_a1',
  'Issue: #312',
  'Runner: claude-code-local@2.1.223',
  'Run-Id: 018f2c31-7a4e-7c3b-9f21-4d5e6a7b8c9d',
  'Attempt: 1',
];

function agentMessage(trailers: string[] = AGENT_TRAILERS): string {
  return ['feat(api): add the widget endpoint', '', 'Body text.', '', ...trailers].join('\n');
}

describe('check-provenance.mjs', () => {
  describe('human-authored commits', () => {
    it('passes a plain commit with no trailers at all', () => {
      const message = 'fix(web): correct the button label';
      expect(checkCommit(message)).toEqual([]);
    });

    it('passes with only an unknown key (Co-authored-by:), explicitly permitted', () => {
      const message = [
        'fix(web): correct the button label',
        '',
        'Co-authored-by: Jane Doe <jane@example.com>',
      ].join('\n');
      expect(checkCommit(message)).toEqual([]);
    });

    it('passes with only a well-formed Issue:', () => {
      const message = ['fix(web): correct the button label', '', 'Issue: #171'].join('\n');
      expect(checkCommit(message)).toEqual([]);
    });

    it('fails Issue: 171 (missing the #) on format', () => {
      const message = ['fix(web): correct the button label', '', 'Issue: 171'].join('\n');
      const problems = checkCommit(message);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('Issue:');
      expect(problems[0]).toContain('does not match the format');
    });

    it('fails when Runner: is present with nothing else, because it makes the commit agent-authored', () => {
      const message = [
        'fix(web): correct the button label',
        '',
        'Runner: claude-code-local@2.1.223',
      ].join('\n');
      const problems = checkCommit(message);

      // Runner: itself is well-formed, so the failures are the other four
      // required agent trailers, not Runner: itself.
      expect(problems).toHaveLength(4);
      for (const key of ['Work-Order', 'Issue', 'Run-Id', 'Attempt']) {
        expect(problems.some((p) => p.startsWith(`${key}: missing`))).toBe(true);
      }
      expect(problems.some((p) => p.startsWith('Runner:'))).toBe(false);

      // #28's acceptance criteria: the message says exactly what to add, and
      // says why (agent-authored because it carries Runner:).
      expect(problems[0]).toContain('agent-authored');
      expect(problems[0]).toContain('Runner:');
    });
  });

  describe('agent-authored commits', () => {
    it('passes the complete set', () => {
      expect(checkCommit(agentMessage())).toEqual([]);
    });

    it('fails when Run-Id: is missing, citing the all-or-nothing rule', () => {
      const trailers = AGENT_TRAILERS.filter((t) => !t.startsWith('Run-Id:'));
      const problems = checkCommit(agentMessage(trailers));

      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('Run-Id:');
      expect(problems[0]).toContain('missing');
      expect(problems[0]).toContain('agent-authored');
    });

    it('fails when Attempt: disagrees with the Work-Order: suffix, and says Work-Order: is authoritative', () => {
      const trailers = AGENT_TRAILERS.map((t) => (t.startsWith('Attempt:') ? 'Attempt: 3' : t));
      const problems = checkCommit(agentMessage(trailers));

      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('Attempt: 3');
      expect(problems[0]).toContain('wo_opifex_312_a3f91c2_a1');
      expect(problems[0]).toContain('Work-Order:');
      expect(problems[0]).toContain('is authoritative');
    });
  });

  describe('general rules', () => {
    it('exempts merge commits, even with no trailers', () => {
      const problems = checkCommit("Merge pull request #99 from feat/x", {
        parents: ['a'.repeat(40), 'c'.repeat(40)],
      });
      expect(problems).toEqual([]);
    });

    it('fails on a duplicate Issue: key', () => {
      const message = [
        'fix(web): correct the button label',
        '',
        'Issue: #171',
        'Issue: #172',
      ].join('\n');
      const problems = checkCommit(message);

      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('Issue:');
      expect(problems[0]).toContain('more than once');
      expect(problems[0]).toContain('at most once');
    });

    it('fails Issue:  #1 with two spaces after the colon', () => {
      const message = ['fix(web): correct the button label', '', 'Issue:  #1'].join('\n');
      const problems = checkCommit(message);

      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('Issue:');
      expect(problems[0]).toContain('exactly one space after the colon');
    });

    it('fails a Decision: naming no ADR file under docs/adr/', () => {
      const message = [
        'fix(web): correct the button label',
        '',
        'Decision: ADR-9999',
      ].join('\n');
      const problems = checkCommit(message);

      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('ADR-9999');
      expect(problems[0]).toContain('names no file under docs/adr/');
      expect(problems[0]).toContain('dangling');
    });

    it('passes a Decision: that does resolve to a real ADR', () => {
      const message = [
        'fix(web): correct the button label',
        '',
        'Decision: ADR-0001',
      ].join('\n');
      expect(checkCommit(message)).toEqual([]);
    });
  });

  describe('trailer-block detection', () => {
    it('does not misparse a colon-bearing prose line as a trailer', () => {
      // "Note: this is prose" is shaped like a trailer line, but it is part
      // of a running paragraph (not preceded by a blank line), so it must
      // not be treated as the start of the trailer block.
      const message = [
        'feat(api): add a note field',
        '',
        'This change adds a field to the response body.',
        'Note: this is prose, not a trailer.',
      ].join('\n');

      expect(parseTrailers(message)).toEqual({ trailers: [], malformed: [] });
      expect(checkCommit(message)).toEqual([]);
    });

    it('does treat a single trailing Key: value line preceded by a blank line as a trailer block', () => {
      // The contrasting case: same shape, but correctly separated by a
      // blank line, so it IS the trailer block — even a lone unknown key.
      const message = [
        'feat(api): add a note field',
        '',
        'This change adds a field to the response body.',
        '',
        'Note: this is a real trailer position, just an unknown key.',
      ].join('\n');

      const { trailers, malformed } = parseTrailers(message);
      expect(malformed).toEqual([]);
      expect(trailers).toEqual([
        { key: 'Note', value: 'this is a real trailer position, just an unknown key.' },
      ]);
    });
  });
});
