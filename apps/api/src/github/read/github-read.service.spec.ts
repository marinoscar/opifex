import { GitHubHttpService } from '../github-http.service';
import { GitHubReadService } from './github-read.service';

/**
 * The HTTP pipeline is mocked, not the `fetch` beneath it: this suite is about
 * NORMALIZATION — what shape leaves the module — and the transport already has
 * its own suite. Mocking one layer down would re-test retry and ETag handling
 * in every case here for no extra confidence.
 */
function httpMock() {
  return {
    request: jest.fn(),
    paginate: jest.fn(),
  } as unknown as jest.Mocked<Pick<GitHubHttpService, 'request' | 'paginate'>>;
}

const REPO = { owner: 'acme', name: 'app' };

function page<T>(items: T[]) {
  return { items, pages: 1, truncated: false, allFromCache: false };
}

function rawIssue(overrides: Record<string, unknown> = {}) {
  return {
    number: 312,
    title: 'Add export',
    body: 'Please add export.',
    state: 'open',
    user: { login: 'marinoscar' },
    labels: [],
    html_url: 'https://github.com/acme/app/issues/312',
    created_at: '2026-08-01T10:00:00Z',
    updated_at: '2026-08-02T10:00:00Z',
    ...overrides,
  };
}

function label(name: string) {
  return { name, color: 'ededed', description: null };
}

