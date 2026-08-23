import { ConfigService } from '@nestjs/config';

import { GitHubHttpService } from '../github/github-http.service';
import { GitHubNotFoundError, GitHubRateLimitError } from '../github/github.errors';
import { RateLimitService } from '../github/rate-limit.service';
import { GitHubReadService } from '../github/read/github-read.service';
import { PrismaService } from '../prisma/prisma.service';
import { RepositoriesService } from '../repositories/repositories.service';
import { WorkOrderProjectionService } from '../work-orders/work-order-projection.service';
import { ReconcilerService } from './reconciler.service';
import { ReconcileLogService } from './log/reconcile-log.service';
import { TickLeaseService } from './tick-lease.service';

function repository(overrides: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    owner: 'acme',
    name: 'app',
    defaultBranch: 'main',
    lastObservedAt: null,
    budgetCeilingUsd: null,
    wallClockTimeoutMinutes: null,
    specFeedbackEnabled: false,
    ...overrides,
  };
}

/**
 * A projection pass that produced nothing.
 *
 * These suites drive the tick with a live GitHub double and a Prisma double;
 * the projection has its own suite, and letting it run here would make every
 * label assertion depend on a work order write.
 */
function emptyProjection() {
  return {
    created: [],
    heldOnCreate: 0,
    alreadyPresent: 0,
    holdsApplied: 0,
    holdsLifted: 0,
    rejected: [],
    skipped: {},
  };
}

