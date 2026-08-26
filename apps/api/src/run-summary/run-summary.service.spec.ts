import { GitHubWriteService } from '../github/write/github-write.service';
import { PrismaService } from '../prisma/prisma.service';
import { makeOperatorSettings } from '../settings/operator-settings/operator-settings.test-double';
import { DecisionLogService } from '../supervisor/decision-log/decision-log.service';
import { RunSummaryService } from './run-summary.service';

/**
 * The sweep that owes every concluded run a summary (#67).
 *
 * The interesting behaviour is not the happy path — it is what the sweep asks
 * for, where it posts when there is no pull request, and what it does when a
 * post fails.
 */
describe('RunSummaryService', () => {
  let findMany: jest.Mock;
  let update: jest.Mock;
  let postRunSummary: jest.Mock;
  let latestProposalFor: jest.Mock;
  let service: RunSummaryService;

  function run(overrides: Record<string, unknown> = {}) {
    return {
      id: 'run-uuid',
      status: 'succeeded',
      startedAt: new Date('2026-08-23T10:00:00Z'),
      endedAt: new Date('2026-08-23T10:10:00Z'),
      costUsd: 0.5,
      tokensInput: 100,
      tokensOutput: 20,
      attentionReason: null,
      pullRequestNumber: 42,
      runnerKey: 'claude-code-local',
      runner: { version: '2.1.223' },
      workOrder: {
        identity: 'wo_opifex_312_a3f91c2_a1',
        attempt: 1,
        issueNumber: 312,
        repository: { owner: 'acme', name: 'app' },
      },
      ...overrides,
    };
  }

  beforeEach(() => {
    findMany = jest.fn().mockResolvedValue([]);
    update = jest.fn().mockResolvedValue({});
    postRunSummary = jest
      .fn()
      .mockResolvedValue({ performed: true, noop: false });
    // No diagnosis by default. The summary must be complete without one —
    // #92's last criterion, and the case every other test here exercises.
    latestProposalFor = jest.fn().mockResolvedValue(null);

    service = new RunSummaryService(
      { run: { findMany, update } } as unknown as PrismaService,
      { postRunSummary } as unknown as GitHubWriteService,
      makeOperatorSettings({ overrides: { 'dispatch.retryCeiling': 3 } }),
      { latestProposalFor } as unknown as DecisionLogService,
    );
    jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
    jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
  });

  describe('what it asks for', () => {
    it('owes a summary only to concluded runs', async () => {
      // A live run would produce a summary that stops mid-sentence and could
      // never be corrected. The comment is a record, not a status board.
      await service.postOwed();

      const [{ where }] = findMany.mock.calls[0];
      expect(where.summaryPostedAt).toBeNull();
      expect(where.status).toEqual({
        in: ['succeeded', 'failed', 'quarantined'],
      });
    });

    it('takes the oldest first, so a backlog cannot starve one', async () => {
      await service.postOwed();

      const [{ orderBy, take }] = findMany.mock.calls[0];
      expect(orderBy).toEqual({ endedAt: 'asc' });
      expect(take).toBe(25);
    });
  });

  describe('where it posts', () => {
    it('posts to the pull request when there is one', async () => {
      findMany.mockResolvedValue([run()]);

      await service.postOwed();

      const [repo, target] = postRunSummary.mock.calls[0];
      expect(repo).toEqual({ owner: 'acme', name: 'app' });
      expect(target).toBe(42);
    });

    it('falls back to the issue when the run never opened one', async () => {
      // #67: "a run that fails before producing a PR still records its summary
      // as a comment on its issue". That run's story is the least
      // reconstructible later, so it can least afford nowhere to put it.
      findMany.mockResolvedValue([
        run({
          status: 'failed',
          pullRequestNumber: null,
          attentionReason: 'killed for silence',
        }),
      ]);

      await service.postOwed();

      expect(postRunSummary.mock.calls[0][1]).toBe(312);
      expect(postRunSummary.mock.calls[0][2]).toContain('killed for silence');
    });
  });

  describe('exactly one summary per run', () => {
    it('stamps the run so the next sweep does not owe it again', async () => {
      findMany.mockResolvedValue([run()]);

      await service.postOwed();

      const [{ where, data }] = update.mock.calls[0];
      expect(where).toEqual({ id: 'run-uuid' });
      expect(data.summaryPostedAt).toBeInstanceOf(Date);
    });

    it('stamps it even when writes are disabled and nothing was sent', async () => {
      // During the observation week no write reaches GitHub. A sweep that
      // retried forever would grow an unbounded backlog and re-log it every
      // pass; the row records that the summary was composed and offered.
      postRunSummary.mockResolvedValue({ performed: false, noop: true });
      findMany.mockResolvedValue([run()]);

      await service.postOwed();

      expect(update).toHaveBeenCalled();
    });

    it('leaves it owed when the post throws', async () => {
      postRunSummary.mockRejectedValue(new Error('GitHub is down'));
      findMany.mockResolvedValue([run()]);

      const result = await service.postOwed();

      expect(update).not.toHaveBeenCalled();
      expect(result).toEqual({ posted: 0, failed: 1 });
    });

    it('one failure does not stop the rest of the sweep', async () => {
      postRunSummary
        .mockRejectedValueOnce(new Error('GitHub is down'))
        .mockResolvedValue({ performed: true, noop: false });
      findMany.mockResolvedValue([run({ id: 'a' }), run({ id: 'b' })]);

      const result = await service.postOwed();

      expect(result).toEqual({ posted: 1, failed: 1 });
      expect(update).toHaveBeenCalledTimes(1);
    });
  });
});