describe('GitHubReadService', () => {
  let http: ReturnType<typeof httpMock>;
  let service: GitHubReadService;

  beforeEach(() => {
    http = httpMock();
    service = new GitHubReadService(http as unknown as GitHubHttpService);
  });

  describe('mirror labels', () => {
    it('IGNORES factory/* labels on read', async () => {
      // The rule VISION §3.3 states and #41 asks for a test on: Opifex writes
      // mirror labels and must never read them back as truth. Reading one
      // would make the computed desired state depend on the control plane's
      // own previous output.
      http.paginate.mockResolvedValue(
        page([
          rawIssue({
            labels: [
              label('bug'),
              label('factory/dispatched'),
              label('factory:hold'),
              label('factory/quarantine'),
            ],
          }),
        ]),
      );

      const { issues } = await service.listIssues(REPO);

      expect(issues[0].labels.map((l) => l.name)).toEqual(['bug', 'factory:hold']);
    });

    it('ignores a mirror label that no constant names yet', async () => {
      // Prefix-based, so a mirror label added by a future issue is excluded
      // the day it is written rather than the day someone updates a list.
      http.paginate.mockResolvedValue(
        page([rawIssue({ labels: [label('factory/some-future-state')] })]),
      );

      const { issues } = await service.listIssues(REPO);

      expect(issues[0].labels).toEqual([]);
    });

    it('does NOT filter the repository label catalogue', async () => {
      // Different question: "does this mirror label exist in the repository
      // yet" is what #42 must ask before applying one. The filtering rule is
      // about reading an issue's state, not the label catalogue.
      http.paginate.mockResolvedValue(page([label('bug'), label('factory/dispatched')]));

      const labels = await service.listRepositoryLabels(REPO);

      expect(labels.map((l) => l.name)).toEqual(['bug', 'factory/dispatched']);
    });
  });

  describe('input labels', () => {
    it('extracts the recognised ones', async () => {
      http.paginate.mockResolvedValue(
        page([rawIssue({ labels: [label('factory:hold'), label('bug')] })]),
      );

      const { issues } = await service.listIssues(REPO);

      expect(issues[0].inputLabels).toEqual(['factory:hold']);
    });

    it('surfaces a mistyped one instead of dropping it', async () => {
      http.paginate.mockResolvedValue(
        page([rawIssue({ labels: [label('factory:hold-please')] })]),
      );

      const { issues } = await service.listIssues(REPO);

      expect(issues[0].inputLabels).toEqual([]);
      expect(issues[0].unknownInputLabels).toEqual(['factory:hold-please']);
    });
  });

  describe('listIssues', () => {
    it('excludes pull requests, which GitHub returns as issues', async () => {
      // The quirk that has bitten every integration written against this
      // endpoint. Filtered here so no consumer has to know.
      http.paginate.mockResolvedValue(
        page([rawIssue({ number: 1 }), rawIssue({ number: 2, pull_request: { url: 'x' } })]),
      );

      const { issues } = await service.listIssues(REPO);

      expect(issues.map((i) => i.number)).toEqual([1]);
    });

    it('defaults to open issues, newest activity first', async () => {
      http.paginate.mockResolvedValue(page([]));

      await service.listIssues(REPO);

      expect(http.paginate).toHaveBeenCalledWith(
        '/repos/acme/app/issues',
        expect.objectContaining({
          query: expect.objectContaining({ state: 'open', sort: 'updated', direction: 'desc' }),
        }),
      );
    });

    it('passes `since` as an ISO instant', async () => {
      http.paginate.mockResolvedValue(page([]));

      await service.listIssues(REPO, { since: new Date('2026-08-01T00:00:00Z') });

      const [, options] = http.paginate.mock.calls[0] as [string, { query: Record<string, unknown> }];
      expect(options.query.since).toBe('2026-08-01T00:00:00.000Z');
    });

    it('omits `labels` entirely when none are requested', async () => {
      // `labels=` is not the same query as no `labels` — GitHub reads the
      // empty one as "issues with no labels", which is a different result set.
      http.paginate.mockResolvedValue(page([]));

      await service.listIssues(REPO);

      const [, options] = http.paginate.mock.calls[0] as [string, { query: Record<string, unknown> }];
      expect(options.query.labels).toBeUndefined();
    });

    it('reports truncation rather than hiding it', async () => {
      http.paginate.mockResolvedValue({
        items: [rawIssue()],
        pages: 10,
        truncated: true,
        allFromCache: false,
      });

      const result = await service.listIssues(REPO);

      expect(result.truncated).toBe(true);
    });

    it('normalises timestamps to Date and a missing body to null', async () => {
      http.paginate.mockResolvedValue(page([rawIssue({ body: null })]));

      const { issues } = await service.listIssues(REPO);

      expect(issues[0].body).toBeNull();
      expect(issues[0].createdAt).toEqual(new Date('2026-08-01T10:00:00Z'));
    });

    it('tolerates a deleted author', async () => {
      // GitHub returns a null user for a deleted account; a consumer that
      // assumed otherwise would crash on an old issue.
      http.paginate.mockResolvedValue(page([rawIssue({ user: null })]));

      const { issues } = await service.listIssues(REPO);

      expect(issues[0].author).toBeNull();
    });
  });

  describe('pull requests', () => {
    function rawPull(overrides: Record<string, unknown> = {}) {
      return {
        number: 9,
        title: 'feat: export',
        body: null,
        state: 'open',
        head: { ref: 'factory/312-a3f91c2-a1', sha: 'abc123' },
        base: { ref: 'main' },
        user: { login: 'marinoscar' },
        html_url: 'https://github.com/acme/app/pull/9',
        created_at: '2026-08-01T10:00:00Z',
        updated_at: '2026-08-02T10:00:00Z',
        ...overrides,
      };
    }

    it('derives `merged` from merged_at, not from state', async () => {
      // GitHub reports a merged PR as `state: closed`, and the LIST endpoint
      // omits the `merged` boolean entirely — so reading that field would be
      // a silent false for every merged PR, which is exactly the number
      // success metric 5 (cost per merged PR) is computed from.
      http.paginate.mockResolvedValue(
        page([rawPull({ state: 'closed', merged_at: '2026-08-03T10:00:00Z' })]),
      );

      const [pull] = await service.listPullRequests(REPO, { state: 'all' });

      expect(pull.state).toBe('closed');
      expect(pull.merged).toBe(true);
      expect(pull.mergedAt).toEqual(new Date('2026-08-03T10:00:00Z'));
    });

    it('treats a closed-unmerged PR as not merged', async () => {
      http.paginate.mockResolvedValue(page([rawPull({ state: 'closed', merged_at: null })]));

      const [pull] = await service.listPullRequests(REPO, { state: 'all' });

      expect(pull.merged).toBe(false);
    });

    it('defaults draft to false when GitHub omits it', async () => {
      http.paginate.mockResolvedValue(page([rawPull()]));

      const [pull] = await service.listPullRequests(REPO);

      expect(pull.draft).toBe(false);
    });
  });

  describe('listChecks', () => {
    it('reads BOTH check runs and commit statuses', async () => {
      // A repository may use either or both. Asking only one is how "CI is
      // green" comes to mean "the system I queried had nothing to say" — and
      // #107 gates PR surfacing on this answer.
      http.paginate
        .mockResolvedValueOnce(
          page([{ name: 'build', status: 'completed', conclusion: 'success' }]),
        )
        .mockResolvedValueOnce(
          page([
            { context: 'ci/legacy', state: 'success', updated_at: '2026-08-02T10:00:00Z' },
          ]),
        );

      const checks = await service.listChecks(REPO, 'abc123');

      expect(checks).toHaveLength(2);
      expect(checks.map((c) => c.system).sort()).toEqual(['check-run', 'commit-status']);
    });

    it('unwraps the check-runs envelope', async () => {
      // The endpoint returns `{ total_count, check_runs: [...] }`, not an
      // array. Without the extractor nothing is collected and an empty result
      // reads as "no CI configured".
      const extractors: ((page: unknown) => unknown[])[] = [];
      http.paginate.mockImplementation(
        async (_path: string, options: { extract?: (page: unknown) => unknown[] } = {}) => {
          if (options.extract) extractors.push(options.extract);
          return page([]);
        },
      );

      await service.listChecks(REPO, 'abc123');

      expect(extractors).toHaveLength(1);
      expect(
        extractors[0]({ total_count: 1, check_runs: [{ name: 'build' }] }),
      ).toEqual([{ name: 'build' }]);
    });

    it('keeps only the newest status per context', async () => {
      // The statuses endpoint returns EVERY status ever posted for a context,
      // newest first. Counting the older ones would report a context as both
      // failed and passed.
      http.paginate.mockResolvedValueOnce(page([])).mockResolvedValueOnce(
        page([
          { context: 'ci/build', state: 'success', updated_at: '2026-08-02T12:00:00Z' },
          { context: 'ci/build', state: 'failure', updated_at: '2026-08-02T10:00:00Z' },
        ]),
      );

      const checks = await service.listChecks(REPO, 'abc123');

      expect(checks).toHaveLength(1);
      expect(checks[0].conclusion).toBe('success');
    });

    it('maps the Status API vocabulary onto the Checks API one', async () => {
      // `error` and `failure` are distinct states with no distinct conclusion,
      // and `pending` has no queued/in-progress split. A consumer asking "did
      // CI pass" should not have to know which API answered.
      http.paginate.mockResolvedValueOnce(page([])).mockResolvedValueOnce(
        page([
          { context: 'a', state: 'error', updated_at: '2026-08-02T10:00:00Z' },
          { context: 'b', state: 'pending', updated_at: '2026-08-02T10:00:00Z' },
        ]),
      );

      const checks = await service.listChecks(REPO, 'abc123');

      expect(checks.find((c) => c.name === 'a')).toMatchObject({
        status: 'completed',
        conclusion: 'failure',
      });
      expect(checks.find((c) => c.name === 'b')).toMatchObject({
        status: 'in_progress',
        conclusion: null,
        completedAt: null,
      });
    });

    it('asks GitHub for only the latest run of each check name', async () => {
      http.paginate.mockResolvedValue(page([]));

      await service.listChecks(REPO, 'abc123');

      const [, options] = http.paginate.mock.calls[0] as [string, { query: Record<string, unknown> }];
      // Without this a re-run leaves the previous failure in the result set
      // alongside the new pass.
      expect(options.query.filter).toBe('latest');
    });
  });

  describe('timeline events', () => {
    function labelEvent(overrides: Record<string, unknown> = {}) {
      return {
        event: 'labeled',
        label: { name: 'factory:clear-quarantine' },
        actor: { login: 'marinoscar', type: 'User' },
        created_at: '2026-08-02T10:00:00Z',
        ...overrides,
      };
    }

    it('keeps only label events out of a mixed timeline', async () => {
      http.paginate.mockResolvedValue(
        page([
          labelEvent(),
          { event: 'commented', actor: { login: 'x' }, created_at: '2026-08-02T11:00:00Z' },
          { event: 'closed', actor: { login: 'x' }, created_at: '2026-08-02T12:00:00Z' },
        ]),
      );

      const events = await service.listLabelEvents(REPO, 312);

      expect(events).toHaveLength(1);
      expect(events[0].label).toBe('factory:clear-quarantine');
    });

    it('drops a label event with no label payload rather than crashing', async () => {
      http.paginate.mockResolvedValue(page([{ event: 'labeled', created_at: '2026-08-02T10:00:00Z' }]));

      expect(await service.listLabelEvents(REPO, 312)).toEqual([]);
    });

    describe('bot detection', () => {
      it('flags an actor GitHub types as Bot', async () => {
        http.paginate.mockResolvedValue(
          page([labelEvent({ actor: { login: 'opifex', type: 'Bot' } })]),
        );

        expect((await service.listLabelEvents(REPO, 312))[0].actorIsBot).toBe(true);
      });

      it('flags a [bot] login even when GitHub types it as User', async () => {
        // A GitHub App acting through a token is reported as `User`. A human
        // check either signal alone can fool is not a check.
        http.paginate.mockResolvedValue(
          page([labelEvent({ actor: { login: 'opifex[bot]', type: 'User' } })]),
        );

        expect((await service.listLabelEvents(REPO, 312))[0].actorIsBot).toBe(true);
      });

      it('does not flag a human', async () => {
        http.paginate.mockResolvedValue(page([labelEvent()]));

        expect((await service.listLabelEvents(REPO, 312))[0].actorIsBot).toBe(false);
      });
    });

    describe('wasLabelAppliedByHuman', () => {
      const LABEL = 'factory:clear-quarantine';

      it('is true when a human applied it and nobody removed it', async () => {
        http.paginate.mockResolvedValue(page([labelEvent()]));

        expect(await service.wasLabelAppliedByHuman(REPO, 312, LABEL)).toBe(true);
      });

      it('is false when a bot applied it', async () => {
        // VISION §8: a quarantine cannot be cleared by the system that raised
        // it. This is the check that enforces it, and the reason #41 reads
        // the timeline at all — the label list can only say it is present.
        http.paginate.mockResolvedValue(
          page([labelEvent({ actor: { login: 'opifex[bot]', type: 'Bot' } })]),
        );

        expect(await service.wasLabelAppliedByHuman(REPO, 312, LABEL)).toBe(false);
      });

      it('is false when a human applied it and then removed it', async () => {
        http.paginate.mockResolvedValue(
          page([
            labelEvent(),
            labelEvent({ event: 'unlabeled', created_at: '2026-08-02T11:00:00Z' }),
          ]),
        );

        expect(await service.wasLabelAppliedByHuman(REPO, 312, LABEL)).toBe(false);
      });

      it('is false when a bot re-applied a label a human had removed', async () => {
        // The last event wins, so a bot cannot inherit a human's authority by
        // re-applying the label after the human took it off.
        http.paginate.mockResolvedValue(
          page([
            labelEvent(),
            labelEvent({ event: 'unlabeled', created_at: '2026-08-02T11:00:00Z' }),
            labelEvent({
              actor: { login: 'opifex[bot]', type: 'Bot' },
              created_at: '2026-08-02T12:00:00Z',
            }),
          ]),
        );

        expect(await service.wasLabelAppliedByHuman(REPO, 312, LABEL)).toBe(false);
      });

      it('ignores events for other labels', async () => {
        http.paginate.mockResolvedValue(
          page([labelEvent({ event: 'unlabeled', label: { name: 'bug' } }), labelEvent()]),
        );

        expect(await service.wasLabelAppliedByHuman(REPO, 312, LABEL)).toBe(true);
      });

      it('is false when the label was never applied at all', async () => {
        http.paginate.mockResolvedValue(page([]));

        expect(await service.wasLabelAppliedByHuman(REPO, 312, LABEL)).toBe(false);
      });
    });
  });

  describe('getRepository', () => {
    it('returns the default branch and visibility registration needs', async () => {
      http.request.mockResolvedValue({
        data: {
          name: 'app',
          owner: { login: 'acme' },
          default_branch: 'main',
          private: true,
          archived: false,
        },
        status: 200,
        fromCache: false,
        link: null,
        etag: null,
      });

      expect(await service.getRepository(REPO)).toEqual({
        owner: 'acme',
        name: 'app',
        defaultBranch: 'main',
        private: true,
        archived: false,
      });
    });
  });

  describe('listCommits', () => {
    it('normalises the commit author date, which liveness measures from', async () => {
      http.paginate.mockResolvedValue(
        page([
          {
            sha: 'abc123',
            commit: { message: 'feat: x', author: { date: '2026-08-02T10:00:00Z' } },
            author: { login: 'marinoscar' },
            html_url: 'https://github.com/acme/app/commit/abc123',
          },
        ]),
      );

      const [commit] = await service.listCommits(REPO, { branch: 'factory/312-a3f91c2-a1' });

      expect(commit.authoredAt).toEqual(new Date('2026-08-02T10:00:00Z'));
      expect(commit.sha).toBe('abc123');
    });
  });
});
