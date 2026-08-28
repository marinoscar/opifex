import { Logger } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';

import { DeadTimeService } from '../../src/dead-time/dead-time.service';
import { DispatchQueueService } from '../../src/dispatch/dispatch-queue.service';
import { EscalationsService } from '../../src/escalations/escalations.service';
import { GitHubHttpService } from '../../src/github/github-http.service';
import { GitHubWriteService } from '../../src/github/write/github-write.service';
import { GitLivenessService } from '../../src/liveness/git-liveness.service';
import { EscalationDispatcher } from '../../src/notifications/escalation-dispatcher.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { MirrorLabelExecutor } from '../../src/reconciler/execute/mirror-label.executor';
import { SpecFeedbackExecutor } from '../../src/reconciler/execute/spec-feedback.executor';
import { ReconcileLogService } from '../../src/reconciler/log/reconcile-log.service';
import { ReconcilerService } from '../../src/reconciler/reconciler.service';
import { ReconcilerTask } from '../../src/reconciler/reconciler.task';
import type { ReconcileAction } from '../../src/reconciler/diff/actions.types';
import type { TickRecord } from '../../src/reconciler/reconciler.types';
import { RepositoriesService } from '../../src/repositories/repositories.service';
import { makeOperatorSettings } from '../../src/settings/operator-settings/operator-settings.test-double';
import { WatchdogService } from '../../src/watchdog/watchdog.service';

/**
 * #317, at the level nothing else covers: a REAL `PrismaService` against
 * `opifex_test`, a REAL `GitHubWriteService`, and a REAL `ReconcileLogService`
 * wired through `ReconcilerTask.runOnce`. Only the two collaborators that
 * would otherwise reach a live GitHub or a full reconciler tick — the HTTP
 * layer under the write service, and `ReconcilerService.tick` itself — are
 * doubled.
 *
 * The bug this closes was a value that looked right at the unit level and
 * meant nothing: `actionsExecuted` was a literal `0`, so the runbook's daily
 * check — "it must be 0 on every tick, all week" — could never fail, because
 * nothing was ever checkABLE against a real row. Asserting against a mocked
 * Prisma here would repeat exactly that mistake one layer further down, so
 * this file talks to Postgres.
 *
 * Requires the test database from `infra/compose/test.compose.yml`
 * (`opifex_test`, host port 5433) reachable via `DATABASE_URL` /
 * `POSTGRES_*`. Skips itself, loudly, when it is not.
 */

const REPO = { owner: 'acme', name: 'app', mirrorLabelsEnabled: true };

function tickRecord(overrides: Partial<TickRecord> = {}): TickRecord {
  const now = new Date();
  return {
    startedAt: now,
    finishedAt: now,
    durationMs: 5,
    outcome: 'completed',
    repositoriesObserved: 1,
    failures: [],
    allFromCache: false,
    rateLimitRemaining: 4999,
    settings: { retryCeiling: 3, rateLimitReserve: 100, writesEnabled: false },
    projections: [],
    workOrdersCreated: 0,
    rejections: [],
    actions: [],
    ...overrides,
  };
}

/** A minimal, valid `add-mirror-label` action — the shape the executor reads. */
function addLabelAction(label: string): ReconcileAction {
  return {
    type: 'add-mirror-label',
    repository: `${REPO.owner}/${REPO.name}`,
    issueNumber: 312,
    label,
    reason: `mirror label ${label} should be present`,
    evidence: {
      intent: 'dispatch',
      inputLabels: ['factory:ready'],
      workOrderIdentity: null,
      runStatus: null,
      currentMirrorLabels: [],
      desiredMirrorLabels: [label],
    },
  } as unknown as ReconcileAction;
}

function httpMock() {
  return {
    request: jest.fn().mockResolvedValue({ data: {} }),
  } as unknown as jest.Mocked<Pick<GitHubHttpService, 'request'>>;
}

function writeSettings(writesEnabled: boolean) {
  return makeOperatorSettings({
    overrides: { 'github.writesEnabled': writesEnabled },
  });
}

