import type { HardCeiling } from '../budget/hard-spend-ceiling';
import { HardSpendCeilingService } from '../budget/hard-spend-ceiling';
import type { SpendTally } from '../budget/spend-ledger.service';
import { SpendLedgerService } from '../budget/spend-ledger.service';
import { PrismaService } from '../prisma/prisma.service';
import { CostService } from './cost.service';

/**
 * The question every test here asks is the same one: **does the total tell you
 * how much of it is unknown?**
 *
 * `Run.costUsd` is nullable by design — a runner may not report cost at all —
 * so a total is a floor unless the count of silent runs travels with it. A
 * cost screen that understates spend while looking precise is the most
 * expensive way for this endpoint to be wrong.
 */
describe('CostService', () => {
  function run(
    cost: number | null,
    repository = 'marinoscar/opifex',
    startedAt = '2026-08-23T01:00:00Z',
  ) {
    return {
      startedAt: new Date(startedAt),
      costUsd: cost === null ? null : { toNumber: () => cost },
      workOrder: {
        repository: {
          owner: repository.split('/')[0],
          name: repository.split('/')[1],
        },
      },
    };
  }

  let findMany: jest.Mock;
  let service: CostService;
  let ceiling: HardCeiling;
  let ceilingTally: SpendTally;
  let tally: jest.Mock;

  /**
   * Rebuild with whatever `ceiling` and `ceilingTally` currently hold.
   *
   * The ceiling block (#177) is read from its own ledger over its own window,
   * so it is stubbed independently of `findMany` -- which is exactly the
   * separation the service is asserting: the screen's window and the ceiling's
   * window are different questions and must not share a tally.
   */
  function build(): CostService {
    tally = jest.fn().mockResolvedValue(ceilingTally);
    return new CostService(
      { run: { findMany } } as unknown as PrismaService,
      { value: ceiling } as unknown as HardSpendCeilingService,
      { tally } as unknown as SpendLedgerService,
    );
  }

  beforeEach(() => {
    findMany = jest.fn().mockResolvedValue([]);
    ceiling = { limitUsd: 100, windowDays: 30, malformed: null };
    ceilingTally = {
      reportedUsd: 0,
      estimatedUsd: 0,
      totalUsd: 0,
      runs: 0,
      runsWithoutCost: 0,
      unboundedRuns: 0,
      window: { from: new Date(0), to: new Date(0), days: 30 },
    };
    service = build();
  });

  describe('what is unknown is counted, not hidden', () => {
    it('reports how many runs said nothing about cost', async () => {
      findMany.mockResolvedValue([run(2), run(null), run(null)]);

      const summary = await service.summary();

      expect(summary.totalUsd).toBe(2);
      expect(summary.runs).toBe(3);
      // Read together: $2 observed across three runs, two of them silent.
      expect(summary.runsWithoutCost).toBe(2);
    });

    it('is null, not zero, when nothing reported a cost', async () => {
      // "No run reported a cost" and "the factory spent nothing" are different
      // claims, and only one is ever true of a factory that has run something.
      findMany.mockResolvedValue([run(null), run(null)]);

      const summary = await service.summary();

      expect(summary.totalUsd).toBeNull();
      expect(summary.runs).toBe(2);
      expect(summary.runsWithoutCost).toBe(2);
    });

    it('is null on an empty window rather than a confident zero', async () => {
      const summary = await service.summary();

      expect(summary.totalUsd).toBeNull();
      expect(summary.runs).toBe(0);
    });

    it('applies the same rule per repository', async () => {
      // A repository whose every run reported nothing has an UNKNOWN spend,
      // not a zero one — otherwise it sorts to the bottom looking cheap.
      findMany.mockResolvedValue([
        run(5, 'marinoscar/opifex'),
        run(null, 'marinoscar/other'),
        run(null, 'marinoscar/other'),
      ]);

      const summary = await service.summary();

      const other = summary.byRepository.find(
        (r) => r.repository === 'marinoscar/other',
      );
      expect(other).toMatchObject({
        totalUsd: null,
        runs: 2,
        runsWithoutCost: 2,
      });
    });
  });

  describe('the per-repository split', () => {
    it('groups by owner/name and totals each', async () => {
      findMany.mockResolvedValue([
        run(2, 'marinoscar/opifex'),
        run(3, 'marinoscar/opifex'),
        run(1, 'marinoscar/other'),
      ]);

      const summary = await service.summary();

      expect(summary.byRepository).toEqual([
        {
          repository: 'marinoscar/opifex',
          totalUsd: 5,
          runs: 2,
          runsWithoutCost: 0,
        },
        {
          repository: 'marinoscar/other',
          totalUsd: 1,
          runs: 1,
          runsWithoutCost: 0,
        },
      ]);
    });

    it('puts the biggest spender first and the unknowns last', async () => {
      // A null sorting high would put the least informative row where the eye
      // lands first.
      findMany.mockResolvedValue([
        run(null, 'marinoscar/unknown'),
        run(1, 'marinoscar/small'),
        run(9, 'marinoscar/big'),
      ]);

      const summary = await service.summary();

      expect(summary.byRepository.map((r) => r.repository)).toEqual([
        'marinoscar/big',
        'marinoscar/small',
        'marinoscar/unknown',
      ]);
    });
  });

  describe('the daily series', () => {
    it('drops days with no reported spend rather than plotting zeros', async () => {
      // Same rule the metrics trend follows: a zero would draw a line claiming
      // the factory ran for free that day.
      findMany.mockResolvedValue([
        run(2, 'marinoscar/opifex', '2026-08-21T01:00:00Z'),
        run(3, 'marinoscar/opifex', '2026-08-23T01:00:00Z'),
      ]);

      const summary = await service.summary(7);

      expect(summary.byDay).toEqual([
        { date: '2026-08-21', totalUsd: 2 },
        { date: '2026-08-23', totalUsd: 3 },
      ]);
    });

    it('sums several runs on the same day', async () => {
      findMany.mockResolvedValue([
        run(2, 'marinoscar/opifex', '2026-08-23T01:00:00Z'),
        run(3, 'marinoscar/opifex', '2026-08-23T09:00:00Z'),
      ]);

      const summary = await service.summary();

      expect(summary.byDay).toEqual([{ date: '2026-08-23', totalUsd: 5 }]);
    });

    it('excludes a run that reported no cost from the series entirely', async () => {
      findMany.mockResolvedValue([
        run(null, 'marinoscar/opifex', '2026-08-23T01:00:00Z'),
      ]);

      const summary = await service.summary();

      expect(summary.byDay).toEqual([]);
    });
  });

  describe('arithmetic', () => {
    it('rounds to cents rather than showing a float tail', async () => {
      // Decimal(10,4) summed as floats produces 0.30000000000000004, and a
      // cost screen showing that has lost the reader over an artefact of the
      // language rather than a real number.
      findMany.mockResolvedValue([run(0.1), run(0.2)]);

      const summary = await service.summary();

      expect(summary.totalUsd).toBe(0.3);
    });
  });

  describe('quota', () => {
    it('is always null, and present rather than omitted', async () => {
      // A cost-and-quota screen with no quota field would look like quota was
      // forgotten. Naming it null lets the screen say it is unavailable.
      const summary = await service.summary();

      expect(summary).toHaveProperty('quota');
      expect(summary.quota).toBeNull();
    });
  });

  describe('the window', () => {
    it('queries only runs started inside it', async () => {
      await service.summary(14);

      const where = findMany.mock.calls[0][0].where;
      const span =
        new Date(where.startedAt.lte).getTime() -
        new Date(where.startedAt.gte).getTime();
      expect(span).toBe(14 * 24 * 60 * 60 * 1000);
    });

    it('reports when it computed and over what', async () => {
      const summary = await service.summary(30);

      expect(summary.generatedAt).toBe(summary.window.to);
      const span =
        new Date(summary.window.to).getTime() -
        new Date(summary.window.from).getTime();
      expect(span).toBe(30 * 24 * 60 * 60 * 1000);
    });
  });
  /**
   * The ceiling block (#177).
   *
   * A limit an operator cannot see the state of is one they will assume is
   * working, and the quiet failure is the dangerous one: with no ceiling set,
   * dispatch refuses every work order and the queue looks like a capacity
   * problem. These assertions are about the screen being able to tell the
   * difference.
   */
  describe('the hard spend ceiling', () => {
    it('reports the limit, the window and the headroom', async () => {
      ceiling = { limitUsd: 100, windowDays: 30, malformed: null };
      ceilingTally = { ...ceilingTally, totalUsd: 12.5, reportedUsd: 12.5 };

      const summary = await build().summary();

      expect(summary.ceiling.limitUsd).toBe(100);
      expect(summary.ceiling.windowDays).toBe(30);
      expect(summary.ceiling.headroomUsd).toBe(87.5);
      expect(summary.ceiling.spend.reportedUsd).toBe(12.5);
    });

    it('reports null headroom when no ceiling is configured, not the full limit', async () => {
      // The failure this prevents: a full headroom bar drawn over a factory
      // that cannot spend a cent. No ceiling REFUSES dispatch, so the honest
      // rendering of that state is an absence, not a maximum.
      ceiling = { limitUsd: null, windowDays: 30, malformed: null };

      const summary = await build().summary();

      expect(summary.ceiling.limitUsd).toBeNull();
      expect(summary.ceiling.headroomUsd).toBeNull();
    });

    it('surfaces a malformed value separately from an absent one', async () => {
      // Same distinction the gate makes. Telling somebody their ceiling is
      // unset when it is in fact set-but-mistyped sends them to look for a
      // variable they already exported.
      ceiling = { limitUsd: null, windowDays: 30, malformed: '5O' };

      const summary = await build().summary();

      expect(summary.ceiling.malformed).toBe('5O');
      expect(summary.ceiling.limitUsd).toBeNull();
    });

    it('keeps the estimated part separate from the reported part', async () => {
      ceilingTally = {
        ...ceilingTally,
        reportedUsd: 3,
        estimatedUsd: 5,
        totalUsd: 8,
        runsWithoutCost: 2,
        unboundedRuns: 1,
      };

      const summary = await build().summary();

      expect(summary.ceiling.spend.reportedUsd).toBe(3);
      expect(summary.ceiling.spend.estimatedUsd).toBe(5);
      expect(summary.ceiling.spend.totalUsd).toBe(8);
      // Above zero means `totalUsd` is a floor, and the screen has to be able
      // to know that rather than drawing a bar implying precision.
      expect(summary.ceiling.spend.unboundedRuns).toBe(1);
    });

    it('never reports negative headroom', async () => {
      // Overshoot is possible: the admission gate bounds the NEXT dispatch,
      // not a run already under way. A negative bar would render as a
      // rendering bug rather than as "the ceiling has been passed".
      ceiling = { limitUsd: 10, windowDays: 30, malformed: null };
      ceilingTally = { ...ceilingTally, totalUsd: 25, reportedUsd: 25 };

      const summary = await build().summary();

      expect(summary.ceiling.headroomUsd).toBe(0);
      expect(summary.ceiling.spend.totalUsd).toBe(25);
    });

    it('tallies over the ceiling window, not the window the caller asked for', async () => {
      // THE assertion this block exists for. Headroom computed over a
      // different window than the ceiling it is compared against is wrong in
      // a way nothing on screen could reveal.
      ceiling = { limitUsd: 100, windowDays: 7, malformed: null };
      const built = build();

      await built.summary(90);

      expect(tally).toHaveBeenCalledWith(7, expect.any(Date));
      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.anything() }),
      );
    });
  });
});
