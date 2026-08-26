import { GitHubHttpService } from '../github/github-http.service';
import { RateLimitService } from '../github/rate-limit.service';
import { GitHubReadService } from '../github/read/github-read.service';
import { GitHubWriteService } from '../github/write/github-write.service';
import { PrismaService } from '../prisma/prisma.service';
import { RepositoriesService } from '../repositories/repositories.service';
import { RunSummaryService } from '../run-summary/run-summary.service';
import { makeOperatorSettings } from '../settings/operator-settings/operator-settings.test-double';
import type { FakeOperatorSettingsService } from '../settings/operator-settings/operator-settings.test-double';
import { DecisionLogService } from '../supervisor/decision-log/decision-log.service';
import { WorkOrderProjectionService } from '../work-orders/work-order-projection.service';
import { ReconcileLogService } from './log/reconcile-log.service';
import { ReconcilerService } from './reconciler.service';
import { TickLeaseService } from './tick-lease.service';

/**
 * `dispatch.retryCeiling`, read by two components that must not disagree.
 *
 * The reconciler enforces the ceiling — a work order that has used every
 * attempt is quarantined rather than retried forever (#66). `RunSummaryService`
 * RENDERS it: "Attempt 2 of 3" is how a human learns how much rope is left.
 * They are the statement and the enforcement of one policy, so a gap between
 * them is not a cosmetic bug; it tells an operator a work order has an attempt
 * remaining that the reconciler has already decided it does not.
 *
 * They could not drift while `retryCeiling` came from `ConfigService`, because
 * nothing could move it underneath a running process — the reconciler's
 * constructor-time read and the summary's per-call read returned the same
 * number for the life of the process by accident of there being no write path.
 * ADR-0018 removes that accident: a managed key can be edited at runtime, and
 * from then on the two agree only because of how each is SCOPED. The summary
 * reads per post; the reconciler now reads per tick. This is the spec that
 * fails if either changes.
 */
