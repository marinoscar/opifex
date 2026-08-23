import { ConfigService } from '@nestjs/config';

import { EtagCacheService } from '../../src/github/etag-cache.service';
import { GitHubHttpService } from '../../src/github/github-http.service';
import { INPUT_LABELS, MIRROR_LABELS } from '../../src/github/labels/factory-labels';
import { RateLimitService } from '../../src/github/rate-limit.service';
import { GitHubReadService } from '../../src/github/read/github-read.service';
import { GitHubWriteService } from '../../src/github/write/github-write.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { MirrorLabelExecutor } from '../../src/reconciler/execute/mirror-label.executor';
import type { ReconcileAction } from '../../src/reconciler/diff/actions.types';
import { ReconcileLogService } from '../../src/reconciler/log/reconcile-log.service';
import { ReconcilerService } from '../../src/reconciler/reconciler.service';
import { TickLeaseService } from '../../src/reconciler/tick-lease.service';
import type { RepositoriesService } from '../../src/repositories/repositories.service';
import { WorkOrderProjectionService } from '../../src/work-orders/work-order-projection.service';
import { rawIssue, rawLabel, rawLabeledEvent } from '../fixtures/github/issues.fixture';

/**
 * Whole ticks, from raw GitHub JSON to a computed action list.
 *
 * `fetch` is mocked, NOT the read service — so every tick here runs the real
 * HTTP pipeline, the real normalization, the real projection and the real diff
 * engine. #51 asks for whole ticks against realistic payloads for exactly this
 * reason: the read adapter's job is absorbing GitHub's quirks, and mocking one
 * layer above it would test the quirks away.
 */

const REPO = {
  id: 'repo-uuid',
  owner: 'acme',
  name: 'app',
  defaultBranch: 'main',
  observeEnabled: true,
  dispatchEnabled: true,
  mirrorLabelsEnabled: false,
  specFeedbackEnabled: false,
  budgetCeilingUsd: null,
  wallClockTimeoutMinutes: null,
  lastObservedAt: null,
};

const HEAD = 'a3f91c2000000000000000000000000000000000';

/** The raw shape GitHub's commits endpoint returns, reduced to what is read. */
function rawCommit(sha = HEAD) {
  return {
    sha,
    html_url: `https://github.com/acme/app/commit/${sha}`,
    author: { login: 'someone' },
    commit: { message: 'Merge pull request #9', author: { date: '2026-08-23T01:00:00Z' } },
  };
}

function githubJson(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: new Headers({
      'content-type': 'application/json',
      'x-ratelimit-limit': '5000',
      'x-ratelimit-remaining': '4999',
      'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
      'x-ratelimit-resource': 'core',
      ...headers,
    }),
  });
}

