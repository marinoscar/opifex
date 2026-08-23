import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

import { deriveGitLiveness } from './git-liveness';
import type { GitObservation, WatchedRun } from './git-liveness.types';

const BASE = 'a3f91c2000000000000000000000000000000000';

/** Compiled once: the same schema #33 defines and #53 validates against. */
const validateRunEvent = (() => {
  const schema = JSON.parse(
    readFileSync(
      join(
        __dirname,
        '..',
        '..',
        '..',
        '..',
        'schemas',
        'run-event.schema.json',
      ),
      'utf8',
    ),
  );
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(schema);
})();

function run(overrides: Partial<WatchedRun> = {}): WatchedRun {
  return {
    runId: '018f2c31-7a4e-7c3b-9f21-4d5e6a7b8c9d',
    workOrderIdentity: 'wo_opifex_312_a3f91c2_a1',
    repository: { owner: 'marinoscar', name: 'opifex' },
    branch: 'factory/312-a3f91c2-a1',
    baseCommit: BASE,
    startedAt: new Date('2026-08-21T10:00:00Z'),
    lastKnownHeadCommit: null,
    pullRequestUrl: null,
    ...overrides,
  };
}

function commit(
  sha: string,
  minutesAfterStart: number,
  message = 'feat: work',
) {
  return {
    sha,
    message,
    authoredAt: new Date(
      new Date('2026-08-21T10:00:00Z').getTime() + minutesAfterStart * 60_000,
    ),
  };
}

function observation(overrides: Partial<GitObservation> = {}): GitObservation {
  return {
    run: run(),
    commits: [],
    pullRequest: null,
    checks: [],
    ...overrides,
  };
}

