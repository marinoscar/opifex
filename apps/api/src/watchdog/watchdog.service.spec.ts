import { PrismaService } from '../prisma/prisma.service';
import { WATCHDOG_CHECKS } from './check-coverage';
import { WatchdogService } from './watchdog.service';

const NOW = new Date('2026-08-21T12:00:00Z');

function runRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '018f2c31-7a4e-7c3b-9f21-4d5e6a7b8c9d',
    status: 'running',
    startedAt: new Date(NOW.getTime() - 120 * 60_000),
    lastEventAt: new Date(NOW.getTime() - 10 * 60_000),
    runnerKey: 'claude-code-local',
    // The newest event's source, for #59's per-source latency split.
    events: [{ source: 'runner' }],
    runner: {
      capability: {
        streamingFidelity: 'full',
        rateLimitSignal: 'structured',
      },
    },
    workOrder: {
      identity: 'wo_opifex_312_a3f91c2_a1',
      issueNumber: 312,
      branch: 'factory/312-a3f91c2-a1',
      repository: { owner: 'marinoscar', name: 'opifex' },
    },
    ...overrides,
  };
}

describe('WatchdogService', () => {
  /** Live runs for the first query; the blocked query still returns none. */
  function mockLiveRuns(rows: unknown[]) {
    prisma.run.findMany.mockImplementation(
      async (query: { where: { status: unknown } }) =>
        query.where.status === 'blocked' ? [] : rows,
    );
  }

  let prisma: {
    run: { findMany: jest.Mock; update?: jest.Mock };
    runEvent: { findMany: jest.Mock };
  };
  let service: WatchdogService;

  beforeEach(() => {
    prisma = {
      run: { findMany: jest.fn().mockResolvedValue([runRow()]) },
      runEvent: { findMany: jest.fn().mockResolvedValue([]) },
    };
    // Blocked runs are a second query against `run.findMany`; by default the
    // suite has none, so the first call returns live runs and the second none.
    prisma.run.findMany.mockImplementation(
      async (query: { where: { status: unknown } }) =>
        query.where.status === 'blocked' ? [] : [runRow()],
    );
    prisma.run.update = jest.fn().mockResolvedValue({});
    service = new WatchdogService(prisma as unknown as PrismaService);
  });

  describe('what it loads', () => {
    it('judges only running and stalled runs', async () => {
      // `blocked` is excluded here as well as in the detector: a parked run is
      // supposed to be quiet, and loading it only to discard it invites
      // someone to "fix" the filter later without knowing why it was there.
      await service.sweep(NOW);

      const [{ where }] = prisma.run.findMany.mock.calls[0];
      expect(where).toEqual({ status: { in: ['running', 'stalled'] } });
    });

    it('joins through the runner capability, rather than assuming a fidelity', async () => {
      // The whole point of #54's thresholds is that they come from what a
      // runner DECLARED it can do.
      await service.sweep(NOW);

      const [{ select }] = prisma.run.findMany.mock.calls[0];
      expect(select.runner.select.capability.select.streamingFidelity).toBe(
        true,
      );
    });
  });

  describe('computing, not executing', () => {
    it('produces a kill-and-re-run action for a silent run', async () => {
      const result = await service.sweep(NOW);

      expect(result.actions.map((a) => a.type)).toContain('kill-and-re-run');
    });

    it('ALSO produces an escalation, because a kill nobody is told about is the original problem', async () => {
      // VISION §9 puts notification "on the same footing as dispatch". They
      // are not alternatives: the kill is what should happen to the run, the
      // escalation is what should happen to the human.
      const result = await service.sweep(NOW);

      expect(result.actions.map((a) => a.type)).toEqual([
        'kill-and-re-run',
        'escalate',
      ]);
    });

    it('carries the runId, since the action concerns an execution not an issue', async () => {
      const result = await service.sweep(NOW);

      for (const action of result.actions) {
        expect(action.runId).toBe('018f2c31-7a4e-7c3b-9f21-4d5e6a7b8c9d');
      }
    });

    it('writes an escalation reason decidable without a laptop', async () => {
      // #57: what stopped, which repository and issue, how long ago, what
      // Opifex did about it, and what happens if it is ignored.
      const result = await service.sweep(NOW);
      const escalation = result.actions.find((a) => a.type === 'escalate')!;

      expect(escalation.reason).toContain('wo_opifex_312_a3f91c2_a1');
      expect(escalation.reason).toContain('marinoscar/opifex#312');
      expect(escalation.reason).toContain('silent for 10m');
      expect(escalation.reason).toContain('waiting for you');
    });

    it('says plainly that the kill was NOT executed', async () => {
      // The phase boundary #54 names. A log claiming a kill that did not
      // happen is worse than no log.
      const result = await service.sweep(NOW);
      const kill = result.actions.find((a) => a.type === 'kill-and-re-run')!;

      expect(kill.reason).toContain('kill and re-run');
      // Nothing in the service can execute it.
      expect(Object.keys(service)).not.toContain('executor');
    });
  });

  describe('a healthy run', () => {
    it('produces no actions at all', async () => {
      mockLiveRuns([runRow({ lastEventAt: new Date(NOW.getTime() - 5_000) })]);

      const result = await service.sweep(NOW);

      expect(result).toMatchObject({ runsJudged: 1, silentRuns: 0 });
      expect(result.actions).toEqual([]);
    });
  });

  describe('capability-derived thresholds, end to end', () => {
    it('spares a non-streaming runner at an age that would kill a streaming one', async () => {
      mockLiveRuns([
        runRow({
          runnerKey: 'claude-code-cloud',
          runner: { capability: { streamingFidelity: 'none' } },
          lastEventAt: new Date(NOW.getTime() - 30 * 60_000),
        }),
      ]);

      expect((await service.sweep(NOW)).silentRuns).toBe(0);
    });

    it('spares a runner with no capability manifest at all', async () => {
      // An unregistered runner is an operational gap; killing its runs is the
      // wrong way to report one.
      mockLiveRuns([
        runRow({
          runner: null,
          lastEventAt: new Date(NOW.getTime() - 30 * 60_000),
        }),
      ]);

      expect((await service.sweep(NOW)).silentRuns).toBe(0);
    });

    it('names the declared fidelity in the verdict', async () => {
      const result = await service.sweep(NOW);
      const kill = result.actions.find((a) => a.type === 'kill-and-re-run')!;

      expect(kill.reason).toContain('declares full streaming fidelity');
    });
  });

  describe('loop detection', () => {
    /** N identical tool signatures, newest first as the query returns them. */
    function toolEvents(signature: string, times: number) {
      return Array.from({ length: times }, (_, i) => ({
        toolSignature: signature,
        occurredAt: new Date(NOW.getTime() - i * 1000),
      }));
    }

    beforeEach(() => {
      // Healthy on the silence axis, so only the loop check can fire.
      mockLiveRuns([runRow({ lastEventAt: new Date(NOW.getTime() - 5_000) })]);
    });

    it('produces kill-and-re-PLAN, not kill-and-re-run', async () => {
      // #55: re-running the identical work order from base would simply loop
      // again. Collapsing the two responses is the mistake VISION §9 warns
      // about directly.
      prisma.runEvent.findMany.mockResolvedValue(
        toolEvents('Bash:sha256:abc', 10),
      );

      const result = await service.sweep(NOW);

      expect(result.actions.map((a) => a.type)).toEqual([
        'kill-and-re-plan',
        'escalate',
      ]);
      expect(result.loopingRuns).toBe(1);
    });

    it('says the work order needs DECOMPOSING, not retrying', async () => {
      prisma.runEvent.findMany.mockResolvedValue(
        toolEvents('Bash:sha256:abc', 10),
      );

      const result = await service.sweep(NOW);
      const escalation = result.actions.find((a) => a.type === 'escalate')!;

      expect(escalation.reason).toContain('would loop again');
      expect(escalation.reason).toContain('decomposing');
    });

    it('counts an unmeasurable run separately from a clean one', async () => {
      // A count of zero looping runs that quietly included unmeasurable ones
      // would be a false reassurance.
      mockLiveRuns([
        runRow({
          lastEventAt: new Date(NOW.getTime() - 5_000),
          runner: { capability: { streamingFidelity: 'none' } },
        }),
      ]);

      const result = await service.sweep(NOW);

      expect(result).toMatchObject({ loopingRuns: 0, loopCheckUnavailable: 1 });
      expect(result.actions).toEqual([]);
    });

    it('does not check a run already judged SILENT', async () => {
      // A run cannot be both: silence means no events at all, a loop is
      // defined by events flowing. Computing two different kill responses for
      // one run would put contradictory instructions in front of the operator.
      mockLiveRuns([
        runRow({ lastEventAt: new Date(NOW.getTime() - 10 * 60_000) }),
      ]);

      const result = await service.sweep(NOW);

      expect(prisma.runEvent.findMany).not.toHaveBeenCalled();
      expect(result.actions.map((a) => a.type)).toEqual([
        'kill-and-re-run',
        'escalate',
      ]);
    });

    it('reads only events that carry a tool signature, bounded', async () => {
      await service.sweep(NOW);

      const [query] = prisma.runEvent.findMany.mock.calls[0];
      expect(query.where.toolSignature).toEqual({ not: null });
      expect(query.take).toBeLessThanOrEqual(40);
    });

    it('spares a test-fix-retest cycle end to end', async () => {
      prisma.runEvent.findMany.mockResolvedValue(
        Array.from({ length: 30 }, (_, i) => ({
          toolSignature: i % 2 === 0 ? 'Bash:test' : 'Edit:src/thing.ts',
          occurredAt: new Date(NOW.getTime() - i * 1000),
        })),
      );

      const result = await service.sweep(NOW);

      expect(result.loopingRuns).toBe(0);
      expect(result.actions).toEqual([]);
    });
  });

  describe('parking blocked runs', () => {
    function blockedRow(overrides: Record<string, unknown> = {}) {
      return {
        id: 'blocked-run',
        startedAt: new Date(NOW.getTime() - 60 * 60_000),
        resumesAt: null,
        workOrder: {
          identity: 'wo_opifex_318_c1d2e3f_a1',
          issueNumber: 318,
          repository: { owner: 'marinoscar', name: 'opifex' },
        },
        events: [
          {
            occurredAt: new Date(NOW.getTime() - 5 * 60_000),
            blockedReason: 'rate-limit',
            blockedUntil: new Date(NOW.getTime() + 4 * 60 * 60_000),
          },
        ],
        ...overrides,
      };
    }

    /**
     * A blocked row whose park has already been PLANNED, consistently.
     *
     * A plan is its block's reset PLUS jitter (#477), so a real `resumesAt` is
     * always later than the `blockedUntil` it came from. A row with the plan
     * BEFORE the reset describes a block superseded by a later one, which
     * `decideParking` now re-plans on purpose — so it cannot stand in for
     * "already parked".
     */
    function plannedRow(resumesInMs: number) {
      return blockedRow({
        resumesAt: new Date(NOW.getTime() + resumesInMs),
        events: [
          {
            occurredAt: new Date(NOW.getTime() - 5 * 60_000),
            blockedReason: 'rate-limit',
            blockedUntil: new Date(NOW.getTime() + resumesInMs - 60_000),
          },
        ],
      });
    }

    function mockBlocked(rows: unknown[]) {
      prisma.run.findMany.mockImplementation(
        async (query: { where: { status: unknown } }) =>
          query.where.status === 'blocked' ? rows : [],
      );
    }

    it('parks a newly blocked run and persists the scheduled resume', async () => {
      // Persisted so the NEXT tick sees it scheduled and waits, rather than
      // re-deciding and moving the time again — which would leave the run
      // chasing its own jitter and never resuming.
      mockBlocked([blockedRow()]);

      const result = await service.sweep(NOW);

      expect(result.parkedRuns).toBe(1);
      expect(result.actions.map((a) => a.type)).toEqual(['park']);
      const [{ data }] = prisma.run.update!.mock.calls[0];
      expect(data.resumesAt.getTime()).toBeGreaterThanOrEqual(
        NOW.getTime() + 4 * 60 * 60_000,
      );
    });

    it('is silent while a parked run simply waits', async () => {
      // A blocked run waiting out its quota is Opifex succeeding. An action
      // every tick would bury the ones that need attention.
      mockBlocked([plannedRow(60 * 60_000)]);

      const result = await service.sweep(NOW);

      expect(result.actions).toEqual([]);
      expect(prisma.run.update).not.toHaveBeenCalled();
    });

    it('computes a resume once the scheduled time has passed', async () => {
      mockBlocked([plannedRow(-60_000)]);

      const result = await service.sweep(NOW);

      expect(result.resumableRuns).toBe(1);
      expect(result.actions.map((a) => a.type)).toEqual(['resume']);
    });

    it('escalates an undated block rather than parking it forever', async () => {
      mockBlocked([
        blockedRow({
          events: [
            {
              occurredAt: new Date(NOW.getTime() - 60 * 60_000),
              blockedReason: 'unknown',
              blockedUntil: null,
            },
          ],
        }),
      ]);

      const result = await service.sweep(NOW);

      expect(result.actions.map((a) => a.type)).toEqual(['escalate']);
    });

    it('dates the patience clock from the CURRENT block, not the run start', async () => {
      // A run can block, resume and block again. Measuring from the run's own
      // start would escalate a fresh block on a long-lived run instantly.
      mockBlocked([
        blockedRow({
          startedAt: new Date(NOW.getTime() - 10 * 60 * 60_000),
          events: [
            {
              occurredAt: new Date(NOW.getTime() - 60_000),
              blockedReason: 'unknown',
              blockedUntil: null,
            },
          ],
        }),
      ]);

      expect((await service.sweep(NOW)).actions).toEqual([]);
    });

    /**
     * EVERY blocked run, not only the ones this tick parked. The ledger behind
     * metric 2 is reconciled against what is true now, and reporting only the
     * transition would record the first minute of a four-hour quota wait and
     * none of the rest.
     */
    it('reports every blocked run as parked dead time, even while waiting', async () => {
      const blockedSince = new Date(NOW.getTime() - 5 * 60_000);
      mockBlocked([plannedRow(60 * 60_000)]);

      const result = await service.sweep(NOW);

      expect(result.parkedRuns).toBe(0);
      expect(result.deadObservations).toEqual([
        { runId: 'blocked-run', kind: 'parked', since: blockedSince },
      ]);
    });

    it('reads the newest run.blocked event for the reason and reset', async () => {
      mockBlocked([blockedRow()]);

      await service.sweep(NOW);

      const blockedQuery = prisma.run.findMany.mock.calls.find(
        ([q]: [{ where: { status: unknown } }]) => q.where.status === 'blocked',
      )![0];
      expect(blockedQuery.select.events.where).toEqual({ type: 'run_blocked' });
      expect(blockedQuery.select.events.take).toBe(1);
    });
  });

  describe('dead-time observations (#232)', () => {
    /**
     * The interval begins when progress actually STOPPED, which is the same
     * instant `Escalation.progressStoppedAt` records. Metric 1 and metric 2
     * share a start and differ entirely in where they end — recording the
     * detection instant here would silently discount every stall by however
     * long it took to notice, which is metric 1's number, not metric 2's.
     */
    it('dates a stall from when progress stopped, not from the sweep', async () => {
      const lastEventAt = new Date(NOW.getTime() - 47 * 60_000);
      mockLiveRuns([runRow({ lastEventAt })]);

      const result = await service.sweep(NOW);

      expect(result.deadObservations).toEqual([
        {
          runId: '018f2c31-7a4e-7c3b-9f21-4d5e6a7b8c9d',
          kind: 'stalled',
          since: lastEventAt,
        },
      ]);
    });

    it('observes nothing about a healthy run', async () => {
      mockLiveRuns([runRow({ lastEventAt: new Date(NOW.getTime() - 30_000) })]);

      const result = await service.sweep(NOW);

      expect(result.deadObservations).toEqual([]);
    });
  });

  describe('detection latency, carried on the escalation (#59)', () => {
    const escalation = (actions: { type: string }[]) =>
      actions.find((action) => action.type === 'escalate') as Record<
        string,
        unknown
      >;

    it('carries when the run stopped, not when the tick noticed', async () => {
      const { actions } = await service.sweep(NOW);

      expect(escalation(actions).progressStoppedAt).toBe(
        new Date(NOW.getTime() - 10 * 60_000).toISOString(),
      );
    });

    it('carries which liveness source last saw it alive', async () => {
      mockLiveRuns([runRow({ events: [{ source: 'git' }] })]);

      const { actions } = await service.sweep(NOW);

      expect(escalation(actions).detectionSource).toBe('git');
    });

    it('omits the source for a run nothing has ever observed', async () => {
      // Rather than defaulting to `runner`, which would attribute a
      // git-carried run's latency to the wrong source.
      mockLiveRuns([
        runRow({
          lastEventAt: null,
          events: [],
          startedAt: new Date(NOW.getTime() - 200 * 60_000),
          runner: { capability: { streamingFidelity: 'none' } },
        }),
      ]);

      const { actions } = await service.sweep(NOW);

      expect(escalation(actions).detectionSource).toBeUndefined();
      expect(escalation(actions).progressStoppedAt).toBe(
        new Date(NOW.getTime() - 200 * 60_000).toISOString(),
      );
    });

    it('measures a LOOPING run from when the signature started repeating', async () => {
      // Not from its newest event. A looping run is not silent, so the last
      // event is seconds old while the run has been going nowhere for an hour.
      const startedRepeating = new Date(NOW.getTime() - 60 * 60_000);
      mockLiveRuns([runRow({ lastEventAt: new Date(NOW.getTime() - 5_000) })]);
      // Newest first, as the real query orders them.
      prisma.runEvent.findMany.mockResolvedValue(
        Array.from({ length: 8 }, (_, i) => ({
          toolSignature: 'Bash:x',
          occurredAt: new Date(startedRepeating.getTime() + (7 - i) * 60_000),
        })),
      );

      const { actions } = await service.sweep(NOW);

      const looping = actions.find(
        (action) =>
          action.type === 'escalate' && action.escalationKind === 'run_looping',
      );
      expect(looping!.progressStoppedAt).toBe(startedRepeating.toISOString());
      // Loop detection needs tool detail, which only the runner stream carries.
      expect(looping!.detectionSource).toBe('runner');
    });
  });

  describe('determinism', () => {
    it('takes now as a parameter, so the same inputs give the same verdicts', async () => {
      const first = await service.sweep(NOW);
      const second = await service.sweep(NOW);

      expect(second.actions).toEqual(first.actions);
    });
  });
});