describe('reconciler ticks against a mocked GitHub', () => {
  let fetchMock: jest.SpyInstance;
  let prisma: {
    repository: { update: jest.Mock };
    workOrder: {
      findMany: jest.Mock;
      findUnique: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
  };
  let reconciler: ReconcilerService;

  /** Route by URL so a tick can make several different calls in any order. */
  function respond(routes: { issues: unknown[]; timeline?: unknown[]; commits?: unknown[] }) {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/timeline')) return githubJson(routes.timeline ?? []);
      if (url.includes('/issues')) return githubJson(routes.issues);
      if (url.includes('/commits')) return githubJson(routes.commits ?? [rawCommit()]);
      return githubJson([]);
    });
  }

  function build(repository: Partial<typeof REPO> = {}) {
    const values: Record<string, unknown> = {
      'reconciler.enabled': true,
      'github.token': 'ghp_test',
      'github.apiBaseUrl': 'https://api.github.com',
      'github.userAgent': 'opifex-test',
      'github.requestTimeoutMs': 5000,
      'github.maxRetries': 0,
      'github.rateLimitReserve': 100,
    };
    const config = { get: (k: string) => values[k] } as unknown as ConfigService;

    const rateLimit = new RateLimitService();
    const http = new GitHubHttpService(config, rateLimit, new EtagCacheService(50));
    const read = new GitHubReadService(http);

    return new ReconcilerService(
      config,
      {
        withLease: jest.fn(async (work: () => Promise<unknown>) => ({
          acquired: true,
          result: await work(),
        })),
      } as unknown as TickLeaseService,
      {
        listObserved: jest.fn().mockResolvedValue([{ ...REPO, ...repository }]),
      } as unknown as RepositoriesService,
      read,
      http,
      rateLimit,
      prisma as unknown as PrismaService,
      { record: jest.fn().mockResolvedValue(undefined) } as unknown as ReconcileLogService,
      // The REAL projection service, against the Prisma double. #51 asks for
      // whole ticks: substituting a mock here would leave the join between
      // raw GitHub JSON and a work order row — the thing #155 built —
      // untested end to end.
      new WorkOrderProjectionService(prisma as unknown as PrismaService),
    );
  }

  beforeEach(() => {
    fetchMock = jest.spyOn(globalThis, 'fetch');
    prisma = {
      repository: { update: jest.fn().mockResolvedValue({}) },
      workOrder: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    reconciler = build();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function actionTypes(actions: ReconcileAction[]): string[] {
    return actions.map((a) => a.type);
  }

  describe('an issue gains factory:ready', () => {
    it('produces a dispatch action', async () => {
      respond({ issues: [rawIssue({ labels: [rawLabel(INPUT_LABELS.READY)] })] });

      const record = await reconciler.tick();

      expect(record.outcome).toBe('completed');
      expect(actionTypes(record.actions)).toContain('dispatch');
    });

    it('names the label in the reason, so the decision is reviewable', async () => {
      respond({ issues: [rawIssue({ labels: [rawLabel(INPUT_LABELS.READY)] })] });

      const record = await reconciler.tick();

      expect(record.actions[0].reason).toContain(INPUT_LABELS.READY);
      expect(record.actions[0].evidence.inputLabels).toEqual([INPUT_LABELS.READY]);
    });
  });

  describe('an issue gains factory:hold mid-run', () => {
    it('holds, and hold beats every other signal', async () => {
      prisma.workOrder.findMany.mockResolvedValue([
        {
          id: 'wo',
          identity: 'wo_app_312_a3f91c2_a1',
          issueNumber: 312,
          attempt: 1,
          status: 'dispatched',
          runs: [{ id: 'r', status: 'running', costUsd: null, pullRequestUrl: null }],
        },
      ]);
      respond({
        issues: [
          rawIssue({
            labels: [rawLabel(INPUT_LABELS.HOLD), rawLabel(INPUT_LABELS.READY)],
          }),
        ],
      });

      const record = await reconciler.tick();

      expect(record.projections[0].issues[0].intent).toBe('hold');
      expect(actionTypes(record.actions)).not.toContain('dispatch');
    });
  });

  describe('a human edits state between ticks', () => {
    it('is reflected on the very next tick, with no reset', async () => {
      // The reconciler-vs-queue property from VISION §4. A queue would have to
      // be told; the reconciler simply recomputes from what it now observes.
      respond({ issues: [rawIssue({ labels: [rawLabel(INPUT_LABELS.READY)] })] });
      const before = await reconciler.tick();

      // The operator adds factory:hold in GitHub. Nothing tells the tick.
      respond({
        issues: [
          rawIssue({
            labels: [rawLabel(INPUT_LABELS.READY), rawLabel(INPUT_LABELS.HOLD)],
            // A different ETag, as GitHub would send after an edit.
            updated_at: '2026-08-02T12:00:00Z',
          }),
        ],
      });
      const after = await reconciler.tick();

      expect(actionTypes(before.actions)).toContain('dispatch');
      expect(actionTypes(after.actions)).toEqual(['hold']);
    });

    it('recovers when the human REMOVES a label too', async () => {
      respond({ issues: [rawIssue({ labels: [rawLabel(INPUT_LABELS.HOLD)] })] });
      await reconciler.tick();

      respond({ issues: [rawIssue({ labels: [rawLabel(INPUT_LABELS.READY)] })] });
      const after = await reconciler.tick();

      expect(actionTypes(after.actions)).toContain('dispatch');
    });
  });

  describe('mirror labels present in GitHub', () => {
    it('do NOT influence the projection', async () => {
      // VISION §3.3. If they did, the control plane would read its own output
      // as input and the state machine would have moved into issue labels.
      respond({ issues: [rawIssue({ labels: [rawLabel(INPUT_LABELS.READY)] })] });
      const clean = await reconciler.tick();

      respond({
        issues: [
          rawIssue({
            labels: [
              rawLabel(INPUT_LABELS.READY),
              rawLabel(MIRROR_LABELS.QUARANTINE),
              rawLabel(MIRROR_LABELS.BLOCKED),
            ],
          }),
        ],
      });
      const dirty = await reconciler.tick();

      expect(dirty.projections[0].issues[0].intent).toBe(clean.projections[0].issues[0].intent);
      expect(dirty.projections[0].issues[0].reason).toBe(clean.projections[0].issues[0].reason);
    });

    it('ARE used to decide which labels to write', async () => {
      // The other half of the distinction: read as the current state of the
      // output, never as truth about what should be true.
      respond({
        issues: [
          rawIssue({
            labels: [rawLabel(INPUT_LABELS.READY), rawLabel(MIRROR_LABELS.DISPATCHED)],
          }),
        ],
      });

      const record = await reconciler.tick();

      // Already correct, so no label write is proposed.
      expect(actionTypes(record.actions)).not.toContain('add-mirror-label');
    });
  });

  describe('idempotency', () => {
    it('the same tick run twice produces the same actions', async () => {
      respond({ issues: [rawIssue({ labels: [rawLabel(INPUT_LABELS.READY)] })] });

      const first = await reconciler.tick();
      const second = await reconciler.tick();

      expect(second.actions).toEqual(first.actions);
    });

    it('executing the same action list twice is safe', async () => {
      const writes = {
        addLabel: jest.fn().mockResolvedValue({ performed: true, noop: false }),
        removeLabel: jest.fn().mockResolvedValue({ performed: true, noop: false }),
      };
      const executor = new MirrorLabelExecutor(writes as unknown as GitHubWriteService);
      respond({ issues: [rawIssue({ labels: [rawLabel(INPUT_LABELS.READY)] })] });
      const record = await reconciler.tick();

      const enabled = new Set(['acme/app']);
      await executor.execute(record.actions, enabled);
      // Second time, GitHub reports the label already present.
      writes.addLabel.mockResolvedValue({ performed: true, noop: true });
      const second = await executor.execute(record.actions, enabled);

      expect(second.failures).toEqual([]);
      expect(second.executed).toBe(0);
      expect(second.noops).toBe(1);
    });
  });

  describe('GitHub quirks the adapter must absorb', () => {
    it('excludes a pull request that GitHub returned as an issue', async () => {
      respond({
        issues: [
          rawIssue({ number: 1, labels: [rawLabel(INPUT_LABELS.READY)] }),
          rawIssue({
            number: 2,
            labels: [rawLabel(INPUT_LABELS.READY)],
            pull_request: { url: 'https://api.github.com/repos/acme/app/pulls/2' },
          }),
        ],
      });

      const record = await reconciler.tick();

      expect(record.projections[0].issues.map((i) => i.issueNumber)).toEqual([1]);
    });

    it('tolerates a deleted author', async () => {
      respond({ issues: [rawIssue({ user: null, labels: [rawLabel(INPUT_LABELS.READY)] })] });

      const record = await reconciler.tick();

      expect(record.outcome).toBe('completed');
    });

    it('tolerates an empty body', async () => {
      respond({ issues: [rawIssue({ body: null, labels: [rawLabel(INPUT_LABELS.READY)] })] });

      expect((await reconciler.tick()).outcome).toBe('completed');
    });
  });

  describe('quarantine clearing reads the timeline', () => {
    function quarantined() {
      prisma.workOrder.findMany.mockResolvedValue([
        {
          id: 'wo',
          identity: 'wo_app_312_a3f91c2_a1',
          issueNumber: 312,
          attempt: 1,
          status: 'quarantined',
          runs: [],
        },
      ]);
    }

    it('releases when a human applied the label', async () => {
      quarantined();
      respond({
        issues: [rawIssue({ labels: [rawLabel(INPUT_LABELS.CLEAR_QUARANTINE)] })],
        timeline: [rawLabeledEvent(INPUT_LABELS.CLEAR_QUARANTINE, { login: 'marinoscar', type: 'User' })],
      });

      const record = await reconciler.tick();

      expect(actionTypes(record.actions)).toContain('release-quarantine');
    });

    it('REFUSES when a GitHub App applied it', async () => {
      // VISION §8. The `[bot]` suffix with type User is the case a naive
      // check misses — a GitHub App acting through a token.
      quarantined();
      respond({
        issues: [rawIssue({ labels: [rawLabel(INPUT_LABELS.CLEAR_QUARANTINE)] })],
        timeline: [rawLabeledEvent(INPUT_LABELS.CLEAR_QUARANTINE, { login: 'opifex[bot]', type: 'User' })],
      });

      const record = await reconciler.tick();

      expect(record.projections[0].issues[0].intent).toBe('quarantined');
      expect(actionTypes(record.actions)).not.toContain('release-quarantine');
    });
  });

  describe('rate-limit exhaustion mid-tick', () => {
    it('degrades cleanly instead of producing a half-computed projection', async () => {
      fetchMock.mockImplementation(
        async () =>
          new Response(JSON.stringify({ message: 'API rate limit exceeded' }), {
            status: 403,
            headers: new Headers({
              'x-ratelimit-limit': '5000',
              'x-ratelimit-remaining': '0',
              'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
            }),
          }),
      );

      const record = await reconciler.tick();

      // Reported, not thrown, and with the reset time so a scheduler can plan.
      expect(record.outcome).toBe('partial');
      expect(record.failures[0].reason).toMatch(/resets at/);
      // No partial projection is emitted for the repository that failed.
      expect(record.projections).toEqual([]);
      expect(record.actions).toEqual([]);
    });

    it('skips the next tick entirely once the budget is known to be spent', async () => {
      fetchMock.mockImplementation(
        async () =>
          new Response(JSON.stringify({ message: 'API rate limit exceeded' }), {
            status: 403,
            headers: new Headers({
              'x-ratelimit-limit': '5000',
              'x-ratelimit-remaining': '0',
              'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
            }),
          }),
      );

      await reconciler.tick();
      const calls = fetchMock.mock.calls.length;
      const second = await reconciler.tick();

      expect(second.outcome).toBe('skipped-rate-limited');
      // It did not spend another request to rediscover the exhaustion.
      expect(fetchMock.mock.calls.length).toBe(calls);
    });
  });

  describe('conditional requests', () => {
    it('a second tick over unchanged issues costs no quota', async () => {
      // #40's ETag path, end to end: this is what makes polling affordable.
      const issues = [rawIssue({ labels: [rawLabel(INPUT_LABELS.READY)] })];
      fetchMock.mockImplementationOnce(async () =>
        githubJson(issues, { etag: 'W/"tick1"' }),
      );
      await reconciler.tick();

      fetchMock.mockImplementationOnce(
        async () =>
          new Response(null, {
            status: 304,
            headers: new Headers({
              etag: 'W/"tick1"',
              'x-ratelimit-limit': '5000',
              'x-ratelimit-remaining': '4999',
              'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
            }),
          }),
      );
      const second = await reconciler.tick();

      expect(second.allFromCache).toBe(true);
      // And the projection is still complete — a 304 must not mean "no data".
      expect(second.projections[0].issues).toHaveLength(1);
    });
  });

  describe('an eligible issue becomes a work order (#155)', () => {
    /** A body that passes #108's conformance gate and #62's criteria check. */
    const READY_BODY = `## Problem statement

Operators export reports by hand, twenty minutes at a time.

## Proposed solution

Add a CSV export button to the reports page, backed by the existing report
query, streaming the rows rather than buffering them.

## Acceptance criteria

- [ ] Clicking export downloads a CSV of the current filter selection
- [ ] A report with no rows downloads a file with only the header row
- [ ] The export path is covered by an integration test

## Affected component

\`apps/web/src/reports/**\`

## Priority

P1
`;

    function readyIssue(overrides: Record<string, unknown> = {}) {
      return rawIssue({
        body: READY_BODY,
        labels: [rawLabel(INPUT_LABELS.READY)],
        ...overrides,
      });
    }

    it('writes a queued row from raw GitHub JSON', async () => {
      // The whole join #155 built, end to end: raw issue JSON in, a work order
      // row out. Every layer between is real — the HTTP pipeline, the read
      // adapter, the projection, the generator and the writer.
      respond({ issues: [readyIssue()] });

      const record = await build().tick();

      expect(prisma.workOrder.create).toHaveBeenCalledTimes(1);
      expect(prisma.workOrder.create.mock.calls[0][0].data).toMatchObject({
        repositoryId: 'repo-uuid',
        issueNumber: 312,
        status: 'queued',
        baseCommit: HEAD,
      });
      expect(record.workOrdersCreated).toBe(1);
    });

    it('pins the tip of the default branch the tick actually read', async () => {
      const other = 'b'.repeat(40);
      respond({ issues: [readyIssue()], commits: [rawCommit(other)] });

      await build().tick();

      expect(prisma.workOrder.create.mock.calls[0][0].data.baseCommit).toBe(other);
    });

    it('derives the identity and branch from those coordinates', async () => {
      respond({ issues: [readyIssue()] });

      await build().tick();

      const data = prisma.workOrder.create.mock.calls[0][0].data;
      expect(data.identity).toBe('wo_app_312_a3f91c2_a1');
      expect(data.branch).toBe('factory/312-a3f91c2-a1');
    });

    it('writes the fields a stored work order needs to be rebuilt', async () => {
      // #154's round trip is only real if the writer populates them.
      respond({ issues: [readyIssue()] });

      await build().tick();

      expect(prisma.workOrder.create.mock.calls[0][0].data).toMatchObject({
        issueUrl: 'https://github.com/acme/app/issues/312',
        issueTitle: 'Add CSV export to the reports page',
        needs: [],
      });
    });

    it('writes a held row when factory:hold is also present', async () => {
      respond({
        issues: [
          readyIssue({ labels: [rawLabel(INPUT_LABELS.READY), rawLabel(INPUT_LABELS.HOLD)] }),
        ],
      });

      await build().tick();

      expect(prisma.workOrder.create.mock.calls[0][0].data.status).toBe('held');
    });

    it('writes nothing, and reads no commits, for an issue without factory:ready', async () => {
      respond({ issues: [rawIssue({ body: READY_BODY })] });

      await build().tick();

      expect(prisma.workOrder.create).not.toHaveBeenCalled();
      expect(
        fetchMock.mock.calls.filter(([url]: [string]) => url.includes('/commits')),
      ).toHaveLength(0);
    });

    it('rejects a placeholder spec and carries the reason off the tick', async () => {
      // VISION §10: spec quality is the throughput ceiling, so this is the
      // normal case to handle well — the reason has to reach the author.
      const placeholder = READY_BODY.replace(
        /## Acceptance criteria[\s\S]*?(?=## Affected)/,
        '## Acceptance criteria\n\n- [ ] TBD\n- [ ] It works nicely\n\n',
      );
      respond({ issues: [readyIssue({ body: placeholder })] });

      const record = await build().tick();

      expect(prisma.workOrder.create).not.toHaveBeenCalled();
      expect(record.rejections).toHaveLength(1);
      expect(record.rejections[0]).toMatchObject({
        issueNumber: 312,
        repository: { owner: 'acme', name: 'app' },
        feedbackEnabled: false,
      });
    });

    it('does not project again once a work order exists', async () => {
      // The tick recomputes from scratch every 60 seconds. Re-projecting at
      // the current HEAD would mint a new identity on every merge to main.
      prisma.workOrder.findMany.mockResolvedValue([
        {
          id: 'wo',
          identity: 'wo_app_312_a3f91c2_a1',
          issueNumber: 312,
          attempt: 1,
          status: 'queued',
          runs: [],
        },
      ]);
      respond({ issues: [readyIssue()] });

      await build().tick();

      expect(prisma.workOrder.create).not.toHaveBeenCalled();
      expect(
        fetchMock.mock.calls.filter(([url]: [string]) => url.includes('/commits')),
      ).toHaveLength(0);
    });
  });
});
