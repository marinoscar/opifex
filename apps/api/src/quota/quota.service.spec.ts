import { Logger } from '@nestjs/common';

import type { PrismaService } from '../prisma/prisma.service';
import type { RunnerQuotaObservation } from '../runners/runner.types';
import { QuotaService } from './quota.service';

/**
 * Prisma is a double: what is under test is which windows get written and what
 * the reading claims, not whether Postgres can store a row.
 */
describe('QuotaService', () => {
  const NOW = new Date('2026-08-25T12:00:00.000Z');
  const RESETS_AT = new Date('2026-08-25T15:00:00.000Z');

  let upsert: jest.Mock;
  let findUnique: jest.Mock;
  let findMany: jest.Mock;
  let eventFindMany: jest.Mock;
  let runFindMany: jest.Mock;
  let service: QuotaService;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    upsert = jest.fn().mockResolvedValue({});
    findUnique = jest.fn().mockResolvedValue(null);
    findMany = jest.fn().mockResolvedValue([]);
    eventFindMany = jest.fn().mockResolvedValue([]);
    runFindMany = jest.fn().mockResolvedValue([]);

    service = new QuotaService({
      quotaWindow: { upsert, findUnique, findMany },
      runEvent: { findMany: eventFindMany },
      run: { findMany: runFindMany },
    } as unknown as PrismaService);
  });

  afterEach(() => jest.restoreAllMocks());

  function sighting(
    overrides: Partial<RunnerQuotaObservation> = {},
  ): RunnerQuotaObservation {
    return {
      runnerKey: 'claude-code-local',
      kind: 'five_hour',
      resetsAt: RESETS_AT,
      pressure: 'allowed',
      observedAt: new Date('2026-08-25T11:00:00.000Z'),
      ...overrides,
    };
  }

  describe('record', () => {
    it('writes one row per window however many lines carried it', async () => {
      const written = await service.record([
        sighting(),
        sighting({ observedAt: new Date('2026-08-25T11:01:00.000Z') }),
      ]);

      expect(written).toBe(1);
      expect(upsert).toHaveBeenCalledTimes(1);
      expect(upsert.mock.calls[0][0].create.observations).toBe(2);
    });

    it('does nothing at all for an empty batch', async () => {
      // The common case by far: most polls see no rate-limit line.
      expect(await service.record([])).toBe(0);
      expect(upsert).not.toHaveBeenCalled();
    });

    it('keeps a peak already stored rather than letting a calm batch erase it', async () => {
      // The peak is the worst reading EVER seen for this window. A batch of
      // `allowed` sightings after an exhaustion an hour ago must not overwrite
      // the fact that the wall was hit.
      findUnique.mockResolvedValue({ peakPressure: 'exhausted' });

      await service.record([sighting({ pressure: 'allowed' })]);

      expect(upsert.mock.calls[0][0].update.peakPressure).toBe('exhausted');
      expect(upsert.mock.calls[0][0].update.pressure).toBe('allowed');
    });

    it('loses one bad window without losing the others, and never throws', async () => {
      // This runs inside the poller's tick. A quota write that killed a tick
      // would stop events reaching the control plane for the whole fleet —
      // trading the signal this adds for the one everything depends on.
      upsert
        .mockRejectedValueOnce(new Error('no runners row yet'))
        .mockResolvedValueOnce({});

      const written = await service.record([
        sighting({ kind: 'five_hour' }),
        sighting({ kind: 'weekly' }),
      ]);

      expect(written).toBe(1);
    });
  });

  describe('readings', () => {
    const window = {
      runnerKey: 'claude-code-local',
      kind: 'five_hour',
      resetsAt: RESETS_AT,
      pressure: 'allowed',
      peakPressure: 'warning',
      firstObservedAt: new Date('2026-08-25T09:00:00.000Z'),
      lastObservedAt: new Date('2026-08-25T11:55:00.000Z'),
      observations: 12,
    };

    /** A run row as `loadConsumption` selects it. */
    function run(startedAt: string, costUsd: number | null = null) {
      return {
        runnerKey: window.runnerKey,
        startedAt: new Date(startedAt),
        costUsd,
      };
    }

    /** A cost-bearing event row as `loadConsumption` selects it. */
    function event(
      occurredAt: string,
      overrides: {
        costUsd?: { toNumber: () => number } | null;
        tokensInput?: number | null;
        tokensOutput?: number | null;
      } = {},
    ) {
      return {
        occurredAt: new Date(occurredAt),
        costUsd: null,
        tokensInput: null,
        tokensOutput: null,
        ...overrides,
        run: { runnerKey: window.runnerKey },
      };
    }

    it('reports no runner at all when nothing has been observed', async () => {
      // #231's last acceptance criterion: a fleet whose runners report no
      // quota still works, with the metric null throughout. An unobserved
      // runner is ABSENT, not present with zeroes — a row of zeroes is a claim
      // nobody made.
      expect(await service.readings(NOW)).toEqual([]);
    });

    it('never computes a burn fraction, and says so with a field', async () => {
      // The whole argument, pinned. No capacity is published to divide by
      // (#102), and the numerator is Opifex's share of a subscription VISION
      // §11 shares with the operator's interactive use. Carried as an explicit
      // null rather than omitted: an absent key reads as an oversight.
      findMany.mockResolvedValue([window]);

      const [{ windows }] = await service.readings(NOW);

      expect(windows[0].burnFraction).toBeNull();
      expect(Object.keys(windows[0])).toContain('burnFraction');
      expect(windows[0].basis).toContain('not the window');
    });

    it('sums consumption over the vendor window, clipped at now', async () => {
      // A window runs into the future, and its span starts at a real
      // boundary — 15:00 reset minus the five hours the label names. Rows
      // outside that span belong to a different window and must not be folded
      // into this one, which is the whole reason the union span asked of
      // Postgres is never the span that is summed.
      findMany.mockResolvedValue([window]);
      runFindMany.mockResolvedValue([
        run('2026-08-25T09:30:00.000Z'), // before the span
        run('2026-08-25T10:30:00.000Z'),
        run('2026-08-25T11:30:00.000Z'),
      ]);
      eventFindMany.mockResolvedValue([
        event('2026-08-25T09:45:00.000Z', {
          costUsd: { toNumber: () => 9.99 },
        }),
        event('2026-08-25T10:30:00.000Z', { costUsd: { toNumber: () => 1.5 } }),
        event('2026-08-25T11:30:00.000Z', {
          costUsd: { toNumber: () => 2.75 },
        }),
      ]);

      const [{ windows }] = await service.readings(NOW);

      expect(windows[0].startedAt).toBe('2026-08-25T10:00:00.000Z');
      expect(windows[0].opifexConsumption.runs).toBe(2);
      expect(windows[0].opifexConsumption.reportedUsd).toBe(4.25);
    });

    it('reports an unreported cost as null, never as zero', async () => {
      // The rule `Run.costUsd` follows: a runner that cannot report cost must
      // not look like one that spent nothing.
      findMany.mockResolvedValue([window]);
      runFindMany.mockResolvedValue([
        run('2026-08-25T10:30:00.000Z'),
        run('2026-08-25T10:31:00.000Z'),
        run('2026-08-25T10:32:00.000Z'),
        run('2026-08-25T10:33:00.000Z'),
      ]);

      const [{ windows }] = await service.readings(NOW);

      expect(windows[0].opifexConsumption.reportedUsd).toBeNull();
      expect(windows[0].opifexConsumption.runs).toBe(4);
      expect(windows[0].opifexConsumption.runsWithoutCost).toBe(4);
    });

    it('reports a measured cost, and names whose consumption it is', async () => {
      findMany.mockResolvedValue([window]);
      eventFindMany.mockResolvedValue([
        event('2026-08-25T10:30:00.000Z', {
          costUsd: { toNumber: () => 4.25 },
          tokensInput: 1000,
          tokensOutput: 250,
        }),
      ]);

      const [{ windows }] = await service.readings(NOW);

      expect(windows[0].opifexConsumption.reportedUsd).toBe(4.25);
      expect(windows[0].opifexConsumption.tokensInput).toBe(1000);
      // Named for whose it is at every layer it crosses, on the principle
      // `SpendTally.estimatedUsd` follows.
      expect(windows[0].basis).toContain("Opifex's own runs");
    });

    it('keeps the peak beside the current reading', async () => {
      findMany.mockResolvedValue([window]);

      const [{ windows }] = await service.readings(NOW);

      expect(windows[0].pressure).toBe('allowed');
      expect(windows[0].peakPressure).toBe('warning');
    });

    it('returns every live window a runner holds, soonest reset first', async () => {
      // #301. This used to keep only the newest, which is how an exhausted
      // five_hour window ended up hidden behind a healthy weekly one.
      findMany.mockResolvedValue([
        window,
        {
          ...window,
          kind: 'weekly',
          resetsAt: new Date('2026-08-28T20:00:00.000Z'),
        },
      ]);

      const [runner] = await service.readings(NOW);

      expect(runner.windows.map((entry) => entry.windowKind)).toEqual([
        'five_hour',
        'weekly',
      ]);
    });

    it('never hides an exhausted window behind a healthy longer one', async () => {
      // The defect itself. The weekly row resets later and reads `allowed`;
      // the five_hour row is the one the operator needs to see.
      findMany.mockResolvedValue([
        { ...window, pressure: 'exhausted' },
        {
          ...window,
          kind: 'weekly',
          pressure: 'allowed',
          resetsAt: new Date('2026-08-28T20:00:00.000Z'),
        },
      ]);

      const [runner] = await service.readings(NOW);

      // The binding answer, from routing's own `meterQuotaPosition` rather
      // than a second implementation of the rule.
      expect(runner.position).toEqual({
        exhausted: true,
        resumesAt: RESETS_AT.toISOString(),
        basis: expect.stringContaining('five_hour'),
      });
      expect(runner.windows).toHaveLength(2);
    });

    it('reports an unknown position rather than a healthy one', async () => {
      // A stale `allowed` is no news about a subscription VISION §11 shares
      // with the operator's interactive use. The window is still listed with
      // its `lastObservedAt`; the position declines to vouch for it.
      findMany.mockResolvedValue([
        { ...window, lastObservedAt: new Date('2026-08-25T09:00:00.000Z') },
      ]);

      const [runner] = await service.readings(NOW);

      expect(runner.position).toBeNull();
      expect(runner.windows[0].pressure).toBe('allowed');
    });

    it('groups windows under one entry per runner', async () => {
      findMany.mockResolvedValue([
        window,
        { ...window, runnerKey: 'claude-code-cloud' },
      ]);

      const runners = await service.readings(NOW);

      expect(runners.map((entry) => entry.runnerKey)).toEqual([
        'claude-code-local',
        'claude-code-cloud',
      ]);
    });

    it('flags a partial window so the sum is read as a floor', async () => {
      // The label names no length this system knows, so the span starts at the
      // first sighting — anything that ran before it is inside the window and
      // outside the sum.
      findMany.mockResolvedValue([{ ...window, kind: 'lunar_cycle' }]);

      const [{ windows }] = await service.readings(NOW);

      expect(windows[0].partialWindow).toBe(true);
      expect(windows[0].startedAtBasis).toBe('first-observation');
      expect(windows[0].basis).toContain('FLOOR');
    });

    it('asks only for windows that have not rolled yet', async () => {
      await service.readings(NOW);

      expect(findMany.mock.calls[0][0].where).toEqual({
        resetsAt: { gt: NOW },
      });
    });

    it('costs a fixed number of queries however many runners and windows there are', async () => {
      // #301's acceptance criteria. The previous shape ran three aggregates
      // per runner; returning every window would have made that three per
      // WINDOW. One window query plus two batched row reads, always.
      findMany.mockResolvedValue([
        window,
        {
          ...window,
          kind: 'weekly',
          resetsAt: new Date('2026-08-28T20:00:00.000Z'),
        },
        { ...window, runnerKey: 'claude-code-cloud' },
        { ...window, runnerKey: 'codex-local', kind: 'weekly' },
      ]);

      await service.readings(NOW);

      expect(findMany).toHaveBeenCalledTimes(1);
      expect(runFindMany).toHaveBeenCalledTimes(1);
      expect(eventFindMany).toHaveBeenCalledTimes(1);
    });

    it('widens the query to the union span, but sums each window only over its own', async () => {
      // The risky part of `loadConsumption`. A `weekly` row widens what is
      // ASKED of Postgres — `earliest` becomes the weekly start, not the
      // five_hour one — but that union must never leak into what is SUMMED:
      // each window still filters the rows down to its own span in `reading`.
      const weekly = {
        ...window,
        kind: 'weekly',
        resetsAt: new Date('2026-08-28T20:00:00.000Z'), // -> starts 08-21T20:00
      };
      findMany.mockResolvedValue([window, weekly]);
      eventFindMany.mockResolvedValue([
        // Inside the weekly span (08-21T20:00 .. NOW) but BEFORE the
        // five_hour span starts (08-25T10:00) — belongs to weekly alone.
        event('2026-08-23T00:00:00.000Z', { costUsd: { toNumber: () => 3 } }),
        // Inside both spans.
        event('2026-08-25T10:30:00.000Z', { costUsd: { toNumber: () => 1 } }),
      ]);

      const [{ windows }] = await service.readings(NOW);
      const fiveHour = windows.find((w) => w.windowKind === 'five_hour')!;
      const weeklyReading = windows.find((w) => w.windowKind === 'weekly')!;

      // The query itself widened to the longest live window's start.
      expect(eventFindMany.mock.calls[0][0].where.occurredAt.gte).toEqual(
        new Date('2026-08-21T20:00:00.000Z'),
      );

      // But the five_hour reading never sees the early event — it is not in
      // ITS span, regardless of what the union query fetched.
      expect(fiveHour.opifexConsumption.reportedUsd).toBe(1);
      // The weekly reading, whose span really does start that early, sees
      // both.
      expect(weeklyReading.opifexConsumption.reportedUsd).toBe(4);
    });

    it('sums a zero-reporting event with an unreported one as zero, never as null', async () => {
      // The distinction moved from Prisma's `_sum` into hand-written code,
      // which is exactly where a regression would be silent: unreported and
      // zero are different facts (VISION §6), and `0` from one event must
      // survive being folded in with `null` from another.
      findMany.mockResolvedValue([window]);
      eventFindMany.mockResolvedValue([
        event('2026-08-25T10:30:00.000Z', {
          tokensInput: null,
          tokensOutput: null,
        }),
        event('2026-08-25T10:31:00.000Z', { tokensInput: 0, tokensOutput: 5 }),
      ]);

      const [{ windows }] = await service.readings(NOW);

      expect(windows[0].opifexConsumption.tokensInput).toBe(0);
      expect(windows[0].opifexConsumption.tokensOutput).toBe(5);
    });

    it('reports tokens as null, never zero, when nothing in the span reported them', async () => {
      findMany.mockResolvedValue([window]);
      eventFindMany.mockResolvedValue([
        event('2026-08-25T10:30:00.000Z', {
          tokensInput: null,
          tokensOutput: null,
        }),
        event('2026-08-25T10:31:00.000Z', {
          tokensInput: null,
          tokensOutput: null,
        }),
      ]);

      const [{ windows }] = await service.readings(NOW);

      expect(windows[0].opifexConsumption.tokensInput).toBeNull();
      expect(windows[0].opifexConsumption.tokensOutput).toBeNull();
    });

    it('sums three 0.0001 costs to 0.0003, with no float tail', async () => {
      // `run_events.cost_usd` is `Decimal(10,4)`; plain JS addition of three
      // 0.0001s is 0.00030000000000000003. This pins the rounding that keeps
      // the sum at the column's own scale now that it happens in memory
      // rather than in Postgres.
      findMany.mockResolvedValue([window]);
      eventFindMany.mockResolvedValue([
        event('2026-08-25T10:30:00.000Z', {
          costUsd: { toNumber: () => 0.0001 },
        }),
        event('2026-08-25T10:31:00.000Z', {
          costUsd: { toNumber: () => 0.0001 },
        }),
        event('2026-08-25T10:32:00.000Z', {
          costUsd: { toNumber: () => 0.0001 },
        }),
      ]);

      const [{ windows }] = await service.readings(NOW);

      expect(windows[0].opifexConsumption.reportedUsd).toBe(0.0003);
    });
  });

  /**
   * #301's actual acceptance criterion, checked as an invariant rather than a
   * handful of examples: for ANY set of live windows a runner holds,
   * `position.exhausted` must agree with whether any entry in `windows` is
   * itself exhausted. Three hand-picked cases (case 9 in
   * `quota-window.spec.ts`, and the two `readings()` tests above) show the
   * rule holds for the shapes somebody thought to write down. This exercises
   * every combination in a small parameter space instead, so a change that
   * keeps all the named examples green but drifts on an untried combination
   * still fails here.
   *
   * `fast-check` is not used: it is a transitive dev dependency of another
   * package, not one this project declares, and nothing else in the suite
   * reaches for it. An exhaustive sweep over a deliberately small, named
   * parameter space gets the same property coverage without introducing that
   * dependency, and stays fully deterministic — no seed to pin, nothing that
   * can flake in CI.
   */
  describe('position/windows agreement (#301 acceptance criterion)', () => {
    const PRESSURES = ['unknown', 'allowed', 'warning', 'exhausted'] as const;
    const FRESH = new Date('2026-08-25T11:55:00.000Z'); // 5 min before NOW
    const STALE = new Date('2026-08-25T09:00:00.000Z'); // 3 h before NOW

    function windowRow(
      kind: 'five_hour' | 'weekly',
      pressure: (typeof PRESSURES)[number],
      fresh: boolean,
    ) {
      return {
        runnerKey: 'claude-code-local',
        kind,
        resetsAt:
          kind === 'five_hour'
            ? RESETS_AT
            : new Date('2026-08-28T20:00:00.000Z'),
        pressure,
        peakPressure: pressure,
        firstObservedAt: new Date('2026-08-25T09:00:00.000Z'),
        lastObservedAt: fresh ? FRESH : STALE,
        observations: 1,
      };
    }

    function checkInvariant(rows: ReturnType<typeof windowRow>[]) {
      return async () => {
        findMany.mockResolvedValue(rows);

        const [runner] = await service.readings(NOW);

        const exhaustedInWindows = runner.windows.some(
          (w) => w.pressure === 'exhausted',
        );
        const exhaustedInPosition = runner.position?.exhausted ?? false;

        expect(exhaustedInPosition).toBe(exhaustedInWindows);
      };
    }

    describe('a single live window', () => {
      for (const pressure of PRESSURES) {
        for (const fresh of [true, false]) {
          it(
            `${pressure}, ${fresh ? 'fresh' : 'stale'}`,
            checkInvariant([windowRow('five_hour', pressure, fresh)]),
          );
        }
      }
    });

    describe('two live windows of different kinds', () => {
      for (const p1 of PRESSURES) {
        for (const f1 of [true, false]) {
          for (const p2 of PRESSURES) {
            for (const f2 of [true, false]) {
              it(
                `five_hour ${p1} (${f1 ? 'fresh' : 'stale'}) + weekly ${p2} (${
                  f2 ? 'fresh' : 'stale'
                })`,
                checkInvariant([
                  windowRow('five_hour', p1, f1),
                  windowRow('weekly', p2, f2),
                ]),
              );
            }
          }
        }
      }
    });
  });
});