describe('what one sweep says about coverage (#104)', () => {
  /**
   * The fleet-wide half of #104. A sweep that reports what it FOUND but not
   * what it could not look for is the false confidence the issue is about:
   * zero looping runs reads as "nothing is looping" even when half the fleet
   * is on runners where a loop is undetectable.
   */
  let prisma: {
    run: { findMany: jest.Mock; update: jest.Mock };
    runEvent: { findMany: jest.Mock };
  };
  let service: WatchdogService;

  function withLiveRuns(rows: unknown[]) {
    prisma.run.findMany.mockImplementation(
      async (query: { where: { status: unknown } }) =>
        query.where.status === 'blocked' ? [] : rows,
    );
  }

  beforeEach(() => {
    prisma = {
      run: {
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({}),
      },
      runEvent: { findMany: jest.fn().mockResolvedValue([]) },
    };
    withLiveRuns([]);
    service = new WatchdogService(prisma as unknown as PrismaService);
  });

  it('loads the rate-limit signal and the branch, not only the fidelity', async () => {
    // Both are part of what covers a run — parking needs a datable block, and
    // git-derived liveness needs a branch to watch. Reading them in the query
    // the sweep already makes is what keeps the tally free.
    await service.sweep(NOW);

    const [{ select }] = prisma.run.findMany.mock.calls[0];
    expect(select.runner.select.capability.select.rateLimitSignal).toBe(true);
    expect(select.workOrder.select.branch).toBe(true);
  });

  it('tallies a full-streaming and a near-zero-streaming runner side by side', async () => {
    withLiveRuns([
      // Quiet enough not to be judged silent, so the tally is about capability
      // rather than about this tick's findings.
      runRow({ lastEventAt: new Date(NOW.getTime() - 5_000) }),
      runRow({
        id: '018f2c31-7a4e-7c3b-9f21-000000000002',
        runnerKey: 'dark-runner',
        lastEventAt: new Date(NOW.getTime() - 5_000),
        events: [{ source: 'git' }],
        runner: {
          capability: { streamingFidelity: 'none', rateLimitSignal: 'none' },
        },
      }),
    ]);

    const result = await service.sweep(NOW);

    expect(result.checkCoverage['loop-detection']).toEqual({
      active: 1,
      degraded: 0,
      unavailable: 1,
    });
    expect(result.checkCoverage['rate-limit-parking']).toEqual({
      active: 1,
      degraded: 0,
      unavailable: 1,
    });
    expect(result.checkCoverage['silence-detection']).toEqual({
      active: 1,
      degraded: 1,
      unavailable: 0,
    });
  });

  it('reports every check even when the fleet is empty', async () => {
    // A missing key would read as zero unavailable, which is the reassuring
    // reading of "not measured".
    const result = await service.sweep(NOW);

    expect(Object.keys(result.checkCoverage).sort()).toEqual(
      [...WATCHDOG_CHECKS].sort(),
    );
  });

  it('counts a standing gap that loopCheckUnavailable does not', async () => {
    // The two answer different questions on purpose. A run already judged
    // silent is skipped by the loop check — so it is not counted there — but
    // its runner still cannot support loop detection, and the tally says so.
    withLiveRuns([
      runRow({
        runnerKey: 'dark-runner',
        lastEventAt: new Date(NOW.getTime() - 200 * 60_000),
        runner: {
          capability: { streamingFidelity: 'none', rateLimitSignal: 'none' },
        },
      }),
    ]);

    const result = await service.sweep(NOW);

    expect(result.silentRuns).toBe(1);
    expect(result.loopCheckUnavailable).toBe(0);
    expect(result.checkCoverage['loop-detection'].unavailable).toBe(1);
  });
});
