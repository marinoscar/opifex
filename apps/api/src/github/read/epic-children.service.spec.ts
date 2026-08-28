import { GitHubAuthError, GitHubNotFoundError } from '../github.errors';
import { EpicChildrenService } from './epic-children.service';
import { GitHubReadService } from './github-read.service';
import type { NormalizedIssue } from './github-read.types';

/**
 * Epic resolution (#424).
 *
 * `GitHubReadService` is mocked rather than the HTTP layer: this suite is
 * about the RESOLUTION POLICY — which source answers, what a cycle does, how
 * deep the walk goes — and the read adapter has its own suite for
 * normalization. Mocking a layer lower would re-test ETag handling in every
 * case here for no extra confidence.
 */

const REPO = { owner: 'acme', name: 'app' };

function issue(
  number: number,
  overrides: Partial<NormalizedIssue> = {},
): NormalizedIssue {
  return {
    number,
    title: `Issue ${number}`,
    body: null,
    state: 'open',
    author: 'marinoscar',
    labels: [],
    inputLabels: [],
    unknownInputLabels: [],
    ignoredLabels: [],
    observedMirrorLabels: [],
    isPullRequest: false,
    url: `https://github.com/acme/app/issues/${number}`,
    createdAt: new Date('2026-08-01T00:00:00Z'),
    updatedAt: new Date('2026-08-02T00:00:00Z'),
    ...overrides,
  };
}

/** An epic body in the form every epic in this repository actually uses. */
function epicBody(...refs: string[]): string {
  return ['### Child work', ...refs.map((r) => `- [ ] ${r}`)].join('\n');
}

function notFound(path = '/x') {
  return new GitHubNotFoundError('Not Found', 404, 'GET', path);
}

