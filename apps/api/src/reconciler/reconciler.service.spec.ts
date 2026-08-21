import { ConfigService } from '@nestjs/config';

import { GitHubHttpService } from '../github/github-http.service';
import { GitHubNotFoundError, GitHubRateLimitError } from '../github/github.errors';
import { RateLimitService } from '../github/rate-limit.service';
import { GitHubReadService } from '../github/read/github-read.service';
import { PrismaService } from '../prisma/prisma.service';
import { RepositoriesService } from '../repositories/repositories.service';
import { ReconcilerService } from './reconciler.service';
import { TickLeaseService } from './tick-lease.service';

function repository(overrides: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    owner: 'acme',
    name: 'app',
    lastObservedAt: null,
    ...overrides,
  };
}

describe('ReconcilerService', () => {
  let lease: { withLease: jest.Mock };
  let repositories: { listObserved: jest.Mock };
  let github: { listIssues: jest.Mock };
  let http: { canSpend: jest.Mock };
  let rateLimit: RateLimitService;
  let prisma: { repository: { update: jest.Mock } };

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
    };
    http = { canSpend: jest.fn().mockReturnValue(true) };
    rateLimit = new RateLimitService();
    prisma = { repository: { update: jest.fn().mockResolvedValue({}) } };
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
});