describe('deriveGitLiveness', () => {
  describe('the property #52 exists to prove', () => {
    it('produces liveness for a run with NO runner event stream whatsoever', () => {
      // The whole point. VISION §9 wants this built before the streaming path
      // so the runner abstraction is tested rather than assumed — a runner
      // that reports nothing is still supervisable.
      const result = deriveGitLiveness(
        observation({ commits: [commit('7c1d9ab', 14)] }),
      );

      expect(result.events).toHaveLength(1);
      expect(result.lastActivityAt).toEqual(commit('7c1d9ab', 14).authoredAt);
    });

    it('tags every event git-derived, never runner-reported', () => {
      // These are INFERENCES. A commit landing means someone committed; it
      // does not mean the runner said it made progress. VISION §9 forbids the
      // masquerade, and #54 needs the distinction to pick a threshold.
      const result = deriveGitLiveness(
        observation({
          commits: [commit('7c1d9ab', 14)],
          pullRequest: {
            number: 318,
            url: 'https://github.com/marinoscar/opifex/pull/318',
            state: 'open',
            merged: false,
            headSha: '7c1d9ab',
            updatedAt: new Date('2026-08-21T10:52:00Z'),
          },
        }),
      );

      expect(result.events.length).toBeGreaterThan(0);
      for (const event of result.events) {
        expect(event.source).toBe('git-derived');
      }
    });
  });

  describe('detecting progress', () => {
    it('emits run.progress for a commit past base', () => {
      const result = deriveGitLiveness(
        observation({ commits: [commit('7c1d9ab', 14)] }),
      );

      expect(result.events[0]).toMatchObject({
        type: 'run.progress',
        source: 'git-derived',
      });
      expect(result.events[0].summary).toContain('7c1d9ab');
    });

    it('does NOT count the base commit as progress', () => {
      // A branch sitting at base has produced nothing. Counting it would
      // report every freshly-created branch as alive.
      const result = deriveGitLiveness(
        observation({ commits: [commit(BASE, 0, 'the base commit')] }),
      );

      expect(result.events).toEqual([]);
      expect(result.lastActivityAt).toBeNull();
    });

    it('matches the base commit by prefix, since identities carry 7 characters', () => {
      // The work-order identity holds `a3f91c2`; GitHub returns 40. Comparing
      // naively would make a branch at base look like one that had moved.
      const result = deriveGitLiveness(
        observation({
          run: run({ baseCommit: 'a3f91c2' }),
          commits: [commit(BASE, 0)],
        }),
      );

      expect(result.events).toEqual([]);
    });

    it('emits one event per new commit', () => {
      const result = deriveGitLiveness(
        observation({
          commits: [
            commit('ccc3333', 30),
            commit('bbb2222', 20),
            commit('aaa1111', 10),
          ],
        }),
      );

      expect(result.events).toHaveLength(3);
    });
  });

  describe('not re-emitting what it has already seen', () => {
    it('skips commits at or older than the last known head', () => {
      // Without this the watcher re-emits the same commit every tick and a
      // STALLED run looks permanently alive — introducing the exact failure
      // mode #54 exists to catch, via its own liveness source.
      const result = deriveGitLiveness(
        observation({
          run: run({ lastKnownHeadCommit: 'bbb2222' }),
          commits: [
            commit('ccc3333', 30),
            commit('bbb2222', 20),
            commit('aaa1111', 10),
          ],
        }),
      );

      expect(result.events).toHaveLength(1);
      expect(result.events[0].summary).toContain('ccc3333');
    });

    it('emits nothing when the branch has not moved since the last tick', () => {
      const result = deriveGitLiveness(
        observation({
          run: run({ lastKnownHeadCommit: 'ccc3333' }),
          commits: [commit('ccc3333', 30), commit('aaa1111', 10)],
        }),
      );

      expect(result.events).toEqual([]);
    });

    it('re-emits everything when the branch was rewritten under it', () => {
      // A last-known head no longer in the list means a force-push or rebase.
      // Re-emitting is recoverable; skipping means the run looks silent until
      // the next commit, which could be never.
      const result = deriveGitLiveness(
        observation({
          run: run({ lastKnownHeadCommit: 'deadbeef' }),
          commits: [commit('ccc3333', 30), commit('aaa1111', 10)],
        }),
      );

      expect(result.events).toHaveLength(2);
    });

    it('uses list order rather than timestamps to decide what is newer', () => {
      // Commit dates can be rewritten, duplicated across a rebase, or simply
      // wrong. The list order is what the repository actually reports.
      const older = commit('aaa1111', 99); // a LATER timestamp, but older in the list
      const result = deriveGitLiveness(
        observation({
          run: run({ lastKnownHeadCommit: 'ccc3333' }),
          commits: [commit('ccc3333', 30), older],
        }),
      );

      expect(result.events).toEqual([]);
    });
  });

  describe('detecting completion', () => {
    const pullRequest = {
      number: 318,
      url: 'https://github.com/marinoscar/opifex/pull/318',
      state: 'open' as const,
      merged: false,
      headSha: '7c1d9ab',
      updatedAt: new Date('2026-08-21T10:52:00Z'),
    };

    it('emits run.completed when a pull request appears', () => {
      // A pull request is the run's output, so its appearance is completion in
      // the only sense git can see.
      const result = deriveGitLiveness(observation({ pullRequest }));

      const completed = result.events.find((e) => e.type === 'run.completed');
      expect(completed).toMatchObject({
        source: 'git-derived',
        result: { pullRequestUrl: pullRequest.url },
      });
    });

    it('does not re-emit a pull request Opifex already knows about', () => {
      const result = deriveGitLiveness(
        observation({
          run: run({ pullRequestUrl: pullRequest.url }),
          pullRequest,
        }),
      );

      expect(result.events.filter((e) => e.type === 'run.completed')).toEqual(
        [],
      );
    });
  });

  describe('detecting the ABSENCE of progress', () => {
    it('reports null activity for a branch that never moved', () => {
      // Null is a real answer meaning "no git evidence of life". #54 must not
      // read it as "alive".
      const result = deriveGitLiveness(observation());

      expect(result.lastActivityAt).toBeNull();
      expect(result.summary).toContain('no git activity');
    });

    it('reports null when the only commit is the base', () => {
      const result = deriveGitLiveness(
        observation({ commits: [commit(BASE, 0)] }),
      );

      expect(result.lastActivityAt).toBeNull();
    });
  });

  describe('CI counts as activity', () => {
    it('treats a completed check as activity', () => {
      // A long test suite on the head commit is evidence the run produced
      // something worth testing.
      const completedAt = new Date('2026-08-21T11:30:00Z');
      const result = deriveGitLiveness(
        observation({
          commits: [commit('7c1d9ab', 14)],
          checks: [
            {
              name: 'Test API',
              status: 'completed',
              conclusion: 'success',
              completedAt,
            },
          ],
        }),
      );

      expect(result.lastActivityAt).toEqual(completedAt);
    });

    it('treats an IN-FLIGHT check as activity happening now', () => {
      // Otherwise a repository whose CI is mid-run looks silent, and the
      // watchdog kills runs during their slowest legitimate phase.
      const before = Date.now();
      const result = deriveGitLiveness(
        observation({
          commits: [commit('7c1d9ab', 14)],
          checks: [
            {
              name: 'Test API',
              status: 'in_progress',
              conclusion: null,
              completedAt: null,
            },
          ],
        }),
      );

      expect(result.lastActivityAt!.getTime()).toBeGreaterThanOrEqual(before);
    });
  });

  describe('the properties this has to hold', () => {
    it('is deterministic', () => {
      const state = observation({ commits: [commit('7c1d9ab', 14)] });

      expect(deriveGitLiveness(state)).toEqual(deriveGitLiveness(state));
    });

    it('gives a commit a stable event id, so re-observation deduplicates', () => {
      // #53 dedupes on `eventId`. A random id would store the same commit
      // twice on every tick.
      const first = deriveGitLiveness(
        observation({ commits: [commit('7c1d9ab', 14)] }),
      );
      const second = deriveGitLiveness(
        observation({ commits: [commit('7c1d9ab', 14)] }),
      );

      expect(first.events[0].eventId).toBe(second.events[0].eventId);
      expect(first.events[0].eventId).toContain('7c1d9ab');
    });

    it('does not mutate its input', () => {
      const state = observation({ commits: [commit('7c1d9ab', 14)] });
      const before = JSON.stringify(state);

      deriveGitLiveness(state);

      expect(JSON.stringify(state)).toBe(before);
    });

    it('emits events that validate against the schema', () => {
      // The contract, not a parallel definition — the same file #33 defines
      // and #53 validates ingestion against. Without this the watcher could
      // drift into emitting something no consumer accepts.
      const result = deriveGitLiveness(
        observation({
          commits: [commit('7c1d9ab', 14)],
          pullRequest: {
            number: 318,
            url: 'https://github.com/marinoscar/opifex/pull/318',
            state: 'open',
            merged: false,
            headSha: '7c1d9ab0f3e2d5c4b6a8901234567890abcdef12',
            updatedAt: new Date('2026-08-21T10:52:00Z'),
          },
        }),
      );

      expect(result.events.length).toBeGreaterThan(0);
      for (const event of result.events) {
        if (!validateRunEvent(event)) {
          throw new Error(
            `git-derived event does not validate:\n${JSON.stringify(validateRunEvent.errors, null, 2)}`,
          );
        }
      }
    });
  });
});