describe('EpicChildrenService', () => {
  let read: {
    getIssue: jest.Mock;
    listSubIssues: jest.Mock;
  };
  let service: EpicChildrenService;

  /** Wires `getIssue` to a set of issues, 404-ing anything not in it. */
  function withIssues(...issues: NormalizedIssue[]) {
    const byKey = new Map(
      issues.map((i) => [
        `${repoOf(i).owner}/${repoOf(i).name}#${i.number}`,
        i,
      ]),
    );
    read.getIssue.mockImplementation(
      async (repo: { owner: string; name: string }, number: number) => {
        const found = byKey.get(`${repo.owner}/${repo.name}#${number}`);
        if (!found) throw notFound(`/repos/${repo.owner}/${repo.name}`);
        return found;
      },
    );
  }

  function repoOf(i: NormalizedIssue) {
    const m = i.url.match(/github\.com\/([\w.-]+)\/([\w.-]+)\//);
    return { owner: m?.[1] ?? 'acme', name: m?.[2] ?? 'app' };
  }

  beforeEach(() => {
    read = { getIssue: jest.fn(), listSubIssues: jest.fn() };
    // The state of this repository today: the endpoint works, and answers
    // empty for everything. Overridden per-test where the native source is
    // the subject.
    read.listSubIssues.mockResolvedValue([]);
    service = new EpicChildrenService(read as unknown as GitHubReadService);
  });

  describe('the source that answers', () => {
    it('prefers the native sub-issues relationship when it names anything', () => {
      read.listSubIssues.mockResolvedValue([issue(11), issue(12)]);
      // A body that names something DIFFERENT, so a passing test cannot be
      // explained by the two sources agreeing.
      withIssues(issue(419, { body: epicBody('#98', '#99') }));

      return service.resolve(REPO, 419).then((result) => {
        expect(result.children.map((c) => c.number)).toEqual([11, 12]);
        expect(result.source).toBe('sub-issues-api');
        expect(result.nativeUnavailable).toBeNull();
      });
    });

    it('does not re-fetch a child the native source already returned', async () => {
      read.listSubIssues.mockResolvedValue([
        issue(11, { title: 'From native' }),
      ]);
      withIssues(issue(419, { body: null }));

      const result = await service.resolve(REPO, 419);

      expect(result.children[0].title).toBe('From native');
      // Once for the epic itself, and not again for the child.
      expect(read.getIssue).toHaveBeenCalledTimes(1);
    });

    it('falls back to the body when the native relationship is EMPTY', async () => {
      // The finding this whole design turns on: the sub-issues endpoint is
      // available to this deployment's PAT and returns nothing for every epic
      // in this repository. Treating that as an authoritative empty set would
      // resolve every real epic to nothing while looking correct.
      read.listSubIssues.mockResolvedValue([]);
      withIssues(
        issue(419, { body: epicBody('#420', '#421') }),
        issue(420),
        issue(421),
      );

      const result = await service.resolve(REPO, 419);

      expect(result.children.map((c) => c.number)).toEqual([420, 421]);
      expect(result.source).toBe('issue-body');
      expect(result.nativeUnavailable).toBe(
        'GitHub records no sub-issues for this issue',
      );
    });

    it('falls back to the body when the sub-issues endpoint 404s', async () => {
      // The shape an older tier or a GitHub Enterprise Server without the
      // endpoint would take.
      read.listSubIssues.mockRejectedValue(notFound('/sub_issues'));
      withIssues(issue(419, { body: epicBody('#420') }), issue(420));

      const result = await service.resolve(REPO, 419);

      expect(result.children.map((c) => c.number)).toEqual([420]);
      expect(result.source).toBe('issue-body');
      expect(result.nativeUnavailable).toMatch(/answered 404/);
    });

    it('records the source on every child, not only on the result', async () => {
      withIssues(issue(419, { body: epicBody('#420') }), issue(420));

      const result = await service.resolve(REPO, 419);

      expect(result.children[0].source).toBe('issue-body');
    });

    it('propagates a rate-limit or auth failure instead of falling back', async () => {
      // A resolution built while the budget is exhausted would be quietly
      // incomplete, and the caller is about to write labels from it.
      read.listSubIssues.mockRejectedValue(
        new GitHubAuthError('refused', 403, 'GET', '/sub_issues'),
      );
      withIssues(issue(419, { body: epicBody('#420') }), issue(420));

      await expect(service.resolve(REPO, 419)).rejects.toThrow(GitHubAuthError);
    });
  });

  describe('an epic with no children', () => {
    it('resolves to an empty set rather than an error', async () => {
      withIssues(issue(419, { body: '### Child work\n\nNone yet.' }));

      const result = await service.resolve(REPO, 419);

      expect(result.children).toEqual([]);
      expect(result.source).toBe('none');
    });

    it('resolves an issue that is not an epic at all to an empty set', async () => {
      withIssues(issue(424, { body: 'Just a plain feature request.' }));

      const result = await service.resolve(REPO, 424);

      expect(result.children).toEqual([]);
      expect(result.nativeUnavailable).toMatch(/no child-work section/);
    });

    it('still throws when the EPIC itself cannot be read', async () => {
      // A caller naming a nonexistent issue has made a mistake worth
      // reporting; degrading that to an empty set would hide it.
      withIssues();

      await expect(service.resolve(REPO, 999)).rejects.toThrow(
        GitHubNotFoundError,
      );
    });
  });

  describe('cycles', () => {
    it('terminates on an epic that references itself', async () => {
      withIssues(issue(419, { body: epicBody('#419', '#420') }), issue(420));

      const result = await service.resolve(REPO, 419);

      expect(result.children.map((c) => c.number)).toEqual([420]);
      expect(result.skipped).toEqual([
        { ref: 'acme/app#419', namedBy: 'acme/app#419', reason: 'self' },
      ]);
    });

    it('terminates on a two-node cycle', async () => {
      withIssues(
        issue(1, { body: epicBody('#2') }),
        issue(2, { body: epicBody('#1') }),
      );

      const result = await service.resolve(REPO, 1, { maxDepth: 5 });

      expect(result.children.map((c) => c.ref)).toEqual(['acme/app#2']);
      expect(result.skipped).toEqual([
        { ref: 'acme/app#1', namedBy: 'acme/app#2', reason: 'cycle' },
      ]);
    });

    it('terminates on a three-node cycle', async () => {
      withIssues(
        issue(1, { body: epicBody('#2') }),
        issue(2, { body: epicBody('#3') }),
        issue(3, { body: epicBody('#1') }),
      );

      const result = await service.resolve(REPO, 1, { maxDepth: 5 });

      expect(result.children.map((c) => c.number)).toEqual([2, 3]);
      expect(result.skipped[0].reason).toBe('cycle');
    });

    it('reports a diamond as a duplicate, not as a cycle', async () => {
      // Two children both naming the same grandchild is not an error, and
      // calling it a cycle would send a reader looking for a loop.
      withIssues(
        issue(1, { body: epicBody('#2', '#3') }),
        issue(2, { body: epicBody('#4') }),
        issue(3, { body: epicBody('#4') }),
        issue(4),
      );

      const result = await service.resolve(REPO, 1, { maxDepth: 3 });

      expect(result.children.map((c) => c.number)).toEqual([2, 3, 4]);
      expect(result.skipped).toEqual([
        { ref: 'acme/app#4', namedBy: 'acme/app#3', reason: 'duplicate' },
      ]);
    });
  });

  describe('depth', () => {
    it('resolves ONE level by default', async () => {
      // "The issues directly listed here". The default is narrow because the
      // first caller turns membership into label writes.
      withIssues(
        issue(1, { body: epicBody('#2') }),
        issue(2, { body: epicBody('#3') }),
        issue(3),
      );

      const result = await service.resolve(REPO, 1);

      expect(result.children.map((c) => c.number)).toEqual([2]);
      expect(result.maxDepth).toBe(1);
    });

    it('walks transitively when asked, recording each child depth', async () => {
      withIssues(
        issue(1, { body: epicBody('#2') }),
        issue(2, { body: epicBody('#3') }),
        issue(3, { body: epicBody('#4') }),
        issue(4),
      );

      const result = await service.resolve(REPO, 1, { maxDepth: 2 });

      expect(result.children.map((c) => [c.number, c.depth])).toEqual([
        [2, 1],
        [3, 2],
      ]);
      expect(result.maxDepth).toBe(2);
    });

    it('records who named each child', async () => {
      withIssues(
        issue(1, { body: epicBody('#2') }),
        issue(2, { body: epicBody('#3') }),
        issue(3),
      );

      const result = await service.resolve(REPO, 1, { maxDepth: 2 });

      expect(result.children.map((c) => c.namedBy)).toEqual([
        'acme/app#1',
        'acme/app#2',
      ]);
    });

    it('clamps a depth beyond the ceiling and reports what it walked', async () => {
      // Each level costs a request per child; an unbounded walk over a
      // mistyped graph is the rate-limit exhaustion #40 forbids walking into.
      withIssues(issue(1, { body: epicBody('#2') }), issue(2));

      expect((await service.resolve(REPO, 1, { maxDepth: 99 })).maxDepth).toBe(
        5,
      );
      expect((await service.resolve(REPO, 1, { maxDepth: 0 })).maxDepth).toBe(
        1,
      );
      expect((await service.resolve(REPO, 1, { maxDepth: -3 })).maxDepth).toBe(
        1,
      );
    });

    it('does not expand a pull request listed as a child', async () => {
      withIssues(
        issue(1, { body: epicBody('#2') }),
        issue(2, { isPullRequest: true, body: epicBody('#3') }),
        issue(3),
      );

      const result = await service.resolve(REPO, 1, { maxDepth: 3 });

      expect(result.children.map((c) => c.number)).toEqual([2]);
      expect(result.children[0].isPullRequest).toBe(true);
    });
  });

  describe('children that are not simply open issues', () => {
    it('keeps a CLOSED child in the set, with its real state', async () => {
      // Closed is not absent. A caller grouping a queue by epic wants the
      // whole epic; one dispatching work filters on this field itself.
      withIssues(
        issue(1, { body: epicBody('#2', '#3') }),
        issue(2, { state: 'closed' }),
        issue(3, { state: 'open' }),
      );

      const result = await service.resolve(REPO, 1);

      expect(result.children.map((c) => [c.number, c.state])).toEqual([
        [2, 'closed'],
        [3, 'open'],
      ]);
    });

    it('reads state from GitHub, not from the epic checkbox', async () => {
      // `- [x]` says the human thinks it is done; GitHub says whether it is.
      // The two disagree the moment an issue is reopened.
      withIssues(
        issue(1, { body: '### Child work\n- [x] #2' }),
        issue(2, { state: 'open' }),
      );

      expect((await service.resolve(REPO, 1)).children[0].state).toBe('open');
    });

    it('keeps an unreadable child in the set rather than dropping it', async () => {
      // Deleted, transferred out, or invisible to this token — GitHub answers
      // 404 for all three. Omitting it would make a three-child epic look
      // like a two-child epic to a caller about to act on the membership.
      withIssues(issue(1, { body: epicBody('#2', '#3') }), issue(2));

      const result = await service.resolve(REPO, 1);

      expect(result.children.map((c) => c.number)).toEqual([2, 3]);
      expect(result.children[1]).toEqual(
        expect.objectContaining({
          number: 3,
          state: 'unknown',
          title: null,
          unreadable: true,
        }),
      );
      expect(result.children[0].unreadable).toBe(false);
    });

    it('resolves a child in a DIFFERENT repository against that repository', async () => {
      withIssues(
        issue(1, { body: epicBody('#2', 'other-org/other-repo#77') }),
        issue(2),
        issue(77, {
          url: 'https://github.com/other-org/other-repo/issues/77',
        }),
      );

      const result = await service.resolve(REPO, 1);

      expect(result.children[1]).toEqual(
        expect.objectContaining({
          owner: 'other-org',
          name: 'other-repo',
          number: 77,
          ref: 'other-org/other-repo#77',
          unreadable: false,
        }),
      );
      expect(read.getIssue).toHaveBeenCalledWith(
        { owner: 'other-org', name: 'other-repo' },
        77,
      );
    });

    it('reports a cross-repository child this token cannot see as unreadable', async () => {
      withIssues(issue(1, { body: epicBody('private-org/secret#5') }));

      const result = await service.resolve(REPO, 1);

      expect(result.children[0]).toEqual(
        expect.objectContaining({
          ref: 'private-org/secret#5',
          state: 'unknown',
          unreadable: true,
        }),
      );
    });

    it('does not confuse the same number in two repositories', async () => {
      withIssues(
        issue(1, { body: epicBody('#2', 'other/repo#2') }),
        issue(2, { title: 'Ours' }),
        issue(2, {
          title: 'Theirs',
          url: 'https://github.com/other/repo/issues/2',
        }),
      );

      const result = await service.resolve(REPO, 1);

      expect(result.children.map((c) => [c.ref, c.title])).toEqual([
        ['acme/app#2', 'Ours'],
        ['other/repo#2', 'Theirs'],
      ]);
    });

    it('places a cross-repository sub-issue in ITS OWN repository', async () => {
      read.listSubIssues.mockResolvedValue([
        issue(77, { url: 'https://github.com/other-org/other-repo/issues/77' }),
      ]);
      withIssues(issue(1, { body: null }));

      const result = await service.resolve(REPO, 1);

      expect(result.children[0].ref).toBe('other-org/other-repo#77');
    });
  });

  describe('the result is an observation, not stored truth', () => {
    it('carries a checked-at time', async () => {
      const before = Date.now();
      withIssues(issue(1, { body: epicBody('#2') }), issue(2));

      const result = await service.resolve(REPO, 1);

      expect(result.checkedAt).toBeInstanceOf(Date);
      expect(result.checkedAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(result.checkedAt.getTime()).toBeLessThanOrEqual(Date.now());
    });

    it('re-reads GitHub on every call rather than answering from a cache', async () => {
      // The membership of an epic changes in GitHub. A resolver that
      // remembered its own previous answer would be the mirror-label mistake
      // VISION §3.3 warns about, rebuilt here.
      withIssues(issue(1, { body: epicBody('#2') }), issue(2));
      await service.resolve(REPO, 1);

      withIssues(issue(1, { body: epicBody('#2', '#3') }), issue(2), issue(3));
      const second = await service.resolve(REPO, 1);

      expect(second.children.map((c) => c.number)).toEqual([2, 3]);
    });

    it('reports the epic it was asked about', async () => {
      withIssues(
        issue(419, { title: 'Steering', body: epicBody('#420') }),
        issue(420),
      );

      const result = await service.resolve(REPO, 419);

      expect(result.epic).toEqual({
        owner: 'acme',
        name: 'app',
        number: 419,
        ref: 'acme/app#419',
        title: 'Steering',
      });
    });
  });

  describe('drift is surfaced', () => {
    it('reports a task-list item that names no issue', async () => {
      withIssues(
        issue(1, {
          body: [
            '### Child work',
            '- [ ] #2 — fine',
            '- [ ] write the migration',
          ].join('\n'),
        }),
        issue(2),
      );

      const result = await service.resolve(REPO, 1);

      expect(result.children.map((c) => c.number)).toEqual([2]);
      expect(result.unparsed).toEqual([
        { namedBy: 'acme/app#1', item: 'write the migration' },
      ]);
    });
  });
});