describe('the retry ceiling, as the reconciler and the run summary see it', () => {
  const READY_ISSUE = {
    number: 312,
    title: 'Add a permit search prompt builder',
    body: 'anything',
    state: 'open' as const,
    author: 'marinoscar',
    labels: [],
    inputLabels: ['factory:ready'],
    unknownInputLabels: [],
    ignoredLabels: [],
    observedMirrorLabels: [],
  };

  /** Two attempts spent, no live run: one below a ceiling of three. */
  const WORK_ORDER = {
    id: 'wo-uuid',
    identity: 'wo_app_312_a3f91c2_a1',
    issueNumber: 312,
    attempt: 2,
    status: 'failed',
    runs: [],
  };

  const OWED_RUN = {
    id: 'run-uuid',
    status: 'failed' as const,
    startedAt: new Date('2026-08-26T10:00:00.000Z'),
    endedAt: new Date('2026-08-26T10:30:00.000Z'),
    costUsd: null,
    tokensInput: null,
    tokensOutput: null,
    attentionReason: 'Killed after 40m of silence.',
    pullRequestNumber: 7,
    runnerKey: 'claude-code-local',
    runner: { version: '2.1.223' },
    workOrder: {
      identity: 'wo_app_312_a3f91c2_a1',
      attempt: 2,
      issueNumber: 312,
      repository: { owner: 'acme', name: 'app' },
    },
  };

  function reconciler(settings: FakeOperatorSettingsService) {
    return new ReconcilerService(
      settings,
      {
        withLease: jest.fn(async (work: () => Promise<unknown>) => ({
          acquired: true,
          result: await work(),
        })),
      } as unknown as TickLeaseService,
      {
        listObserved: jest.fn().mockResolvedValue([
          {
            id: 'repo-uuid',
            owner: 'acme',
            name: 'app',
            defaultBranch: 'main',
            observeEnabled: true,
            dispatchEnabled: true,
            budgetCeilingUsd: null,
            wallClockTimeoutMinutes: null,
            specFeedbackEnabled: false,
          },
        ]),
      } as unknown as RepositoriesService,
      {
        listIssues: jest.fn().mockResolvedValue({
          issues: [READY_ISSUE],
          truncated: false,
          allFromCache: false,
        }),
        listCommits: jest.fn().mockResolvedValue([{ sha: 'a'.repeat(40) }]),
      } as unknown as GitHubReadService,
      {
        canSpend: jest.fn().mockReturnValue(true),
      } as unknown as GitHubHttpService,
      new RateLimitService(),
      {
        repository: { update: jest.fn().mockResolvedValue({}) },
        workOrder: { findMany: jest.fn().mockResolvedValue([WORK_ORDER]) },
      } as unknown as PrismaService,
      {
        record: jest.fn().mockResolvedValue(null),
      } as unknown as ReconcileLogService,
      {
        project: jest.fn().mockResolvedValue({
          created: [],
          heldOnCreate: 0,
          alreadyPresent: 0,
          holdsApplied: 0,
          holdsLifted: 0,
          rejected: [],
          skipped: {},
        }),
      } as unknown as WorkOrderProjectionService,
    );
  }

  function runSummary(settings: FakeOperatorSettingsService) {
    const postRunSummary = jest
      .fn()
      .mockResolvedValue({ performed: true, noop: false });
    const service = new RunSummaryService(
      {
        run: {
          findMany: jest.fn().mockResolvedValue([OWED_RUN]),
          update: jest.fn().mockResolvedValue({}),
        },
      } as unknown as PrismaService,
      { postRunSummary } as unknown as GitHubWriteService,
      settings,
      {
        latestProposalFor: jest.fn().mockResolvedValue(null),
      } as unknown as DecisionLogService,
    );
    jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
    jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);

    return { service, postRunSummary };
  }

  function settingsWith(retryCeiling: number): FakeOperatorSettingsService {
    return makeOperatorSettings({
      overrides: {
        'reconciler.enabled': true,
        'github.rateLimitReserve': 100,
        'dispatch.retryCeiling': retryCeiling,
      },
    });
  }

  it('agrees on a ceiling set before either was built', async () => {
    // Five, not the registry's default of three: a reader hard-coded to the
    // default would satisfy this test while agreeing with nothing.
    const settings = settingsWith(5);
    const { service, postRunSummary } = runSummary(settings);

    const tick = await reconciler(settings).tick();
    await service.postOwed();

    expect(tick.settings.retryCeiling).toBe(5);
    expect(String(postRunSummary.mock.calls[0][2])).toContain('2 of 5');
  });

  it('agrees on a ceiling raised after both were built', async () => {
    // The case the old code got wrong. A reconciler whose ceiling was read in
    // its constructor would still be enforcing 3 here while the summary
    // rendered "2 of 7" — the work order quarantined on the very attempt the
    // human had just been told it had left.
    const settings = settingsWith(3);
    const reconcile = reconciler(settings);
    const { service, postRunSummary } = runSummary(settings);

    settings.setOverride('dispatch.retryCeiling', 7);

    const tick = await reconcile.tick();
    await service.postOwed();

    expect(tick.settings.retryCeiling).toBe(7);
    expect(String(postRunSummary.mock.calls[0][2])).toContain('2 of 7');
  });

  it('quarantines on exactly the attempt the summary says is the last', async () => {
    // The agreement that matters is not that the two print the same number —
    // it is that the number DECIDES the same thing. The summary saying "2 of 2"
    // and the reconciler quarantining are the same fact told twice.
    const settings = settingsWith(9);
    const reconcile = reconciler(settings);
    const { service, postRunSummary } = runSummary(settings);

    settings.setOverride('dispatch.retryCeiling', 2);

    const tick = await reconcile.tick();
    await service.postOwed();

    expect(String(postRunSummary.mock.calls[0][2])).toContain('2 of 2');
    expect(tick.projections[0].issues[0].intent).toBe('quarantined');
    expect(tick.projections[0].issues[0].reason).toContain('all 2 attempts');
  });
});
