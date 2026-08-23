import type { NormalizedCheck } from '../../github/read/github-read.types';
import { failingCheckNames, summarizeChecks } from './check-verdict';

/**
 * #107 makes green CI a hard gate on SURFACING a pull request, so this
 * reduction decides whether review attention gets spent. VISION §10: "a factory
 * producing pull requests faster than they can be reviewed is negative value."
 */

function check(overrides: Partial<NormalizedCheck> = {}): NormalizedCheck {
  return {
    name: 'Test API',
    system: 'check-run',
    status: 'completed',
    conclusion: 'success',
    url: null,
    completedAt: new Date('2026-08-23T12:00:00Z'),
    ...overrides,
  };
}

describe('summarizeChecks', () => {
  it('is pending when nothing has reported', () => {
    // Never `passing`. A repository with no CI and one whose Actions have not
    // started are indistinguishable from here, and surfacing work whose CI had
    // not started is the failure #107 exists to prevent.
    expect(summarizeChecks([])).toBe('pending');
  });

  it('is passing when every check succeeded', () => {
    expect(summarizeChecks([check(), check({ name: 'Lint' })])).toBe('passing');
  });

  it('is failing on one red check among green ones', () => {
    const checks = [check(), check({ name: 'Lint', conclusion: 'failure' })];
    expect(summarizeChecks(checks)).toBe('failing');
  });

  it('is pending while a check is still running', () => {
    const checks = [
      check(),
      check({ name: 'Build', status: 'in_progress', conclusion: null }),
    ];
    expect(summarizeChecks(checks)).toBe('pending');
  });

  it('is failing even if another check has not finished', () => {
    // One red check is enough, and nothing a later green one does can undo it.
    // Waiting for the rest would delay a verdict that is already decided.
    const checks = [
      check({ name: 'Lint', conclusion: 'failure' }),
      check({ name: 'Build', status: 'queued', conclusion: null }),
    ];
    expect(summarizeChecks(checks)).toBe('failing');
  });

  it.each(['neutral', 'skipped'] as const)(
    'treats %s as passing, the way merge protection does',
    (conclusion) => {
      // A skipped job in a conditional workflow is the normal case. Treating it
      // as a failure would hold every PR that did not touch every path.
      expect(summarizeChecks([check({ conclusion })])).toBe('passing');
    },
  );

  it.each(['failure', 'cancelled', 'timed_out', 'action_required'] as const)(
    'treats %s as failing, because none of them becomes a pass on its own',
    (conclusion) => {
      // Pending would be wrong for these: a gate that waits forever is
      // indistinguishable from a broken factory. They did not pass, and "did
      // not pass" is the whole question.
      expect(summarizeChecks([check({ conclusion })])).toBe('failing');
    },
  );

  it('reads commit statuses the same as check runs', () => {
    // A repository may use either system or both, and asking only one is how
    // "CI is green" turns into "the system I queried had nothing to say".
    const checks = [
      check({
        system: 'commit-status',
        name: 'ci/circleci',
        conclusion: 'failure',
      }),
    ];
    expect(summarizeChecks(checks)).toBe('failing');
  });

  it('treats a completed check with no conclusion as pending, not passing', () => {
    expect(summarizeChecks([check({ conclusion: null })])).toBe('pending');
  });
});

describe('failingCheckNames', () => {
  it('names only the checks that actually failed', () => {
    // #107 asks that escalation "name the failing check" — a reason saying
    // only "CI failed" sends the reader to the Actions tab to find out what.
    const checks = [
      check({ name: 'Lint' }),
      check({ name: 'Test API', conclusion: 'failure' }),
      check({ name: 'Build', status: 'in_progress', conclusion: null }),
    ];
    expect(failingCheckNames(checks)).toEqual(['Test API']);
  });

  it('is empty when everything is green', () => {
    expect(failingCheckNames([check()])).toEqual([]);
  });
});
