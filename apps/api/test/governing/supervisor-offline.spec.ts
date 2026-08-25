import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { ConfigService } from '@nestjs/config';

import { decideBudgetOverrun } from '../../src/budget/budget-overrun';
import { decideDispatch } from '../../src/dispatch/dispatch-policy';
import { DecisionLogService } from '../../src/supervisor/decision-log/decision-log.service';
import { SnapshotService } from '../../src/supervisor/snapshot/snapshot.service';
import { SupervisorService } from '../../src/supervisor/invocation/supervisor.service';
import type { SupervisorSpendCeilingService } from '../../src/supervisor/invocation/supervisor-spend-ceiling';
import type { SupervisorSpendLedgerService } from '../../src/supervisor/invocation/supervisor-spend-ledger.service';
import { decideParking } from '../../src/watchdog/blocked-parking';
import { detectSilentRuns } from '../../src/watchdog/silent-detection';

/**
 * **The governing test: if the AI supervisor is offline, the factory keeps
 * running.** (#94, VISION §7.)
 *
 * VISION §7 states it in bold, and it is the single property that keeps the
 * supervisor from becoming the recursion trap that section warns about — "a
 * non-deterministic supervisor that can itself stall, exhaust quota, and behave
 * unpredictably, supervising components that stall and exhaust quota, leaving a
 * human to supervise *it*."
 *
 * > Dumber about diagnosis. Still correct about execution.
 *
 * ## Why this is a test and not a paragraph
 *
 * #94 names the failure mode precisely: stated as an aspiration the property
 * "will erode — one convenient dependency at a time, each individually
 * reasonable." The PR that makes an execution path consult a supervisor
 * proposal will look sensible in isolation, and it is exactly the PR this test
 * exists to fail.
 *
 * ## The two halves
 *
 * **Structural.** No file on VISION §7's left-hand column may import anything
 * from `src/supervisor/`. This is the half that catches the erosion, because it
 * fires on the import rather than on the behaviour, and an import is what
 * arrives first.
 *
 * **Behavioural.** Every left-column behaviour is exercised while a supervisor
 * is present and BROKEN — disabled, throwing, and hanging — and asserted to
 * produce the same verdict it produces with no supervisor at all. That covers
 * #94's fourth criterion: "a supervisor that errors, stalls, or exhausts its
 * budget is covered — not just one cleanly disabled."
 *
 * ## When this fails
 *
 * Do not adjust the test to accommodate the change. The question to answer is
 * whether the factory still runs without the supervisor. If it does not, the
 * change is the bug.
 */

const SRC = join(__dirname, '..', '..', 'src');

/**
 * VISION §7's left-hand column, one entry per row of the table.
 *
 * The directories are the code that implements each row. Naming them
 * individually rather than scanning everything is deliberate: #94 requires
 * that a failure "names the specific behaviour that became
 * supervisor-dependent", and a single assertion over the whole tree would say
 * only that something, somewhere, now depends on the supervisor.
 */
const HOT_PATH: readonly { behaviour: string; dirs: string[] }[] = [
  { behaviour: 'Dispatch decisions', dirs: ['dispatch'] },
  { behaviour: 'Stall detection (event-age thresholds)', dirs: ['watchdog'] },
  { behaviour: 'Rate-limit parking and auto-resume', dirs: ['watchdog'] },
  { behaviour: 'Budget and timeout enforcement', dirs: ['budget'] },
  { behaviour: 'Retry counters, quarantine', dirs: ['reconciler'] },
  { behaviour: 'State transitions', dirs: ['run-events', 'work-orders'] },
  {
    behaviour: 'Escalation to a human',
    dirs: ['escalations', 'notifications'],
  },
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts'))
      out.push(full);
  }
  return out;
}

