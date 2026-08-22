import { PrismaService } from '../prisma/prisma.service';
import { WatchdogService } from './watchdog.service';

const NOW = new Date('2026-08-21T12:00:00Z');

function runRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '018f2c31-7a4e-7c3b-9f21-4d5e6a7b8c9d',
    status: 'running',
    startedAt: new Date(NOW.getTime() - 120 * 60_000),
    lastEventAt: new Date(NOW.getTime() - 10 * 60_000),
    runnerKey: 'claude-code-local',
    runner: { capability: { streamingFidelity: 'full' } },
    workOrder: {
      identity: 'wo_opifex_312_a3f91c2_a1',
      issueNumber: 312,
      repository: { owner: 'marinoscar', name: 'opifex' },
    },
    ...overrides,
  };
}

describe('WatchdogService', () => {
  let prisma: { run: { findMany: jest.Mock } };
  let service: WatchdogService;

  beforeEach(() => {
    prisma = { run: { findMany: jest.fn().mockResolvedValue([runRow()]) } };
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
      expect(select.runner.select.capability.select.streamingFidelity).toBe(true);
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

      expect(result.actions.map((a) => a.type)).toEqual(['kill-and-re-run', 'escalate']);
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
      prisma.run.findMany.mockResolvedValue([
        runRow({ lastEventAt: new Date(NOW.getTime() - 5_000) }),
      ]);

      const result = await service.sweep(NOW);

      expect(result).toMatchObject({ runsJudged: 1, silentRuns: 0 });
      expect(result.actions).toEqual([]);
    });
  });

  describe('capability-derived thresholds, end to end', () => {
    it('spares a non-streaming runner at an age that would kill a streaming one', async () => {
      prisma.run.findMany.mockResolvedValue([
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
      prisma.run.findMany.mockResolvedValue([
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

  describe('determinism', () => {
    it('takes now as a parameter, so the same inputs give the same verdicts', async () => {
      const first = await service.sweep(NOW);
      const second = await service.sweep(NOW);

      expect(second.actions).toEqual(first.actions);
    });
  });
});
