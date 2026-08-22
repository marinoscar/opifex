import { GitHubReadService } from '../github/read/github-read.service';
import { PrismaService } from '../prisma/prisma.service';
import { FactoryMetrics } from '../telemetry/factory-metrics.service';
import { GitLivenessService } from './git-liveness.service';

const BASE = 'a3f91c2000000000000000000000000000000000';

function runRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '018f2c31-7a4e-7c3b-9f21-4d5e6a7b8c9d',
    startedAt: new Date('2026-08-21T10:00:00Z'),
    headCommit: null,
    pullRequestUrl: null,
    workOrder: {
      identity: 'wo_opifex_312_a3f91c2_a1',
      branch: 'factory/312-a3f91c2-a1',
      baseCommit: BASE,
      repository: { owner: 'marinoscar', name: 'opifex' },
    },
    events: [],
    ...overrides,
  };
}

function ghCommit(sha: string, at: string) {
  return { sha, message: 'feat: work', author: 'x', authoredAt: new Date(at), url: 'u' };
}

describe('GitLivenessService', () => {
  let prisma: {
    run: { findMany: jest.Mock; update: jest.Mock };
    runEvent: { createMany: jest.Mock };
  };
  let github: {
    listCommits: jest.Mock;
    listPullRequests: jest.Mock;
    listChecks: jest.Mock;
  };
  let service: GitLivenessService;

  beforeEach(() => {
    prisma = {
      run: { findMany: jest.fn().mockResolvedValue([runRow()]), update: jest.fn().mockResolvedValue({}) },
      runEvent: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    github = {
      listCommits: jest.fn().mockResolvedValue([]),
      listPullRequests: jest.fn().mockResolvedValue([]),
      listChecks: jest.fn().mockResolvedValue([]),
    };
    service = new GitLivenessService(
      prisma as unknown as PrismaService,
      github as unknown as GitHubReadService,
      // The real one: with no OpenTelemetry SDK registered the API hands back
      // noop instruments, so this exercises the actual call and the span ids
      // it returns rather than a stub's.
      new FactoryMetrics(),
    );
  });

  describe('which runs it watches', () => {
    it('watches only live runs', async () => {
      await service.sweep();

      const [{ where }] = prisma.run.findMany.mock.calls[0];
      expect(where).toEqual({ status: { in: ['running', 'stalled', 'blocked'] } });
    });

    it('includes stalled runs, because a commit is evidence the watchdog was wrong', async () => {
      const [{ where }] = (await service.sweep(), prisma.run.findMany.mock.calls[0]);

      expect(where.status.in).toContain('stalled');
    });

    it('compares against RUNNER-reported events only', async () => {
      // Comparing git against itself would report no disagreement no matter
      // what the runner did.
      await service.sweep();

      const [{ select }] = prisma.run.findMany.mock.calls[0];
      expect(select.events.where).toEqual({ source: 'runner' });
    });
  });

  describe('idempotency', () => {
    it('writes with skipDuplicates rather than reading first', async () => {
      // A read-then-write could interleave between two ticks. The unique
      // constraint on (runId, externalId) is where this belongs.
      github.listCommits.mockResolvedValue([ghCommit('7c1d9ab', '2026-08-21T10:14:00Z')]);

      await service.sweep();

      const [{ skipDuplicates }] = prisma.runEvent.createMany.mock.calls[0];
      expect(skipDuplicates).toBe(true);
    });

    it('counts an already-known event separately from a new one', async () => {
      // The watcher re-derives the same commit every tick; a conflict is the
      // expected outcome, not an error.
      github.listCommits.mockResolvedValue([ghCommit('7c1d9ab', '2026-08-21T10:14:00Z')]);
      prisma.runEvent.createMany.mockResolvedValue({ count: 0 });

      const result = await service.sweep();

      expect(result).toMatchObject({ eventsRecorded: 0, eventsAlreadyKnown: 1 });
    });

    it('stores the sender-chosen id as externalId', async () => {
      github.listCommits.mockResolvedValue([ghCommit('7c1d9ab', '2026-08-21T10:14:00Z')]);

      await service.sweep();

      const [{ data }] = prisma.runEvent.createMany.mock.calls[0];
      expect(data[0].externalId).toContain('7c1d9ab');
    });

    it('records the event as git-derived, not runner-reported', async () => {
      github.listCommits.mockResolvedValue([ghCommit('7c1d9ab', '2026-08-21T10:14:00Z')]);

      await service.sweep();

      const [{ data }] = prisma.runEvent.createMany.mock.calls[0];
      expect(data[0].source).toBe('git');
    });
  });

  describe('disagreements are surfaced, never reconciled', () => {
    it('notices git ahead of a lagging runner', async () => {
      // The evidence #52 exists to produce. If the two sources never
      // disagreed, one of them would be redundant.
      prisma.run.findMany.mockResolvedValue([
        runRow({ events: [{ occurredAt: new Date('2026-08-21T10:00:00Z') }] }),
      ]);
      github.listCommits.mockResolvedValue([ghCommit('7c1d9ab', '2026-08-21T11:00:00Z')]);

      const result = await service.sweep();

      expect(result.disagreements[0]).toMatchObject({ kind: 'git-ahead-of-runner' });
      expect(result.disagreements[0].detail).toContain('60 minutes behind');
    });

    it('notices a runner reporting progress git cannot see', async () => {
      prisma.run.findMany.mockResolvedValue([
        runRow({ events: [{ occurredAt: new Date() }] }),
      ]);

      const result = await service.sweep();

      expect(result.disagreements[0]).toMatchObject({ kind: 'runner-ahead-of-git' });
    });

    it('notices a pull request from a runner that never reported at all', async () => {
      github.listPullRequests.mockResolvedValue([
        {
          number: 318,
          url: 'https://github.com/marinoscar/opifex/pull/318',
          state: 'open',
          merged: false,
          headSha: '7c1d9ab',
          updatedAt: new Date('2026-08-21T10:52:00Z'),
          title: 't',
          body: null,
          draft: false,
          headRef: 'factory/312-a3f91c2-a1',
          baseRef: 'main',
          author: 'x',
          createdAt: new Date(),
          mergedAt: null,
        },
      ]);

      const result = await service.sweep();

      expect(result.disagreements[0]).toMatchObject({ kind: 'git-completed-runner-silent' });
    });

    it('reports NO disagreement when both sources agree', async () => {
      prisma.run.findMany.mockResolvedValue([
        runRow({ events: [{ occurredAt: new Date('2026-08-21T10:59:00Z') }] }),
      ]);
      github.listCommits.mockResolvedValue([ghCommit('7c1d9ab', '2026-08-21T11:00:00Z')]);

      expect((await service.sweep()).disagreements).toEqual([]);
    });

    it('does not reconcile — it only records', async () => {
      // Nothing here decides who is right. #54 does that, using the runner's
      // declared capabilities.
      prisma.run.findMany.mockResolvedValue([
        runRow({ events: [{ occurredAt: new Date('2026-08-21T10:00:00Z') }] }),
      ]);
      github.listCommits.mockResolvedValue([ghCommit('7c1d9ab', '2026-08-21T11:00:00Z')]);

      const result = await service.sweep();

      expect(result.disagreements).toHaveLength(1);
      // No status change, no kill, no correction.
      const [{ data }] = prisma.run.update.mock.calls[0];
      expect(data).not.toHaveProperty('status');
    });
  });

  describe('updating the run', () => {
    it('records the head commit it observed', async () => {
      github.listCommits.mockResolvedValue([ghCommit('7c1d9ab', '2026-08-21T10:14:00Z')]);

      await service.sweep();

      const [{ data }] = prisma.run.update.mock.calls[0];
      expect(data.headCommit).toBe('7c1d9ab');
    });

    it('never moves lastEventAt BACKWARDS', async () => {
      // Letting an older git observation overwrite a newer runner event would
      // make a live run look stale — manufacturing the silence #54 watches for.
      github.listCommits.mockResolvedValue([
        ghCommit('old1111', '2026-08-21T09:00:00Z'), // before startedAt
      ]);

      await service.sweep();

      const [{ data }] = prisma.run.update.mock.calls[0];
      expect(data.lastEventAt).toBeUndefined();
    });

    it('records a newly discovered pull request', async () => {
      github.listPullRequests.mockResolvedValue([
        {
          number: 318,
          url: 'https://github.com/marinoscar/opifex/pull/318',
          state: 'open',
          merged: false,
          headSha: '7c1d9ab',
          updatedAt: new Date('2026-08-21T10:52:00Z'),
          title: 't',
          body: null,
          draft: false,
          headRef: 'x',
          baseRef: 'main',
          author: 'x',
          createdAt: new Date(),
          mergedAt: null,
        },
      ]);

      await service.sweep();

      const [{ data }] = prisma.run.update.mock.calls[0];
      expect(data).toMatchObject({ pullRequestNumber: 318 });
    });
  });

  describe('budget', () => {
    it('does not ask for checks when there is no head commit', async () => {
      // Asking about a commit that does not exist spends a request to be told
      // nothing.
      await service.sweep();

      expect(github.listChecks).not.toHaveBeenCalled();
    });

    it('asks for checks once a head exists', async () => {
      github.listCommits.mockResolvedValue([ghCommit('7c1d9ab', '2026-08-21T10:14:00Z')]);

      await service.sweep();

      expect(github.listChecks).toHaveBeenCalledWith(
        { owner: 'marinoscar', name: 'opifex' },
        '7c1d9ab',
      );
    });
  });

  describe('failure handling', () => {
    it('records a failure and keeps sweeping', async () => {
      prisma.run.findMany.mockResolvedValue([
        runRow({ id: 'a', workOrder: { ...runRow().workOrder, identity: 'wo_a' } }),
        runRow({ id: 'b', workOrder: { ...runRow().workOrder, identity: 'wo_b' } }),
      ]);
      github.listCommits
        .mockRejectedValueOnce(new Error('GitHub is down'))
        .mockResolvedValue([]);

      const result = await service.sweep();

      expect(result.failures).toEqual([{ run: 'wo_a', reason: 'GitHub is down' }]);
      expect(result.runsWatched).toBe(2);
    });
  });
  describe('correlation with the work order trace (#59)', () => {
    it('records the ids of the span it emitted, and nulls when it emitted none', async () => {
      // No OpenTelemetry SDK is registered here, so no span is exported and
      // the columns are null. Storing the noop span's inherited ids instead
      // would link the run detail to a trace with nothing in it.
      github.listCommits.mockResolvedValue([ghCommit('c1', '2026-08-21T10:05:00Z')]);

      await service.sweep();

      const [{ data }] = prisma.runEvent.createMany.mock.calls[0];
      expect(data[0]).toMatchObject({ traceId: null, spanId: null });
    });
  });
});