/** Files under `dir` whose import statements reach into `src/supervisor`. */
function supervisorImporters(dir: string): string[] {
  return sourceFiles(join(SRC, dir)).filter((file) => {
    const source = readFileSync(file, 'utf8');
    return [...source.matchAll(/^\s*import\s[\s\S]*?from\s+'([^']+)';/gm)].some(
      (match) => /(^|\/)supervisor(\/|$)/.test(match[1]),
    );
  });
}

describe('GOVERNING TEST: the factory runs with the supervisor offline (#94)', () => {
  describe('structurally — no hot-path code imports the supervisor', () => {
    it('finds hot-path sources at all', () => {
      // Guards every assertion below from passing vacuously, which is how a
      // structural test quietly stops testing anything.
      const total = HOT_PATH.flatMap((row) => row.dirs)
        .map((dir) => sourceFiles(join(SRC, dir)).length)
        .reduce((a, b) => a + b, 0);

      expect(total).toBeGreaterThan(20);
    });

    it.each(HOT_PATH.map((row) => [row.behaviour, row.dirs] as const))(
      '%s does not depend on the supervisor',
      (_behaviour, dirs) => {
        const offenders = dirs.flatMap((dir) => supervisorImporters(dir));
        expect(offenders).toEqual([]);
      },
    );

    it('allows the run summary to read the supervisor, because it is not the hot path', () => {
      // #92 puts the diagnosis on the run-summary comment, and the summary is
      // a SWEEP over concluded runs — deliberately off the path a runner posts
      // into. The edge runs run-summary → supervisor and never the reverse,
      // and `diagnosisFor` swallows a decision-log failure so the summary goes
      // out without a hypothesis rather than not at all.
      expect(supervisorImporters('run-summary').length).toBeGreaterThan(0);
    });
  });

  describe('behaviourally — a broken supervisor changes no verdict', () => {
    const NOW = new Date('2026-08-24T12:00:00.000Z');

    /**
     * A spend ceiling the supervisor is nowhere near, and one that is absent.
     *
     * Since ADR-0017 the supervisor checks its own ceiling before it does
     * anything, so every construction below has to say which of the two it is
     * — and "no ceiling at all" became one of the ways a supervisor can be
     * broken, which is why it appears in the list below as its own case.
     */
    const ceiling = (limitUsd: number | null) =>
      ({
        value: { limitUsd, windowDays: 1, malformed: null },
      }) as unknown as SupervisorSpendCeilingService;

    const ledger = (reportedUsd = 0) =>
      ({
        tally: jest.fn().mockResolvedValue({
          reportedUsd,
          unpricedCalls: 0,
          invocations: 0,
          window: { from: NOW, to: NOW, days: 1 },
        }),
      }) as unknown as SupervisorSpendLedgerService;

    /**
     * Four ways a supervisor can be broken, per #94's fourth criterion.
     *
     * Each is a real `SupervisorService` — not a stub — because the point is
     * that the object EXISTS and is unusable, which is the state a deployment
     * is actually in when the model endpoint is down.
     *
     * The fourth was added with ADR-0017 and is named directly by #94: "a
     * supervisor that errors, stalls, or **exhausts its budget** is covered".
     * A supervisor refusing every tick on its own spend ceiling is exactly
     * that, and the factory must not notice.
     */
    function brokenSupervisors(): {
      how: string;
      supervisor: SupervisorService;
    }[] {
      const snapshots = {
        collect: jest.fn().mockRejectedValue(new Error('database is down')),
        render: jest.fn(),
      } as unknown as SnapshotService;
      const log = {
        record: jest
          .fn()
          .mockResolvedValue({ invocationId: 'i', proposalIds: [] }),
      } as unknown as DecisionLogService;
      const hangingLog = {
        record: jest.fn(() => new Promise(() => undefined)),
      } as unknown as DecisionLogService;

      const config = (enabled: boolean) =>
        ({
          get: (key: string) =>
            key === 'supervisor.enabled' ? enabled : undefined,
        }) as unknown as ConfigService;

      return [
        {
          how: 'disabled by configuration',
          supervisor: new SupervisorService(
            config(false),
            snapshots,
            log,
            ceiling(5),
            ledger(),
          ),
        },
        {
          how: 'enabled but erroring',
          supervisor: new SupervisorService(
            config(true),
            snapshots,
            log,
            ceiling(5),
            ledger(),
          ),
        },
        {
          how: 'enabled but hanging',
          supervisor: new SupervisorService(
            config(true),
            snapshots,
            hangingLog,
            ceiling(5),
            ledger(),
          ),
        },
        {
          how: 'enabled with no spend ceiling configured',
          supervisor: new SupervisorService(
            config(true),
            snapshots,
            log,
            ceiling(null),
            ledger(),
          ),
        },
        {
          how: 'enabled and over its spend ceiling',
          supervisor: new SupervisorService(
            config(true),
            snapshots,
            log,
            ceiling(5),
            ledger(500),
          ),
        },
      ];
    }

    /**
     * Start every broken supervisor and do not await it.
     *
     * The hanging one never settles, which is the point: the assertions below
     * run while it is still outstanding. If any hot-path decision were waiting
     * on a supervisor, this suite would time out rather than fail — and a
     * timeout is still a failure, which is the behaviour #94 wants.
     */
    function withBrokenSupervisorsRunning<T>(assert: () => T): T {
      for (const { supervisor } of brokenSupervisors()) {
        void supervisor.invoke(NOW).catch(() => undefined);
      }
      return assert();
    }

    it('still dispatches', () => {
      const pool = [
        {
          capabilities: {
            key: 'claude-code-local',
            displayName: 'Claude Code (local)',
            version: '2.1.223',
            schemaVersion: '1.0.0',
            invocationModel: 'process',
            executionLocus: 'own_infrastructure',
            streamingFidelity: 'full',
            rateLimitSignal: 'structured',
            stabilityTier: 'stable',
            reportsCost: true,
            resumable: false,
            maxConcurrency: 2,
            branchPatterns: ['factory/*'],
            manifest: {},
          },
          enabled: true,
          liveRuns: 0,
        },
      ];

      const decision = withBrokenSupervisorsRunning(() =>
        decideDispatch(
          { needs: [], identity: 'wo_opifex_1_aaaaaaa_a1' },
          pool as never,
          { globalMaxConcurrent: null, globalLiveRuns: 0 },
        ),
      );

      expect(decision.outcome).toBe('dispatch');
      expect(decision.runnerKey).toBe('claude-code-local');
    });

    it('still detects a stalled run', () => {
      const verdicts = withBrokenSupervisorsRunning(() =>
        detectSilentRuns(
          [
            {
              runId: 'run-1',
              workOrderIdentity: 'wo_1',
              repository: 'marinoscar/opifex',
              issueNumber: 1,
              status: 'running',
              startedAt: new Date(NOW.getTime() - 60 * 60 * 1000),
              lastEventAt: new Date(NOW.getTime() - 60 * 60 * 1000),
              lastEventSource: 'runner',
              fidelity: 'full',
            } as never,
          ],
          NOW,
        ),
      );

      expect(verdicts).toHaveLength(1);
      expect(verdicts[0].runId).toBe('run-1');
    });

    it('still parks a rate-limited run and schedules its resume', () => {
      const resetAt = new Date(NOW.getTime() + 30 * 60 * 1000);

      const decision = withBrokenSupervisorsRunning(() =>
        decideParking(
          {
            runId: 'run-2',
            workOrderIdentity: 'wo_2',
            repository: 'marinoscar/opifex',
            issueNumber: 2,
            blockedSince: NOW,
            resetAt,
            reason: 'rate limited',
            resumesAt: null,
          },
          NOW,
        ),
      );

      expect(decision.kind).toBe('park');
    });

    it('still resumes a parked run when its time arrives', () => {
      const decision = withBrokenSupervisorsRunning(() =>
        decideParking(
          {
            runId: 'run-3',
            workOrderIdentity: 'wo_3',
            repository: 'marinoscar/opifex',
            issueNumber: 3,
            blockedSince: new Date(NOW.getTime() - 60 * 60 * 1000),
            resetAt: new Date(NOW.getTime() - 30 * 60 * 1000),
            reason: 'rate limited',
            resumesAt: new Date(NOW.getTime() - 1000),
          },
          NOW,
        ),
      );

      expect(decision.kind).toBe('resume');
    });

    it('still enforces a spend ceiling', () => {
      const verdict = withBrokenSupervisorsRunning(() =>
        decideBudgetOverrun({ costUsd: 12, ceilingUsd: 10, runIsLive: true }),
      );

      expect(verdict.over).toBe(true);
    });

    it('still escalates a run with no reset time that has waited too long', () => {
      const decision = withBrokenSupervisorsRunning(() =>
        decideParking(
          {
            runId: 'run-4',
            workOrderIdentity: 'wo_4',
            repository: 'marinoscar/opifex',
            issueNumber: 4,
            blockedSince: new Date(NOW.getTime() - 4 * 60 * 60 * 1000),
            resetAt: null,
            reason: 'rate limited, no reset supplied',
            resumesAt: null,
          },
          NOW,
        ),
      );

      // VISION §9's third case: the system cannot wait this one out, so a
      // human is told. That path must not need a diagnosis to fire.
      expect(decision.kind).toBe('escalate');
    });

    it('still writes its records — a failing supervisor logs itself and nothing else', async () => {
      // The one thing a broken supervisor DOES write is its own row, because
      // #90 requires the decision log have no gaps. It writes nothing about
      // any run, work order, or escalation.
      const record = jest
        .fn()
        .mockResolvedValue({ invocationId: 'inv-1', proposalIds: [] });
      const brokenSupervisor = (spendCeiling: SupervisorSpendCeilingService) =>
        new SupervisorService(
          {
            get: (key: string) =>
              key === 'supervisor.enabled' ? true : undefined,
          } as unknown as ConfigService,
          {
            collect: jest.fn().mockRejectedValue(new Error('database is down')),
            render: jest.fn(),
          } as unknown as SnapshotService,
          { record } as unknown as DecisionLogService,
          spendCeiling,
          ledger(),
        );

      await expect(brokenSupervisor(ceiling(5)).invoke(NOW)).resolves.toBe(
        'inv-1',
      );

      expect(record).toHaveBeenCalledTimes(1);
      expect(record.mock.calls[0][0].outcome).toBe('failed');
      expect(record.mock.calls[0][1] ?? []).toEqual([]);

      // And the ADR-0017 shape of the same property: a supervisor with no
      // ceiling configured writes ONE row saying so, about itself, and
      // nothing about any run, work order or escalation. It stops running —
      // that is the point of the decision — and the factory does not notice.
      record.mockClear();
      await expect(brokenSupervisor(ceiling(null)).invoke(NOW)).resolves.toBe(
        'inv-1',
      );

      expect(record).toHaveBeenCalledTimes(1);
      expect(record.mock.calls[0][0].outcome).toBe('skipped_budget');
      expect(record.mock.calls[0][0].failureReason).toContain(
        'SUPERVISOR_HARD_SPEND_CEILING_USD',
      );
      expect(record.mock.calls[0][1] ?? []).toEqual([]);
    });

    it('never throws out of an invocation, whatever is broken', async () => {
      // A supervisor that threw into the scheduler would take the run-summary
      // sweep and the reconciler cleanup with it — the factory stopping
      // because the ADVISORY half fell over is precisely the recursion trap.
      for (const { how, supervisor } of brokenSupervisors()) {
        if (how === 'enabled but hanging') continue;
        await expect(supervisor.invoke(NOW)).resolves.not.toThrow();
      }
    });
  });
});