/** Every non-write collaborator `ReconcilerTask` needs, stubbed to no-ops. */
function noopCollaborators() {
  return {
    liveness: {
      sweep: jest.fn().mockResolvedValue({
        runsWatched: 0,
        eventsRecorded: 0,
        disagreements: [],
      }),
    } as unknown as GitLivenessService,
    watchdog: {
      sweep: jest.fn().mockResolvedValue({
        runsJudged: 0,
        judgedRunIds: [],
        actions: [],
        silentRuns: 0,
        loopingRuns: 0,
        loopCheckUnavailable: 0,
        parkedRuns: 0,
        resumableRuns: 0,
        deadObservations: [],
      }),
    } as unknown as WatchdogService,
    deadTime: {
      record: jest.fn().mockResolvedValue({
        opened: 0,
        resumed: 0,
        concluded: 0,
        quarantined: 0,
        open: 0,
      }),
    } as unknown as DeadTimeService,
    escalations: {
      raiseFrom: jest.fn().mockResolvedValue({ raised: 0, deduplicated: 0 }),
      resolveStale: jest.fn().mockResolvedValue(0),
    } as unknown as EscalationsService,
    dispatcher: {
      dispatchPending: jest.fn().mockResolvedValue({
        dispatched: 0,
        rerouted: 0,
        retried: 0,
        failed: 0,
        timedOut: 0,
        abandoned: 0,
      }),
    } as unknown as EscalationDispatcher,
    specFeedback: {
      report: jest.fn().mockResolvedValue({
        posted: 0,
        alreadyTold: 0,
        suppressed: 0,
        failures: [],
      }),
    } as unknown as SpecFeedbackExecutor,
    dispatchQueue: {
      drain: jest.fn().mockResolvedValue({
        dispatched: 0,
        stillQueued: 0,
        observed: 0,
        failed: 0,
        unrebuildable: 0,
        repositoriesDisabled: 0,
      }),
    } as unknown as DispatchQueueService,
    repositories: {
      listObserved: jest.fn().mockResolvedValue([REPO]),
    } as unknown as RepositoriesService,
  };
}

function databaseReachable(): boolean {
  return Boolean(process.env.DATABASE_URL || process.env.POSTGRES_HOST);
}

const describeIfDb = databaseReachable() ? describe : describe.skip;

if (!databaseReachable()) {
  console.warn(
    'Skipping reconciler-actions-executed.integration.spec.ts: no DATABASE_URL/POSTGRES_HOST ' +
      'in the environment. Point it at opifex_test (infra/compose/test.compose.yml) to run it.',
  );
}