describe('RunSummaryService — the supervisor diagnosis (#92)', () => {
  const OWED_RUN = {
    id: 'run-1',
    status: 'failed' as const,
    startedAt: new Date('2026-08-24T10:00:00.000Z'),
    endedAt: new Date('2026-08-24T10:30:00.000Z'),
    costUsd: null,
    tokensInput: null,
    tokensOutput: null,
    attentionReason: 'Killed after 40m of silence.',
    pullRequestNumber: 7,
    runnerKey: 'claude-code-local',
    runner: { version: '2.1.223' },
    workOrder: {
      identity: 'wo_opifex_312_a3f91c2_a1',
      attempt: 1,
      issueNumber: 312,
      repository: { owner: 'marinoscar', name: 'opifex' },
    },
  };

  function build(latestProposalFor: jest.Mock, retryCeiling = 3) {
    const findMany = jest.fn().mockResolvedValue([OWED_RUN]);
    const update = jest.fn().mockResolvedValue({});
    const postRunSummary = jest
      .fn()
      .mockResolvedValue({ performed: true, noop: false });

    const service = new RunSummaryService(
      { run: { findMany, update } } as unknown as PrismaService,
      { postRunSummary } as unknown as GitHubWriteService,
      makeOperatorSettings({
        overrides: { 'dispatch.retryCeiling': retryCeiling },
      }),
      { latestProposalFor } as unknown as DecisionLogService,
    );
    jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
    jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);

    return { service, postRunSummary, update };
  }

  it('asks the log for a diagnosis of that specific run', async () => {
    const latestProposalFor = jest.fn().mockResolvedValue(null);
    const { service } = build(latestProposalFor);

    await service.postOwed();

    expect(latestProposalFor).toHaveBeenCalledWith(
      'run',
      'run-1',
      'run-diagnosis',
    );
  });

  it('reports the attempt against the CONFIGURED retry ceiling', async () => {
    // The ceiling is an operator setting (`dispatch.retryCeiling`), and the
    // summary is where a human reads how much rope a work order has left. A
    // ceiling read from the wrong place would render "1 of 3" for every
    // deployment whatever it had configured, so this pins the number the
    // resolver supplied rather than a literal.
    const { service, postRunSummary } = build(
      jest.fn().mockResolvedValue(null),
      7,
    );

    await service.postOwed();

    expect(postRunSummary.mock.calls[0][2] as string).toContain('of 7');
  });

  it('includes the diagnosis, attributed as a hypothesis', async () => {
    const latestProposalFor = jest.fn().mockResolvedValue({
      id: 'prop-9',
      reasoning:
        'Supervisor hypothesis (not a determined cause):\n\nDisk full.',
    });
    const { service, postRunSummary } = build(latestProposalFor);

    await service.postOwed();

    const body = postRunSummary.mock.calls[0][2] as string;
    expect(body).toContain('Supervisor hypothesis — not a determined cause');
    expect(body).toContain('Disk full.');
    expect(body).toContain('proposal=prop-9');
  });

  it('posts the summary anyway when the decision log is unreachable', async () => {
    // #92: "absent or failed diagnosis leaves the run summary otherwise
    // intact." Losing the hypothesis must not lose the record.
    const latestProposalFor = jest
      .fn()
      .mockRejectedValue(new Error('database is down'));
    const { service, postRunSummary, update } = build(latestProposalFor);

    await expect(service.postOwed()).resolves.toEqual({ posted: 1, failed: 0 });

    const body = postRunSummary.mock.calls[0][2] as string;
    expect(body).toContain('Killed after 40m of silence.');
    expect(body).not.toContain('Supervisor hypothesis');
    expect(update).toHaveBeenCalled();
  });

  it('posts an unchanged summary when no diagnosis exists', async () => {
    const { service, postRunSummary } = build(
      jest.fn().mockResolvedValue(null),
    );

    await service.postOwed();

    const body = postRunSummary.mock.calls[0][2] as string;
    expect(body).not.toContain('Supervisor hypothesis');
    expect(body).toContain('**Why it stopped** | Killed after 40m of silence.');
  });
});
