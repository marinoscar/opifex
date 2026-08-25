import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { EscalationsService } from '../escalations/escalations.service';
import type { PrismaService } from '../prisma/prisma.service';
import {
  EMPTY_FLEET_SUMMARY,
  EMPTY_FLEET_TICKS_BEFORE_ESCALATION,
  FleetStateService,
} from './fleet-state.service';

/** A registered, capable, enabled runner row — as `check()` reads it. */
function runnerRow(overrides: Record<string, unknown> = {}) {
  return {
    key: 'claude-code-local',
    displayName: 'Claude Code (local)',
    version: '2.1.223',
    enabled: true,
    capability: {
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
    ...overrides,
  };
}

describe('FleetStateService', () => {
  let findMany: jest.Mock;
  let raiseSystemOnce: jest.Mock;
  let resolveSystem: jest.Mock;
  let dispatchEnabled: boolean;

  function buildPrisma(): PrismaService {
    return {
      runner: { findMany },
    } as unknown as PrismaService;
  }

  function buildConfig(): ConfigService {
    return {
      get: (key: string) =>
        key === 'dispatch.enabled' ? dispatchEnabled : undefined,
    } as unknown as ConfigService;
  }

  function buildEscalations(): EscalationsService {
    return {
      raiseSystemOnce,
      resolveSystem,
    } as unknown as EscalationsService;
  }

  function build(): FleetStateService {
    return new FleetStateService(
      buildPrisma(),
      buildConfig(),
      buildEscalations(),
    );
  }

  beforeEach(() => {
    findMany = jest.fn().mockResolvedValue([runnerRow()]);
    raiseSystemOnce = jest
      .fn()
      .mockResolvedValue({ id: 'escalation-1', deduplicated: false });
    resolveSystem = jest.fn().mockResolvedValue(0);
    dispatchEnabled = true;
    // One process's worth of log calls per test would otherwise be noise;
    // silenced the same way `runner-registration.task.spec.ts` does it,
    // against `Logger.prototype` so every instance this file constructs is
    // covered regardless of when it was `new`'d.
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('check()', () => {
    it('registers rows with no capability manifest but excludes them from routable', async () => {
      // The reason the alarm reads `routable` rather than `registered`: a row
      // that exists but never got a manifest is the same failure by another
      // route (`DispatchService.loadPool` drops it too), and the fleet report
      // must agree with routing about who counts.
      findMany.mockResolvedValue([
        runnerRow({ key: 'has-manifest' }),
        runnerRow({ key: 'no-manifest', capability: null }),
      ]);

      const report = await build().check();

      expect(report.checked).toBe(true);
      if (!report.checked) return;
      expect(report.registered).toBe(2);
      expect(report.routable).toBe(1);
      expect(report.unroutable).toEqual(['no-manifest']);
      expect(report.runners.map((r) => r.key)).toEqual(['has-manifest']);
    });

    it('degrades to checked: false on a throw anywhere in the read, not just the query', async () => {
      // The try wraps the WHOLE projection, not merely the `findMany` await —
      // these endpoints are `@Public()`, and a throw escaping here would 500
      // the very tool an operator uses to diagnose the outage.
      findMany.mockResolvedValue([
        {
          key: 'exploding-row',
          get capability(): never {
            throw new Error('manifest column exploded');
          },
        },
      ]);

      const report = await build().check();

      expect(report.checked).toBe(false);
      if (report.checked) return;
      expect(report.error).toContain('manifest column exploded');
    });

    it('also degrades to checked: false when the query itself rejects', async () => {
      findMany.mockRejectedValue(new Error('connection refused'));

      const report = await build().check();

      expect(report.checked).toBe(false);
      if (report.checked) return;
      expect(report.error).toContain('connection refused');
    });
  });

  describe('observe()', () => {
    // Several cases below need ONE instance across several calls to
    // `observe()`, since the tick counter is process-local state (see the
    // class doc comment on `emptyTicks`). Built fresh per test, same as
    // `build()` elsewhere in this file, just held across the whole test.
    let service: FleetStateService;
    beforeEach(() => {
      service = build();
    });

    it('does not escalate before the threshold, escalates at the threshold, and stays deduplicated past it', async () => {
      findMany.mockResolvedValue([]); // empty fleet, every tick

      // Ticks 1..N-1: below EMPTY_FLEET_TICKS_BEFORE_ESCALATION (5).
      for (
        let tick = 1;
        tick < EMPTY_FLEET_TICKS_BEFORE_ESCALATION;
        tick += 1
      ) {
        const observation = await service.observe();
        expect(observation.state).toBe('empty');
        expect(observation.escalated).toBe(false);
      }
      expect(raiseSystemOnce).not.toHaveBeenCalled();

      // Tick N: the threshold itself.
      const atThreshold = await service.observe();
      expect(atThreshold.emptyTicks).toBe(EMPTY_FLEET_TICKS_BEFORE_ESCALATION);
      expect(atThreshold.escalated).toBe(true);
      expect(raiseSystemOnce).toHaveBeenCalledTimes(1);
      expect(raiseSystemOnce).toHaveBeenCalledWith(
        expect.objectContaining({ summary: EMPTY_FLEET_SUMMARY }),
      );

      // Past N: still empty, still fires the write, but the escalation
      // service itself is the one deduplicating — this service just asks
      // again and reports what it was told.
      raiseSystemOnce.mockResolvedValue({
        id: 'escalation-1',
        deduplicated: true,
      });
      const pastThreshold = await service.observe();
      expect(pastThreshold.escalated).toBe(false);
      expect(raiseSystemOnce).toHaveBeenCalledTimes(2);
    });

    it('does not escalate a fleet of registered-but-disabled runners', async () => {
      // A human's own switch must never page them (#277's own acceptance
      // criterion). `hasEmptyFleet` reads cardinality, not the enabled flag —
      // a disabled runner still has a row, so `routable` is nonzero and the
      // fleet is never "empty" at all.
      findMany.mockResolvedValue([runnerRow({ enabled: false })]);

      for (
        let tick = 0;
        tick < EMPTY_FLEET_TICKS_BEFORE_ESCALATION + 5;
        tick += 1
      ) {
        const observation = await service.observe();
        expect(observation.state).toBe('converged');
      }

      expect(raiseSystemOnce).not.toHaveBeenCalled();
    });

    it('does not escalate when DISPATCH_ENABLED is off, however long the fleet stays empty', async () => {
      dispatchEnabled = false;
      findMany.mockResolvedValue([]);

      for (
        let tick = 0;
        tick < EMPTY_FLEET_TICKS_BEFORE_ESCALATION + 20;
        tick += 1
      ) {
        await service.observe();
      }

      expect(raiseSystemOnce).not.toHaveBeenCalled();
    });

    it('never escalates a blip that converges before the threshold', async () => {
      findMany.mockResolvedValue([]);

      for (
        let tick = 1;
        tick < EMPTY_FLEET_TICKS_BEFORE_ESCALATION;
        tick += 1
      ) {
        await service.observe();
      }

      // The fleet recovers on tick 4, one short of the threshold.
      findMany.mockResolvedValue([runnerRow()]);
      const converged = await service.observe();

      expect(converged.state).toBe('converged');
      expect(converged.emptyTicks).toBe(0);
      expect(raiseSystemOnce).not.toHaveBeenCalled();
    });

    it('an unreadable database advances neither the empty counter nor convergence', async () => {
      // Tick 1: fleet genuinely empty.
      findMany.mockResolvedValue([]);
      const first = await service.observe();
      expect(first.state).toBe('empty');
      expect(first.emptyTicks).toBe(1);

      // Tick 2: the database cannot be read at all. Not counted as an empty
      // tick (it is a different failure, already reported by the database
      // indicator) and not counted as a converged one either.
      findMany.mockRejectedValue(new Error('connection refused'));
      const second = await service.observe();
      expect(second.state).toBe('unknown');
      expect(second.emptyTicks).toBe(1); // unchanged from tick 1

      // Tick 3: readable again, and still empty. If the unknown tick had
      // silently advanced the counter this would read 3, not 2.
      findMany.mockResolvedValue([]);
      const third = await service.observe();
      expect(third.state).toBe('empty');
      expect(third.emptyTicks).toBe(2);
    });

    it('resolves once at boot on the very first converged observation, clearing a stale escalation', async () => {
      // A fresh process has no memory of what a PREVIOUS process left behind.
      // The first healthy tick must clear it once, or the dedupe key on
      // `raiseSystemOnce` would stay outstanding forever and silently disarm
      // every future empty-fleet escalation.
      findMany.mockResolvedValue([runnerRow()]);

      const first = await service.observe();
      expect(first.state).toBe('converged');
      expect(resolveSystem).toHaveBeenCalledTimes(1);
      expect(resolveSystem).toHaveBeenCalledWith(EMPTY_FLEET_SUMMARY);
    });

    it('does not write to resolve on every subsequent converged tick forever', async () => {
      findMany.mockResolvedValue([runnerRow()]);

      await service.observe(); // boot clear
      await service.observe();
      await service.observe();

      expect(resolveSystem).toHaveBeenCalledTimes(1);
    });

    it('resolves again on the transition out of a genuine empty streak', async () => {
      // First converged tick already resolves once (boot clear).
      findMany.mockResolvedValue([runnerRow()]);
      await service.observe();
      expect(resolveSystem).toHaveBeenCalledTimes(1);

      // Now a real empty streak, then recovery — a second, distinct write.
      findMany.mockResolvedValue([]);
      await service.observe();
      await service.observe();

      findMany.mockResolvedValue([runnerRow()]);
      await service.observe();

      expect(resolveSystem).toHaveBeenCalledTimes(2);
    });
  });
});