describeIfDb('actionsExecuted, persisted to a real database (#317)', () => {
  let prisma: PrismaService;
  let createdIds: string[];

  beforeAll(() => {
    prisma = new PrismaService();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(() => {
    createdIds = [];
  });

  afterEach(async () => {
    if (createdIds.length > 0) {
      await prisma.reconcileTick.deleteMany({
        where: { id: { in: createdIds } },
      });
    }
  });

  /** Wraps `ReconcileLogService.record` so every row this file writes is tracked for cleanup. */
  function trackingLog(log: ReconcileLogService): ReconcileLogService {
    const originalRecord = log.record.bind(log);
    (log as unknown as { record: typeof log.record }).record = async (
      record: TickRecord,
    ) => {
      const id = await originalRecord(record);
      if (id) createdIds.push(id);
      return id;
    };
    return log;
  }

  function buildTask(options: { writesEnabled: boolean; tick: jest.Mock }): {
    task: ReconcilerTask;
    writes: GitHubWriteService;
    log: ReconcileLogService;
  } {
    const http = httpMock();
    const writes = new GitHubWriteService(
      http as unknown as GitHubHttpService,
      writeSettings(options.writesEnabled),
    );
    const log = trackingLog(new ReconcileLogService(prisma));
    const executor = new MirrorLabelExecutor(writes);
    const collaborators = noopCollaborators();

    const task = new ReconcilerTask(
      // ON, explicitly. `runOnce` gates the whole loop on this, so a task that
      // resolved it from the registry proves whatever the default happens to
      // be — and did: while `reconciler.enabled` defaulted off (before
      // ADR-0019, #439) every test in this file asserted against a tick that
      // returned at the gate, and the file stayed green only because it is
      // skipped wherever no database is configured. It is a spec about
      // actionsExecuted accounting, not about the default.
      makeOperatorSettings({ overrides: { 'reconciler.enabled': true } }),
      {
        addInterval: jest.fn(),
        doesExist: jest.fn(),
        deleteInterval: jest.fn(),
      } as unknown as SchedulerRegistry,
      { tick: options.tick } as unknown as ReconcilerService,
      executor,
      collaborators.specFeedback,
      collaborators.dispatchQueue,
      collaborators.repositories,
      collaborators.liveness,
      collaborators.watchdog,
      collaborators.deadTime,
      collaborators.escalations,
      collaborators.dispatcher,
      writes,
      log,
    );

    return { task, writes, log };
  }

  const run = (task: ReconcilerTask) =>
    (task as unknown as { runOnce(): Promise<void> }).runOnce();

  /**
   * Case 1 — the runbook rule as an executable check, and the load-bearing
   * proof for this pass.
   *
   * With `GITHUB_WRITES_ENABLED=false`, several real ticks — each computing a
   * mirror-label action against a repository that HAS opted in to mirror
   * labels — must each leave `actionsExecuted: 0` on its own row in Postgres.
   * Until this exists, "we were read-only" was checkable only against the
   * literal in `ReconcileLogService.record`, which is exactly what #317 was.
   */
  it('persists actionsExecuted: 0 across several real ticks with writes off', async () => {
    const tick = jest.fn();
    const { task, writes, log } = buildTask({ writesEnabled: false, tick });
    tick.mockImplementation(async () => {
      const record = tickRecord({
        actions: [addLabelAction('factory/dispatched')],
      });
      const id = await log.record(record);
      return { ...record, id: id ?? undefined };
    });

    for (let i = 0; i < 3; i += 1) {
      await run(task);
    }

    expect(writes.writesIssued).toBe(0);
    expect(createdIds).toHaveLength(3);

    const rows = await prisma.reconcileTick.findMany({
      where: { id: { in: createdIds } },
    });
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.actionsExecuted).toBe(0);
    }
  });

  /**
   * Case 2 — the other half. Writes on, plus `mirrorLabelsEnabled`: the row's
   * `actionsExecuted` must match the labels actually written, or the fix has
   * only traded a stuck zero for a stuck zero with more code.
   */
  it('persists actionsExecuted matching the labels actually written, writes on', async () => {
    let capturedId: string | undefined;
    const tick = jest.fn();
    const { task, writes, log } = buildTask({ writesEnabled: true, tick });
    tick.mockImplementation(async () => {
      const record = tickRecord({
        actions: [
          addLabelAction('factory/dispatched'),
          addLabelAction('factory/blocked'),
        ],
      });
      const id = await log.record(record);
      capturedId = id ?? undefined;
      return { ...record, id: capturedId };
    });

    await run(task);

    expect(writes.writesIssued).toBe(2);
    expect(capturedId).toBeDefined();

    const row = await prisma.reconcileTick.findUniqueOrThrow({
      where: { id: capturedId! },
    });
    expect(row.actionsExecuted).toBe(2);
  });

  /**
   * Case 3 — the documented, accepted imprecision. `setInterval` in
   * `ReconcilerTask.onModuleInit` is not awaited, and the tick lease only
   * guards `ReconcilerService.observeAll`, so two overlapping `runOnce`
   * invocations against the same `GitHubWriteService` singleton are possible
   * in production. A write made by tick B while tick A is still in flight
   * gets attributed to BOTH: this is meant to over-count, and must never
   * under-count, because the number exists to catch a window that was
   * supposed to be read-only.
   */
  it('double-attributes a concurrent write to both overlapping ticks — over, never under', async () => {
    let releaseA: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    const http = httpMock();
    const writes = new GitHubWriteService(
      http as unknown as GitHubHttpService,
      writeSettings(true),
    );
    const log = trackingLog(new ReconcileLogService(prisma));
    const executor = new MirrorLabelExecutor(writes);
    const collaborators = noopCollaborators();

    const tick = jest.fn();
    // Tick A: gated. It does not resolve until B has already completed and
    // issued its own write, so A's delta is computed AFTER B's write landed.
    tick.mockImplementationOnce(async () => {
      await gate;
      const record = tickRecord({
        actions: [addLabelAction('factory/tick-a')],
      });
      const id = await log.record(record);
      return { ...record, id: id ?? undefined };
    });
    // Tick B: resolves immediately.
    tick.mockImplementationOnce(async () => {
      const record = tickRecord({
        actions: [addLabelAction('factory/tick-b')],
      });
      const id = await log.record(record);
      return { ...record, id: id ?? undefined };
    });

    const task = new ReconcilerTask(
      // ON, explicitly — see the first `buildTask` above.
      makeOperatorSettings({ overrides: { 'reconciler.enabled': true } }),
      {
        addInterval: jest.fn(),
        doesExist: jest.fn(),
        deleteInterval: jest.fn(),
      } as unknown as SchedulerRegistry,
      { tick } as unknown as ReconcilerService,
      executor,
      collaborators.specFeedback,
      collaborators.dispatchQueue,
      collaborators.repositories,
      collaborators.liveness,
      collaborators.watchdog,
      collaborators.deadTime,
      collaborators.escalations,
      collaborators.dispatcher,
      writes,
      log,
    );

    // Start A. It captures writesBefore == 0 and then blocks inside
    // reconciler.tick() at `await gate`.
    const pA = run(task);
    // Give A's promise chain room to actually reach the gate before B starts.
    await new Promise((resolve) => setImmediate(resolve));

    // B runs to completion, unblocked: writesIssued goes 0 -> 1.
    const pB = run(task);
    await pB;
    expect(writes.writesIssued).toBe(1);

    // Release A. It now issues its own write (1 -> 2) and computes its delta
    // against the writesBefore it captured at the very start (0), so its
    // recorded figure includes B's write too.
    releaseA();
    await pA;

    expect(writes.writesIssued).toBe(2);
    expect(createdIds).toHaveLength(2);

    const rows = await prisma.reconcileTick.findMany({
      where: { id: { in: createdIds } },
      orderBy: { startedAt: 'asc' },
    });
    const byActions = (needle: string) =>
      rows.find((r) => JSON.stringify(r.actions).includes(needle));
    const rowB = byActions('factory/tick-b')!;
    const rowA = byActions('factory/tick-a')!;

    // B is attributed exactly what it did.
    expect(rowB.actionsExecuted).toBe(1);
    // A is attributed its own write PLUS the one B made while A was in
    // flight — over-counted, not exactly right.
    expect(rowA.actionsExecuted).toBe(2);

    // The documented bias: the sum of what was recorded (3) exceeds the
    // number of writes that actually left the process (2). Never the other
    // way around — neither row is credited with fewer writes than it made.
    const recordedTotal = rowA.actionsExecuted + rowB.actionsExecuted;
    expect(recordedTotal).toBeGreaterThan(writes.writesIssued);
    expect(rowB.actionsExecuted).toBeGreaterThanOrEqual(1);
    expect(rowA.actionsExecuted).toBeGreaterThanOrEqual(1);
  });

  /**
   * Case 4 — `log.record()` failed, so the tick has no row to stamp a count
   * onto (`record.id` is `undefined`), but writes were still issued. The task
   * must log this as an under-report by name, and the tick must still
   * complete — a logging gap must not become a second failure on top of the
   * first.
   */
  it('logs an under-report and still completes when the tick has no log row', async () => {
    const errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);

    const tick = jest.fn().mockResolvedValue(
      tickRecord({
        id: undefined,
        actions: [addLabelAction('factory/dispatched')],
      }),
    );

    const { task, writes, log } = buildTask({ writesEnabled: true, tick });
    const recordExecutionSpy = jest.spyOn(log, 'recordExecution');

    await expect(run(task)).resolves.toBeUndefined();

    expect(writes.writesIssued).toBe(1);
    // Never called: there is no row id to call it with.
    expect(recordExecutionSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/no log row.*understates this tick/),
    );

    errorSpy.mockRestore();
  });

  /**
   * Case 5 (#320) — the point of the issue, proven against a real row: a
   * mirror-label write that throws must leave `actions_executed` non-zero
   * (the request was still handed to the HTTP layer — see
   * `GitHubWriteService.guardedWrite`) AND `execution_failures` populated
   * with what went wrong. Before this fix, the second half did not exist:
   * `actionsExecuted` could say "3" with the failure recorded nowhere a
   * database query could find it.
   */
  it('populates execution_failures alongside a non-zero actionsExecuted when a mirror-label write throws', async () => {
    let capturedId: string | undefined;
    const tick = jest.fn();
    const http = {
      request: jest.fn().mockRejectedValue(new Error('GitHub said 500')),
    } as unknown as jest.Mocked<Pick<GitHubHttpService, 'request'>>;
    const writes = new GitHubWriteService(
      http as unknown as GitHubHttpService,
      writeSettings(true),
    );
    const log = trackingLog(new ReconcileLogService(prisma));
    const executor = new MirrorLabelExecutor(writes);
    const collaborators = noopCollaborators();

    tick.mockImplementation(async () => {
      const record = tickRecord({
        actions: [addLabelAction('factory/dispatched')],
      });
      const id = await log.record(record);
      capturedId = id ?? undefined;
      return { ...record, id: capturedId };
    });

    const task = new ReconcilerTask(
      // ON, explicitly — see the first `buildTask` above.
      makeOperatorSettings({ overrides: { 'reconciler.enabled': true } }),
      {
        addInterval: jest.fn(),
        doesExist: jest.fn(),
        deleteInterval: jest.fn(),
      } as unknown as SchedulerRegistry,
      { tick } as unknown as ReconcilerService,
      executor,
      collaborators.specFeedback,
      collaborators.dispatchQueue,
      collaborators.repositories,
      collaborators.liveness,
      collaborators.watchdog,
      collaborators.deadTime,
      collaborators.escalations,
      collaborators.dispatcher,
      writes,
      log,
    );

    await run(task);

    expect(writes.writesIssued).toBe(1);
    expect(capturedId).toBeDefined();

    const row = await prisma.reconcileTick.findUniqueOrThrow({
      where: { id: capturedId! },
    });

    // The two must agree: a write was attempted (non-zero) AND there is a
    // populated record of what went wrong. Neither half alone is the fix.
    expect(row.actionsExecuted).toBe(1);
    expect(row.executionFailures).toEqual([
      {
        source: 'mirror-label',
        actionType: 'add-mirror-label',
        repository: 'acme/app',
        issueNumber: 312,
        reason: 'GitHub said 500',
      },
    ]);
  });
});
