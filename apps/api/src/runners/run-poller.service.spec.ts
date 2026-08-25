import { EscalationsService } from '../escalations/escalations.service';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import type { QuotaService } from '../quota/quota.service';
import {
  RunEventsService,
  type IngestResult,
} from '../run-events/run-events.service';
import { SILENCE_THRESHOLDS_MS } from '../watchdog/silent-detection';
import { FakeRunner } from './fake-runner';
import {
  LOST_HANDLE_REASON,
  POLLS_INSIDE_TIGHTEST_SILENCE_WINDOW,
  POLL_INTERVAL_MS,
  RunPollerService,
} from './run-poller.service';
import type {
  RunHandle,
  Runner,
  RunPollResult,
  WorkOrderSpec,
} from './runner.types';

/**
 * Driven by the real `FakeRunner` through the real seam.
 *
 * #60 built that double so *"a test double implementing the seam can drive the
 * whole dispatch path"* — and this is the path it was built for. A hand-rolled
 * stub here would let the poller be tested against a different idea of the
 * contract from the one production uses, which is exactly the drift the double
 * exists to prevent.
 *
 * Prisma and ingestion are doubles: what is under test is which events reach
 * ingestion and what happens to a run whose handle is gone, not whether
 * Postgres can store a row.
 */
describe('RunPollerService', () => {
  const RUN_ID = '3f1d9d3e-6b1a-4f8e-9c2a-8b5a4f0c1d22';

  let ingest: jest.Mock<Promise<IngestResult>, [string, unknown[]]>;
  let recordQuota: jest.Mock;
  let findMany: jest.Mock;
  let updateMany: jest.Mock;
  let poller: RunPollerService;

  const workOrder = (
    overrides: Partial<WorkOrderSpec> = {},
  ): WorkOrderSpec => ({
    identity: 'wo_acme-widgets_42_abc1234_a1',
    runId: RUN_ID,
    repository: { owner: 'acme', name: 'widgets' },
    baseCommit: 'a3f91c2000000000000000000000000000000000',
    branch: 'factory/42-abc1234-a1',
    taskSpec: 'Add a health endpoint',
    acceptanceCriteria: ['It returns 200'],
    pathConstraints: [],
    budgetCeilingUsd: null,
    wallClockTimeoutMinutes: null,
    needs: [],
    ...overrides,
  });

  let config: ConfigService;
  let raiseFrom: jest.Mock;
  let findUnique: jest.Mock;
  let defaultTimeoutMinutes: number | null = null;
  let graceMinutes = 2;

  beforeEach(() => {
    defaultTimeoutMinutes = null;
    graceMinutes = 2;
    ingest = jest.fn(async (_runId, events: unknown[]) => ({
      accepted: events.length,
      duplicates: 0,
    }));
    // Nothing live in the database unless a test says so, so the untracked
    // reconcile pass is a no-op by default.
    findMany = jest.fn().mockResolvedValue([]);
    updateMany = jest.fn().mockResolvedValue({ count: 1 });

    // The budget check (#182) reads the run and its order's ceiling.
    // Defaulted to "no ceiling named", so it is a no-op for every test in
    // this file that is about something else -- and visibly so, rather than
    // every unrelated test quietly exercising an overrun.
    findUnique = jest.fn().mockResolvedValue({
      costUsd: null,
      workOrder: {
        identity: 'wo_acme-widgets_42_abc1234_a1',
        budgetCeilingUsd: null,
      },
    });

    const prisma = {
      run: { findMany, updateMany, findUnique },
    } as unknown as PrismaService;
    const runEvents = { ingest } as unknown as RunEventsService;

    // Deadline config the deadline pass (#180) reads. Defaulted generously so
    // every pre-existing test in this file keeps testing polling rather than
    // silently exercising a cancellation -- the same care the executor spec
    // takes with the spend gate.
    config = {
      get: (key: string) =>
        key === 'runners.claudeCodeLocal.defaultTimeoutMinutes'
          ? defaultTimeoutMinutes
          : key === 'runners.deadlineGraceMinutes'
            ? graceMinutes
            : undefined,
    } as unknown as ConfigService;

    raiseFrom = jest.fn().mockResolvedValue({ raised: 1, deduplicated: 0 });
    recordQuota = jest.fn().mockResolvedValue(1);
    poller = new RunPollerService(
      prisma,
      runEvents,
      config,
      { raiseFrom } as unknown as EscalationsService,
      { record: recordQuota } as unknown as QuotaService,
    );
  });

  /** A runner whose poll result the test dictates outright. */
  function stubRunner(...results: RunPollResult[]): Runner {
    const queue = [...results];
    return {
      submit: jest.fn(),
      cancel: jest.fn(),
      capabilities: jest.fn(),
      poll: jest.fn(
        async () => queue.shift() ?? { status: 'running', events: [] },
      ),
    } as unknown as Runner;
  }

  const handle = (overrides: Partial<RunHandle> = {}): RunHandle => ({
    runnerKey: 'fake',
    externalId: 'fake-1',
    workOrderIdentity: 'wo_acme-widgets_42_abc1234_a1',
    ...overrides,
  });

  describe('carrying events into ingestion', () => {
    it("hands a real runner's events to ingestion", async () => {
      // The whole point. Before this, `poll` drained into memory and nothing
      // called it, so loop detection compared signatures it never received and
      // the watchdog measured age from a lastEventAt that never moved.
      const runner = new FakeRunner();
      const submitted = await runner.submit(workOrder());
      poller.track(RUN_ID, runner, submitted);

      const result = await poller.tick();

      expect(ingest).toHaveBeenCalledTimes(1);
      const [runId, events] = ingest.mock.calls[0];
      expect(runId).toBe(RUN_ID);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'run.started',
        source: 'runner-reported',
      });
      expect(result.eventsIngested).toBe(1);
    });

    it('does not call ingestion when there is nothing to carry', async () => {
      // Ingestion rejects an empty batch outright, so an unconditional call
      // would turn a quiet run into an error on every tick.
      poller.track(
        RUN_ID,
        stubRunner({ status: 'running', events: [] }),
        handle(),
      );

      await poller.tick();

      expect(ingest).not.toHaveBeenCalled();
    });

    it('counts duplicates without treating them as failures', async () => {
      // Ingestion is idempotent on (runId, eventId) and the runner is explicit
      // that re-returning a delivered event is expected. A poller that treated
      // that as an error would alarm on its own designed behaviour.
      ingest.mockResolvedValue({ accepted: 0, duplicates: 3 });
      poller.track(
        RUN_ID,
        stubRunner({ status: 'running', events: [event()] }),
        handle(),
      );

      const result = await poller.tick();

      expect(result.duplicates).toBe(3);
      expect(result.failed).toBe(0);
    });

    it('keeps polling a run until it reaches a terminal state', async () => {
      const runner = stubRunner(
        { status: 'running', events: [event()] },
        { status: 'running', events: [event()] },
      );
      poller.track(RUN_ID, runner, handle());

      await poller.tick();
      expect(poller.trackedCount()).toBe(1);
      await poller.tick();
      expect(poller.trackedCount()).toBe(1);
      expect(ingest).toHaveBeenCalledTimes(2);
    });

    it.each(['succeeded', 'failed'] as const)(
      'stops polling once a run has %s',
      async (status) => {
        poller.track(
          RUN_ID,
          stubRunner({ status, events: [event()] }),
          handle(),
        );

        await poller.tick();

        expect(poller.trackedCount()).toBe(0);
      },
    );

    it('leaves the run status to ingestion, never writing it itself', async () => {
      // The events are the record of what happened. A second writer deciding
      // the same fact from a different input is how two sources of truth
      // appear, and #53 already advances the run from its events.
      poller.track(
        RUN_ID,
        stubRunner({ status: 'succeeded', events: [event()] }),
        handle(),
      );

      await poller.tick();

      expect(updateMany).not.toHaveBeenCalled();
    });
  });

  describe('quota windows (#231)', () => {
    const observation = {
      runnerKey: 'claude-code-local',
      kind: 'five_hour' as const,
      resetsAt: new Date('2026-08-25T15:00:00.000Z'),
      pressure: 'allowed' as const,
      observedAt: new Date('2026-08-25T12:00:00.000Z'),
    };

    it('carries what a runner saw into the quota ledger', async () => {
      poller.track(
        RUN_ID,
        stubRunner({ status: 'running', events: [], quota: [observation] }),
        handle(),
      );

      const result = await poller.tick();

      expect(recordQuota).toHaveBeenCalledWith([observation]);
      expect(result.quotaWindows).toBe(1);
    });

    it('records the window even for a run this process has lost', async () => {
      // A window is a fact about the SUBSCRIPTION, not about the run — it
      // stays true when the run it arrived with is gone, which is the same
      // argument that puts ingestion before the `unknown` check.
      poller.track(
        RUN_ID,
        stubRunner({ status: 'unknown', events: [], quota: [observation] }),
        handle(),
      );

      const result = await poller.tick();

      expect(recordQuota).toHaveBeenCalledTimes(1);
      expect(result.lost).toBe(1);
    });

    it('asks for nothing when a runner reported no window', async () => {
      // The common case, and the one #231 must not disturb: a fleet whose
      // runners say nothing about rate limits keeps working, with quota
      // unknown throughout.
      poller.track(
        RUN_ID,
        stubRunner({ status: 'running', events: [] }),
        handle(),
      );

      const result = await poller.tick();

      expect(recordQuota).not.toHaveBeenCalled();
      expect(result.quotaWindows).toBe(0);
    });
  });

  describe('a handle this process no longer holds', () => {
    it('ingests the final events BEFORE giving up on the run', async () => {
      // A runner that lost the run may still hand back its last events on the
      // way out, and throwing those away would lose the only record of how it
      // ended.
      poller.track(
        RUN_ID,
        stubRunner({ status: 'unknown', events: [event()] }),
        handle(),
      );

      const result = await poller.tick();

      expect(ingest).toHaveBeenCalledTimes(1);
      expect(result.lost).toBe(1);
    });

    it('marks the run stalled, not failed', async () => {
      // VISION §9's three failure modes stay distinct only if the control
      // plane refuses to guess between them. The child may genuinely still be
      // running; what is true is that nothing here can see it.
      poller.track(
        RUN_ID,
        stubRunner({ status: 'unknown', events: [] }),
        handle(),
      );

      await poller.tick();

      expect(updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: 'stalled', attentionReason: LOST_HANDLE_REASON },
        }),
      );
    });

    it('will not drag a run back out of a terminal state', async () => {
      // A run that finished between the poll and this write must stay
      // finished. The guard is in the WHERE clause rather than a read-then-
      // compare, so a concurrent writer cannot slip between them.
      poller.track(
        RUN_ID,
        stubRunner({ status: 'unknown', events: [] }),
        handle(),
      );

      await poller.tick();

      const where = updateMany.mock.calls[0][0].where;
      expect(where.id).toBe(RUN_ID);
      expect(where.status).toEqual({ in: ['running', 'stalled', 'blocked'] });
    });

    it('stops polling a lost run', async () => {
      poller.track(
        RUN_ID,
        stubRunner({ status: 'unknown', events: [] }),
        handle(),
      );

      await poller.tick();

      expect(poller.trackedCount()).toBe(0);
    });

    it('says in the reason that nobody is watching', async () => {
      // #66 and the cockpit both read attentionReason, and a status with no
      // explanation sends an operator hunting rather than acting.
      poller.track(
        RUN_ID,
        stubRunner({ status: 'unknown', events: [] }),
        handle(),
      );
      await poller.tick();

      expect(LOST_HANDLE_REASON).toContain('Nothing is polling this run');
      expect(LOST_HANDLE_REASON).toContain('pinned base commit');
    });
  });

  describe('runs the database thinks are live and nothing is polling', () => {
    it('marks a run this process never tracked', async () => {
      // Almost always an API restart: the handles were in memory and the child
      // was detached, so the run may still be executing while nothing can see
      // it.
      findMany.mockResolvedValue([
        { id: 'orphan-run', status: 'running', attentionReason: null },
      ]);

      const result = await poller.tick();

      expect(result.lost).toBe(1);
      expect(updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'orphan-run' }),
        }),
      );
    });

    it('leaves a tracked run alone', async () => {
      findMany.mockResolvedValue([
        { id: RUN_ID, status: 'running', attentionReason: null },
      ]);
      poller.track(
        RUN_ID,
        stubRunner({ status: 'running', events: [] }),
        handle(),
      );

      const result = await poller.tick();

      expect(result.lost).toBe(0);
      expect(updateMany).not.toHaveBeenCalled();
    });

    it('does not rewrite a reason it has already written', async () => {
      // Otherwise the same sentence is written every fifteen seconds, churning
      // updatedAt and making the cockpit look like something is happening when
      // nothing is.
      findMany.mockResolvedValue([
        {
          id: 'orphan-run',
          status: 'stalled',
          attentionReason: LOST_HANDLE_REASON,
        },
      ]);

      const result = await poller.tick();

      expect(result.lost).toBe(0);
      expect(updateMany).not.toHaveBeenCalled();
    });

    it('does re-report a stalled run whose reason was something else', async () => {
      // A run the watchdog stalled for silence is a different fact from one
      // nothing is watching, and collapsing them would hide the second.
      findMany.mockResolvedValue([
        {
          id: 'orphan-run',
          status: 'stalled',
          attentionReason: 'Silent for 4 minutes',
        },
      ]);

      const result = await poller.tick();

      expect(result.lost).toBe(1);
    });
  });

  describe('one bad run does not stop the others', () => {
    it('survives a runner whose poll throws', async () => {
      // A poller that dies on one run stops carrying events for every run,
      // which presents as the whole fleet going silent at once — the most
      // alarming and least accurate thing this system could report.
      const exploding = {
        poll: jest.fn(async () => {
          throw new Error('runner exploded');
        }),
      } as unknown as Runner;

      poller.track('bad-run', exploding, handle({ externalId: 'bad' }));
      poller.track(
        RUN_ID,
        stubRunner({ status: 'running', events: [event()] }),
        handle(),
      );

      const result = await poller.tick();

      expect(result.failed).toBe(1);
      expect(result.eventsIngested).toBe(1);
    });

    it('survives ingestion throwing, and re-requests next tick', async () => {
      // The runner is explicit that returning an already-delivered event is
      // safe, so leaving the run tracked is the correct recovery: the events
      // come back on the next poll rather than being lost.
      ingest.mockRejectedValue(new Error('database is down'));
      poller.track(
        RUN_ID,
        stubRunner({ status: 'running', events: [event()] }),
        handle(),
      );

      const result = await poller.tick();

      expect(result.failed).toBe(1);
      expect(poller.trackedCount()).toBe(1);
    });

    it('never throws out of tick, even when the database is down', async () => {
      // tick() runs on an interval. An unhandled rejection from a setInterval
      // callback has no caller to propagate to and takes the process down
      // under Node's default policy — and a dead process is a dead factory,
      // the exact silent failure this system exists to eliminate.
      findMany.mockRejectedValue(new Error('database is down'));
      poller.track(
        RUN_ID,
        stubRunner({ status: 'running', events: [event()] }),
        handle(),
      );

      const result = await poller.tick();

      // The polling work already done in the same tick still counts.
      expect(result.eventsIngested).toBe(1);
      // Two, not one: `findMany` backs BOTH database passes -- the deadline
      // sweep (#180) and the untracked reconcile -- and each is guarded
      // separately so that one failing cannot discard the other's work. The
      // count is the number of passes that could not complete, which is the
      // honest figure; collapsing it to one would hide that two things went
      // wrong. What this test is really about is the absence of a throw.
      expect(result.failed).toBe(2);
      expect(result.timedOut).toBe(0);
    });
  });

  describe('tracking', () => {
    it('forgets a run on request, and forgetting an unknown run is safe', () => {
      poller.track(RUN_ID, stubRunner(), handle());
      expect(poller.trackedCount()).toBe(1);

      poller.forget(RUN_ID);
      expect(poller.trackedCount()).toBe(0);
      expect(() => poller.forget('never-tracked')).not.toThrow();
    });
  });

  describe('the interval and the watchdog agree (#147)', () => {
    it('polls several times inside the tightest silence window', () => {
      // #54 declares a full-streaming run silent after 90 seconds. Poll less
      // often than that and every healthy run is declared silent because its
      // lastEventAt has not been updated yet — the watchdog would be measuring
      // OUR latency rather than the runner's.
      expect(POLL_INTERVAL_MS).toBeLessThan(SILENCE_THRESHOLDS_MS.full);
      expect(POLLS_INSIDE_TIGHTEST_SILENCE_WINDOW).toBeGreaterThanOrEqual(4);
    });

    it('does not poll so often that it becomes the load', () => {
      // The other side of the same constraint. A one-second poll would spend
      // the fleet's headroom on questions nobody asked.
      expect(POLL_INTERVAL_MS).toBeGreaterThanOrEqual(5_000);
    });
  });

  /**
   * The control-plane deadline sweep (#180).
   *
   * The policy's own boundary is exhaustively covered in
   * `budget/run-deadline.spec.ts`. What is asserted here is the enforcement:
   * that a cancel actually goes through the SEAM, that the figure is recorded
   * even when the cancel fails, that it happens once, and that a run this
   * process cannot reach is not claimed to have been cancelled.
   */
  describe('the wall-clock deadline', () => {
    const HOUR_AGO = new Date(Date.now() - 60 * 60 * 1000);
    const MINUTE_AGO = new Date(Date.now() - 60 * 1000);

    /** What the deadline pass's own `findMany` should return. */
    function liveRun(startedAt: Date, wallClockTimeoutMinutes: number | null) {
      return {
        id: RUN_ID,
        startedAt,
        workOrder: {
          identity: 'wo_acme-widgets_42_abc1234_a1',
          wallClockTimeoutMinutes,
        },
      };
    }

    it('cancels an overdue run through the seam and records the figure', async () => {
      findMany.mockResolvedValue([liveRun(HOUR_AGO, 10)]);
      const runner = stubRunner();
      poller.track(RUN_ID, runner, handle());

      const result = await poller.tick();

      expect(result.timedOut).toBe(1);
      // Through `cancel(handle)` -- never through anything that knows what an
      // `externalId` contains, which #60's seam forbids.
      expect(runner.cancel).toHaveBeenCalledWith(handle());
      expect(updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            attentionReason: expect.stringContaining('ceiling of 10 minute(s)'),
          },
        }),
      );
    });

    it('leaves a run inside its ceiling alone', async () => {
      findMany.mockResolvedValue([liveRun(MINUTE_AGO, 60)]);
      const runner = stubRunner();
      poller.track(RUN_ID, runner, handle());

      const result = await poller.tick();

      expect(result.timedOut).toBe(0);
      expect(runner.cancel).not.toHaveBeenCalled();
    });

    it('uses the configured default when the order names no ceiling', async () => {
      defaultTimeoutMinutes = 5;
      findMany.mockResolvedValue([liveRun(HOUR_AGO, null)]);
      const runner = stubRunner();
      poller.track(RUN_ID, runner, handle());

      expect((await poller.tick()).timedOut).toBe(1);
      expect(runner.cancel).toHaveBeenCalled();
    });

    it('leaves an unbounded run running, however long it has been going', async () => {
      // No ceiling on the order and no default configured is a deliberate
      // operator choice, per RUNNER_DEFAULT_TIMEOUT_MINUTES' own docs.
      defaultTimeoutMinutes = null;
      findMany.mockResolvedValue([liveRun(HOUR_AGO, null)]);
      const runner = stubRunner();
      poller.track(RUN_ID, runner, handle());

      expect((await poller.tick()).timedOut).toBe(0);
      expect(runner.cancel).not.toHaveBeenCalled();
    });

    it('cancels once, not on every tick', async () => {
      // Fifteen seconds apart, forever, against a runner already killing the
      // process -- the same churn `reconcileUntracked` refuses for
      // LOST_HANDLE_REASON.
      findMany.mockResolvedValue([liveRun(HOUR_AGO, 10)]);
      const runner = stubRunner();
      poller.track(RUN_ID, runner, handle());

      await poller.tick();
      const second = await poller.tick();

      expect(runner.cancel).toHaveBeenCalledTimes(1);
      expect(second.timedOut).toBe(0);
    });

    it('records the reason even when the runner refuses to cancel', async () => {
      // THE case most worth reporting: the run has provably passed its
      // ceiling and is still going. Writing the reason only on a successful
      // cancel would lose exactly this one.
      findMany.mockResolvedValue([liveRun(HOUR_AGO, 10)]);
      const runner = stubRunner();
      (runner.cancel as jest.Mock).mockRejectedValue(
        new Error('runner is wedged'),
      );
      poller.track(RUN_ID, runner, handle());

      const result = await poller.tick();

      expect(result.timedOut).toBe(1);
      // "may STILL BE RUNNING", never "cancelled". The run passed its ceiling
      // and nothing stopped it, and that is the sentence an operator has to
      // act on -- reporting a cancellation that did not happen would be the
      // one failure mode this whole pass is built to avoid.
      const written = updateMany.mock.calls.map(
        ([arg]) =>
          (arg as { data: { attentionReason: string } }).data.attentionReason,
      );
      expect(written.at(-1)).toContain('may STILL BE RUNNING');
      expect(written.at(-1)).toContain('runner refused');
      expect(written.at(-1)).not.toContain('The control plane cancelled it');
    });

    it('records the certain part first, so a crash mid-cancel still leaves a reason', async () => {
      // The ordering IS the design. The first write says only what
      // `decideDeadline` could prove -- the run passed its ceiling and its
      // runner did not stop it -- so a process that dies between the two
      // writes still leaves an operator something true. The second appends
      // the outcome once it is a fact.
      findMany.mockResolvedValue([liveRun(HOUR_AGO, 10)]);
      poller.track(RUN_ID, stubRunner(), handle());

      await poller.tick();

      const written = updateMany.mock.calls.map(
        ([arg]) =>
          (arg as { data: { attentionReason: string } }).data.attentionReason,
      );

      expect(written).toHaveLength(2);
      expect(written[0]).toContain('ceiling of 10 minute(s)');
      expect(written[0]).not.toContain('control plane');
      expect(written[1]).toContain('The control plane cancelled it.');
    });

    it('does not throw when the runner refuses to cancel', async () => {
      findMany.mockResolvedValue([liveRun(HOUR_AGO, 10)]);
      const runner = stubRunner();
      (runner.cancel as jest.Mock).mockRejectedValue(
        new Error('runner is wedged'),
      );
      poller.track(RUN_ID, runner, handle());

      await expect(poller.tick()).resolves.toBeDefined();
    });

    it('never touches a run this process has no handle for', async () => {
      // It cannot cancel one -- #60 forbids rebuilding a handle -- so it must
      // not report one as cancelled either. `reconcileUntracked` already says
      // the true thing about those runs: nobody is watching them.
      findMany.mockResolvedValue([liveRun(HOUR_AGO, 10)]);

      const result = await poller.tick();

      expect(result.timedOut).toBe(0);
    });
  });

  /**
   * Acting on a budget ceiling that has been passed (#182).
   *
   * The policy's boundary is covered in `budget/budget-overrun.spec.ts`. What
   * is asserted here is the pair of arms, and the thing that separates them:
   * a run that can still be stopped IS stopped, a run that cannot is recorded
   * and escalated, and neither is ever described as the other.
   */
  describe('the budget ceiling', () => {
    /** What the budget check's own `findUnique` should return. */
    function costed(costUsd: number | null, budgetCeilingUsd: number | null) {
      findUnique.mockResolvedValue({
        costUsd,
        workOrder: {
          identity: 'wo_acme-widgets_42_abc1234_a1',
          budgetCeilingUsd,
        },
      });
    }

    /** Every `attentionReason` written, in order. */
    function written(): string[] {
      return updateMany.mock.calls
        .map(
          ([arg]) =>
            (arg as { data: { attentionReason?: string } }).data
              .attentionReason,
        )
        .filter((reason): reason is string => typeof reason === 'string');
    }

    it('cancels a LIVE run that has passed its ceiling', async () => {
      // The arm that cannot fire for claude-code-local, which reports cost
      // only on its final line -- and must still exist, because the seam's
      // contract promises it for any runner that reports incrementally.
      costed(40, 5);
      const runner = stubRunner({ status: 'running', events: [event()] });
      poller.track(RUN_ID, runner, handle());

      const result = await poller.tick();

      expect(result.overBudget).toBe(1);
      expect(runner.cancel).toHaveBeenCalledWith(handle());
      expect(written().at(-1)).toContain('The control plane cancelled it.');
    });

    it('records and escalates a FINISHED run rather than claiming to have stopped it', async () => {
      // The arm that fires today. Reporting a cancellation here would be the
      // synthesized-event-as-report VISION §9 forbids -- there was nothing
      // left to cancel.
      costed(40, 5);
      const runner = stubRunner({ status: 'succeeded', events: [event()] });
      poller.track(RUN_ID, runner, handle());

      const result = await poller.tick();

      expect(result.overBudget).toBe(1);
      expect(runner.cancel).not.toHaveBeenCalled();
      expect(written().at(-1)).toContain(
        'already finished, so nothing could be stopped',
      );
      expect(written().at(-1)).not.toContain('cancelled it');
    });

    it('names both figures and the gap', async () => {
      // #65's first acceptance criterion, at the layer that persists it.
      costed(40, 5);
      poller.track(
        RUN_ID,
        stubRunner({ status: 'succeeded', events: [event()] }),
        handle(),
      );

      await poller.tick();

      expect(written().at(-1)).toContain('$40.00');
      expect(written().at(-1)).toContain('$5.00');
      expect(written().at(-1)).toContain('$35.00 over');
    });

    it('raises a budget_exceeded escalation', async () => {
      // The kind has been in the schema since it was written and nothing had
      // ever raised it. An operator who learns a $5 ceiling was passed by $35
      // can stop it being a habit.
      costed(40, 5);
      poller.track(
        RUN_ID,
        stubRunner({ status: 'succeeded', events: [event()] }),
        handle(),
      );

      await poller.tick();

      expect(raiseFrom).toHaveBeenCalledWith([
        expect.objectContaining({
          type: 'escalate',
          runId: RUN_ID,
          escalationKind: 'budget_exceeded',
        }),
      ]);
    });

    it('leaves a run inside its ceiling alone', async () => {
      costed(2, 5);
      const runner = stubRunner({ status: 'succeeded', events: [event()] });
      poller.track(RUN_ID, runner, handle());

      const result = await poller.tick();

      expect(result.overBudget).toBe(0);
      expect(raiseFrom).not.toHaveBeenCalled();
      expect(runner.cancel).not.toHaveBeenCalled();
    });

    it('leaves a run whose order names no ceiling alone', async () => {
      costed(400, null);
      poller.track(
        RUN_ID,
        stubRunner({ status: 'succeeded', events: [event()] }),
        handle(),
      );

      expect((await poller.tick()).overBudget).toBe(0);
    });

    it('leaves a run that reported no cost alone', async () => {
      // Null is unknown, not zero. Judging an unknown against a ceiling would
      // either flag every silent run or clear it, and both are guesses.
      costed(null, 5);
      poller.track(
        RUN_ID,
        stubRunner({ status: 'succeeded', events: [event()] }),
        handle(),
      );

      expect((await poller.tick()).overBudget).toBe(0);
    });

    it('acts once, not on every tick', async () => {
      costed(40, 5);
      const runner = stubRunner(
        { status: 'running', events: [event()] },
        { status: 'running', events: [event()] },
      );
      poller.track(RUN_ID, runner, handle());

      await poller.tick();
      const second = await poller.tick();

      expect(raiseFrom).toHaveBeenCalledTimes(1);
      expect(second.overBudget).toBe(0);
    });

    it('says it may still be spending when the runner refuses to cancel', async () => {
      costed(40, 5);
      const runner = stubRunner({ status: 'running', events: [event()] });
      (runner.cancel as jest.Mock).mockRejectedValue(
        new Error('runner is wedged'),
      );
      poller.track(RUN_ID, runner, handle());

      await poller.tick();

      expect(written().at(-1)).toContain('STILL BE RUNNING and still spending');
      expect(written().at(-1)).not.toContain('The control plane cancelled it.');
    });

    it('does not lose ingested events when the budget check throws', async () => {
      // Guarded separately for exactly this: a budget check that fails must
      // not discard the events already carried, nor stop the poller reaching
      // the rest of the fleet.
      findUnique.mockRejectedValue(new Error('database is down'));
      poller.track(
        RUN_ID,
        stubRunner({ status: 'running', events: [event()] }),
        handle(),
      );

      const result = await poller.tick();

      expect(result.eventsIngested).toBe(1);
      expect(result.failed).toBe(1);
    });
  });
});

let sequence = 0;
function event() {
  sequence += 1;
  return {
    schemaVersion: '1.0.0',
    eventId: `evt-${sequence}`,
    runId: '3f1d9d3e-6b1a-4f8e-9c2a-8b5a4f0c1d22',
    workOrderId: 'wo_acme-widgets_42_abc1234_a1',
    type: 'run.heartbeat' as const,
    source: 'runner-reported' as const,
    occurredAt: new Date().toISOString(),
  };
}