describe('ReconcilerService', () => {
  let lease: { withLease: jest.Mock };
  let repositories: { listObserved: jest.Mock };
  let github: { listIssues: jest.Mock; listCommits: jest.Mock };
  let http: { canSpend: jest.Mock };
  let rateLimit: RateLimitService;
  let workOrders: { project: jest.Mock };
  let prisma: {
    repository: { update: jest.Mock };
    workOrder: { findMany: jest.Mock };
  };

  function build(config: Record<string, unknown> = {}): ReconcilerService {
    const values: Record<string, unknown> = {
      'reconciler.enabled': true,
      'github.rateLimitReserve': 100,
      ...config,
    };
    return new ReconcilerService(
      { get: (k: string) => values[k] } as unknown as ConfigService,
      lease as unknown as TickLeaseService,
      repositories as unknown as RepositoriesService,
      github as unknown as GitHubReadService,
      http as unknown as GitHubHttpService,
      rateLimit,
      prisma as unknown as PrismaService,
      // Recording is a separate concern from reconciling — these suites are
      // about what the tick DECIDES, and #50's own spec covers persistence.
      { record: jest.fn().mockResolvedValue(undefined) } as unknown as ReconcileLogService,
      // Projection is its own suite (`work-order-projection.service.spec.ts`).
      // A double here keeps these tests about what the TICK does with it.
      workOrders as unknown as WorkOrderProjectionService,
    );
  }

  beforeEach(() => {
    // Passes the callback through by default; overridden where the lease
    // itself is the thing under test.
    lease = {
      withLease: jest.fn(async (work: () => Promise<unknown>) => ({
        acquired: true,
        result: await work(),
      })),
    };
    repositories = { listObserved: jest.fn().mockResolvedValue([repository()]) };
    github = {
      listIssues: jest.fn().mockResolvedValue({ issues: [], truncated: false, allFromCache: false }),
      listCommits: jest.fn().mockResolvedValue([{ sha: 'a'.repeat(40) }]),
    };
    workOrders = { project: jest.fn().mockResolvedValue(emptyProjection()) };
    http = { canSpend: jest.fn().mockReturnValue(true) };
    rateLimit = new RateLimitService();
    prisma = {
      repository: { update: jest.fn().mockResolvedValue({}) },
      workOrder: { findMany: jest.fn().mockResolvedValue([]) },
    };
  });

  describe('when disabled', () => {
    it('does nothing at all and says so', async () => {
      const record = await build({ 'reconciler.enabled': false }).tick();

      expect(record.outcome).toBe('skipped-disabled');
      expect(repositories.listObserved).not.toHaveBeenCalled();
      expect(lease.withLease).not.toHaveBeenCalled();
    });
  });

  describe('the lease', () => {
    it('records a skip rather than an error when another tick holds it', async () => {
      // Overlap is the expected outcome of a tick that ran long. Reporting it
      // as a failure would make a healthy system look broken in the log the
      // observation week is reviewed from.
      lease.withLease.mockResolvedValue({ acquired: false });

      const record = await build().tick();

      expect(record.outcome).toBe('skipped-locked');
      expect(record.failures).toEqual([]);
    });

    it('does all observation INSIDE the lease', async () => {
      // If any read happened outside it, two overlapping ticks would both hit
      // GitHub — which is the whole thing the lease exists to prevent.
      let observedInside = false;
      lease.withLease.mockImplementation(async (work: () => Promise<unknown>) => {
        expect(github.listIssues).not.toHaveBeenCalled();
        const result = await work();
        observedInside = github.listIssues.mock.calls.length > 0;
        return { acquired: true, result };
      });

      await build().tick();

      expect(observedInside).toBe(true);
    });
  });

  describe('rate-limit awareness', () => {
    it('skips the whole tick when the budget is at the reserve', async () => {
      // Checked BEFORE the lease: a tick that cannot afford to read should not
      // also block the next one from trying.
      http.canSpend.mockReturnValue(false);

      const record = await build().tick();

      expect(record.outcome).toBe('skipped-rate-limited');
      expect(lease.withLease).not.toHaveBeenCalled();
    });

    it('is a distinct outcome from a failure', async () => {
      // Conflating the two would make a healthy rate-limited system
      // indistinguishable from a broken one in the tick log.
      http.canSpend.mockReturnValue(false);

      const record = await build().tick();

      expect(record.outcome).not.toBe('failed');
      expect(record.outcome).not.toBe('partial');
    });

    it('stops mid-sweep when the budget runs out, rather than spending the reserve', async () => {
      repositories.listObserved.mockResolvedValue([
        repository({ id: 'a', name: 'one' }),
        repository({ id: 'b', name: 'two' }),
      ]);
      http.canSpend.mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValue(false);

      const record = await build().tick();

      expect(record.repositoriesObserved).toBe(1);
      expect(record.failures[0].reason).toMatch(/reserve/);
    });

    it('abandons the sweep on an exhaustion error instead of collecting identical ones', async () => {
      repositories.listObserved.mockResolvedValue([
        repository({ id: 'a', name: 'one' }),
        repository({ id: 'b', name: 'two' }),
        repository({ id: 'c', name: 'three' }),
      ]);
      github.listIssues.mockRejectedValue(
        new GitHubRateLimitError('exhausted', 403, 'GET', '/x', new Date(Date.now() + 3600_000), false),
      );

      const record = await build().tick();

      // One failure, not three.
      expect(record.failures).toHaveLength(1);
      expect(record.failures[0].reason).toMatch(/resets at/);
    });
  });

  describe('observation', () => {
    it('marks each repository observed, so the next tick starts with the stalest', async () => {
      await build().tick();

      expect(prisma.repository.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: '11111111-1111-1111-1111-111111111111' },
          data: expect.objectContaining({ lastObservedAt: expect.any(Date) }),
        }),
      );
    });

    it('observes sequentially, not in parallel', async () => {
      // Parallelism multiplies the burst rate against a shared budget
      // (VISION §11) for no benefit a reconciler cares about.
      repositories.listObserved.mockResolvedValue([
        repository({ id: 'a', name: 'one' }),
        repository({ id: 'b', name: 'two' }),
      ]);
      let inFlight = 0;
      let maxInFlight = 0;
      github.listIssues.mockImplementation(async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        return { issues: [], truncated: false, allFromCache: false };
      });

      await build().tick();

      expect(maxInFlight).toBe(1);
    });

    it('keeps going past one broken repository', async () => {
      // One bad repository must not become a dead factory.
      repositories.listObserved.mockResolvedValue([
        repository({ id: 'a', name: 'broken' }),
        repository({ id: 'b', name: 'fine' }),
      ]);
      github.listIssues
        .mockRejectedValueOnce(new GitHubNotFoundError('Not Found', 404, 'GET', '/x'))
        .mockResolvedValue({ issues: [], truncated: false, allFromCache: false });

      const record = await build().tick();

      expect(record.outcome).toBe('partial');
      expect(record.repositoriesObserved).toBe(1);
      expect(record.failures).toEqual([
        { repository: 'acme/broken', reason: 'Not Found' },
      ]);
    });

    it('completes cleanly when there is nothing registered', async () => {
      repositories.listObserved.mockResolvedValue([]);

      const record = await build().tick();

      expect(record.outcome).toBe('completed');
      expect(record.repositoriesObserved).toBe(0);
    });
  });

  describe('the projection', () => {
    it('is computed for each observed repository and carried on the record', async () => {
      // It is the deliverable of VISION §12's observation week, not a
      // debugging aid — reviewing what the reconciler CONCLUDED, before it
      // could act, is the point of the week.
      github.listIssues.mockResolvedValue({
        issues: [
          {
            number: 312,
            title: 'x',
            body: null,
            state: 'open',
            author: 'a',
            labels: [],
            inputLabels: ['factory:ready'],
            unknownInputLabels: [],
            isPullRequest: false,
            url: 'u',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
        truncated: false,
        allFromCache: false,
      });

      const record = await build().tick();

      expect(record.projections).toHaveLength(1);
      expect(record.projections[0].issues[0]).toMatchObject({
        issueNumber: 312,
        // Dispatch is disabled by default on a repository, so `factory:ready`
        // alone must NOT produce a dispatch intent.
        intent: 'ignore',
      });
    });

    it('clears no quarantine until the timeline is consulted', async () => {
      // The safe default while #49 is outstanding: an empty
      // `humanClearedQuarantine` releases nothing, which is the right way to
      // be wrong about VISION §8's only-a-human rule.
      github.listIssues.mockResolvedValue({
        issues: [
          {
            number: 312,
            title: 'x',
            body: null,
            state: 'open',
            author: 'a',
            labels: [],
            inputLabels: ['factory:clear-quarantine'],
            unknownInputLabels: [],
            isPullRequest: false,
            url: 'u',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
        truncated: false,
        allFromCache: false,
      });
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

      const record = await build().tick();

      expect(record.projections[0].issues[0].intent).toBe('quarantined');
    });

    it('carries no projection for a tick that observed nothing', async () => {
      repositories.listObserved.mockResolvedValue([]);

      expect((await build().tick()).projections).toEqual([]);
    });

    it('computes actions but executes none of them', async () => {
      // VISION §12's observation week: the tick records what it WOULD have
      // done. The reconciler module has no write adapter in its injector, so
      // this is structural rather than a flag — but the record has to carry
      // the list, or the week produces nothing reviewable.
      github.listIssues.mockResolvedValue({
        issues: [
          {
            number: 312,
            title: 'x',
            body: null,
            state: 'open',
            author: 'a',
            labels: [],
            inputLabels: [],
            unknownInputLabels: [],
            // A stale mirror label, which is a state that DOES produce an
            // action even with no input labels set.
            observedMirrorLabels: ['factory/dispatched'],
            isPullRequest: false,
            url: 'u',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
        truncated: false,
        allFromCache: false,
      });

      const record = await build().tick();

      expect(record.actions).toEqual([
        expect.objectContaining({ type: 'remove-mirror-label', label: 'factory/dispatched' }),
      ]);
    });

    it('records an empty action list for a quiet tick', async () => {
      // A healthy steady state must cost nothing, or a week of log is
      // unreviewable.
      expect((await build().tick()).actions).toEqual([]);
    });
  });

  describe('the record', () => {
    it('always reports a duration and both timestamps', async () => {
      // #45: tick latency has to be MEASURABLE, because VISION §13 says add
      // webhooks only when it demonstrably hurts.
      const record = await build().tick();

      expect(record.durationMs).toBeGreaterThanOrEqual(0);
      expect(record.finishedAt.getTime()).toBeGreaterThanOrEqual(record.startedAt.getTime());
    });

    it('is recorded even for a tick that computed nothing', async () => {
      // #50: "Every tick is recorded, including ticks that computed no
      // actions." A log with gaps in it cannot be reviewed for a week —
      // a missing entry is indistinguishable from a tick that never ran.
      repositories.listObserved.mockResolvedValue([]);
      const service = build();

      await service.tick();

      expect(service.lastTickRecord).toMatchObject({
        outcome: 'completed',
        repositoriesObserved: 0,
      });
    });

    it('exposes the last tick', async () => {
      const service = build();
      expect(service.lastTickRecord).toBeNull();

      await service.tick();

      expect(service.lastTickRecord?.outcome).toBe('completed');
    });

    it('reports when a whole tick was served from cache and cost no quota', async () => {
      // The number that says whether polling is affordable at all (#40).
      github.listIssues.mockResolvedValue({ issues: [], truncated: false, allFromCache: true });

      expect((await build().tick()).allFromCache).toBe(true);
    });

    it('reports allFromCache false when any repository was actually fetched', async () => {
      repositories.listObserved.mockResolvedValue([
        repository({ id: 'a', name: 'one' }),
        repository({ id: 'b', name: 'two' }),
      ]);
      github.listIssues
        .mockResolvedValueOnce({ issues: [], truncated: false, allFromCache: true })
        .mockResolvedValueOnce({ issues: [], truncated: false, allFromCache: false });

      expect((await build().tick()).allFromCache).toBe(false);
    });

    it('carries the remaining budget when known', async () => {
      rateLimit.record(
        new Headers({
          'x-ratelimit-limit': '5000',
          'x-ratelimit-remaining': '4321',
          'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
        }),
      );

      expect((await build().tick()).rateLimitRemaining).toBe(4321);
    });

    it('reports an unknown budget as null rather than zero', async () => {
      expect((await build().tick()).rateLimitRemaining).toBeNull();
    });
  });

  describe('projecting work orders (#155)', () => {
    const READY_ISSUE = {
      number: 312,
      title: 'Add a permit search prompt builder',
      body: 'anything',
      state: 'open' as const,
      author: 'marinoscar',
      labels: [],
      inputLabels: ['factory:ready'],
      unknownInputLabels: [],
      observedMirrorLabels: [],
    };

    function withIssues(issues: unknown[]): void {
      github.listIssues.mockResolvedValue({ issues, truncated: false, allFromCache: false });
    }

    it('pins the tip of the default branch onto the pass', async () => {
      // #62: the base commit is pinned at generation and never resolved later.
      withIssues([READY_ISSUE]);

      await build().tick();

      expect(github.listCommits).toHaveBeenCalledWith(
        { owner: 'acme', name: 'app' },
        expect.objectContaining({ branch: 'main' }),
      );
      expect(workOrders.project.mock.calls[0][0].baseCommit).toBe('a'.repeat(40));
    });

    it('resolves the head ONCE for a repository, not once per issue', async () => {
      // Two issues projected in the same tick must not disagree about what
      // "now" was — a race that only shows up on a repository someone is
      // actively merging into.
      withIssues([READY_ISSUE, { ...READY_ISSUE, number: 313 }]);

      await build().tick();

      expect(github.listCommits).toHaveBeenCalledTimes(1);
      expect(workOrders.project).toHaveBeenCalledTimes(1);
    });

    it('spends no GitHub request when nothing is marked ready', async () => {
      // VISION §11 holds a rate-limit reserve back for the operator. Resolving
      // HEAD every 60 seconds to discover there is nothing to do would be a
      // slow leak of exactly that reserve.
      withIssues([{ ...READY_ISSUE, inputLabels: [] }]);

      await build().tick();

      expect(github.listCommits).not.toHaveBeenCalled();
      expect(workOrders.project).not.toHaveBeenCalled();
    });

    it('spends no GitHub request when every ready issue already has one', async () => {
      // The steady state, and the reason this is affordable on every tick.
      withIssues([READY_ISSUE]);
      prisma.workOrder.findMany.mockResolvedValue([
        { id: 'wo', identity: 'wo_app_312_aaaaaaa_a1', issueNumber: 312, attempt: 1, status: 'queued', runs: [] },
      ]);

      await build().tick();

      expect(github.listCommits).not.toHaveBeenCalled();
    });

    it('still runs the pass when dispatch is disabled', async () => {
      // A queued work order is inert without DISPATCH_ENABLED, and seeing what
      // the factory WOULD work on is the artifact VISION §12 asks the
      // observation week to produce.
      repositories.listObserved.mockResolvedValue([
        { ...repository(), dispatchEnabled: false },
      ]);
      withIssues([READY_ISSUE]);

      await build().tick();

      expect(workOrders.project).toHaveBeenCalled();
    });

    it('carries rejections off the tick rather than acting on them', async () => {
      // The component that decides an issue is unbuildable must not be the one
      // that comments on it. The task is where computing meets acting.
      withIssues([READY_ISSUE]);
      workOrders.project.mockResolvedValue({
        ...emptyProjection(),
        rejected: [
          { issueNumber: 312, problems: [], message: 'TBD is not a criterion', bodyDigest: 'abc' },
        ],
      });

      const record = await build().tick();

      expect(record.rejections).toHaveLength(1);
      expect(record.rejections[0]).toMatchObject({
        issueNumber: 312,
        repository: { owner: 'acme', name: 'app' },
      });
    });

    it('tells the task whether the repository opted in to feedback', async () => {
      withIssues([READY_ISSUE]);
      repositories.listObserved.mockResolvedValue([
        { ...repository(), specFeedbackEnabled: true },
      ]);
      workOrders.project.mockResolvedValue({
        ...emptyProjection(),
        rejected: [{ issueNumber: 312, problems: [], message: 'no', bodyDigest: 'abc' }],
      });

      const record = await build().tick();

      expect(record.rejections[0].feedbackEnabled).toBe(true);
    });

    it('counts what it created', async () => {
      withIssues([READY_ISSUE]);
      workOrders.project.mockResolvedValue({
        ...emptyProjection(),
        created: [{ identity: 'wo_app_312_aaaaaaa_a1' }],
      });

      const record = await build().tick();

      expect(record.workOrdersCreated).toBe(1);
    });

    it('does not fail the tick when the head cannot be resolved', async () => {
      // The repository observed fine. Failing the tick over it would take down
      // the reconciliation of every repository behind it in the sweep.
      withIssues([READY_ISSUE]);
      github.listCommits.mockRejectedValue(new Error('502 from GitHub'));

      const record = await build().tick();

      expect(record.outcome).toBe('completed');
      expect(record.failures).toEqual([]);
    });

    it('projects nothing for a repository with no commits yet', async () => {
      // A newly created repository is a real thing, not an error. There is
      // simply nothing to base work on.
      withIssues([READY_ISSUE]);
      github.listCommits.mockResolvedValue([]);

      const record = await build().tick();

      expect(workOrders.project).not.toHaveBeenCalled();
      expect(record.outcome).toBe('completed');
    });

    it('does not fail the tick when the projection itself throws', async () => {
      withIssues([READY_ISSUE]);
      workOrders.project.mockRejectedValue(new Error('database gone'));

      const record = await build().tick();

      expect(record.outcome).toBe('completed');
      expect(record.workOrdersCreated).toBe(0);
    });

    it('records zero on a tick that never swept', async () => {
      const record = await build({ 'reconciler.enabled': false }).tick();

      expect(record.workOrdersCreated).toBe(0);
      expect(record.rejections).toEqual([]);
    });
  });
});
