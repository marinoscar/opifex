import type { PrismaService } from '../prisma/prisma.service';
import { SpendLedgerService } from './spend-ledger.service';

/**
 * The ledger's job is to count what the cockpit read model deliberately does
 * not: the runs that reported nothing (#65).
 *
 * `CostService` reports an unknown as `null` and leaves the reader to judge.
 * A gate cannot leave it to the reader, and dropping the unknowns would make
 * the ceiling decorative — `schemas/runner-capability.schema.json` says
 * exactly that about `reportsCost`. So the assertions here are mostly about
 * where an unmeasured run ends up, and about which of the three totals it
 * lands in.
 */
describe('SpendLedgerService', () => {
  const NOW = new Date('2026-08-23T12:00:00Z');

  /** A Prisma `Decimal`, as far as anything here is concerned. */
  const decimal = (value: number) => ({ toNumber: () => value });

  function ledgerOver(rows: unknown[]): {
    ledger: SpendLedgerService;
    findMany: jest.Mock;
  } {
    const findMany = jest.fn().mockResolvedValue(rows);
    const prisma = { run: { findMany } } as unknown as PrismaService;
    return { ledger: new SpendLedgerService(prisma), findMany };
  }

  it('sums the runs that reported a cost', async () => {
    const { ledger } = ledgerOver([
      { costUsd: decimal(1.5), workOrder: { budgetCeilingUsd: decimal(10) } },
      { costUsd: decimal(2.25), workOrder: { budgetCeilingUsd: decimal(10) } },
    ]);

    const tally = await ledger.tally(30, NOW);

    expect(tally.reportedUsd).toBe(3.75);
    expect(tally.estimatedUsd).toBe(0);
    expect(tally.totalUsd).toBe(3.75);
    expect(tally.runsWithoutCost).toBe(0);
  });

  it('counts an unreported run at its order ceiling, in the estimated column', async () => {
    // Not in `reportedUsd`. The two must stay separable all the way to the
    // operator, per #65's fourth acceptance criterion.
    const { ledger } = ledgerOver([
      { costUsd: decimal(1), workOrder: { budgetCeilingUsd: decimal(10) } },
      { costUsd: null, workOrder: { budgetCeilingUsd: decimal(4) } },
    ]);

    const tally = await ledger.tally(30, NOW);

    expect(tally.reportedUsd).toBe(1);
    expect(tally.estimatedUsd).toBe(4);
    expect(tally.totalUsd).toBe(5);
    expect(tally.runsWithoutCost).toBe(1);
    expect(tally.unboundedRuns).toBe(0);
  });

  it('folds a run with neither cost nor ceiling into no number at all', async () => {
    // THE assertion this file exists for. Counting it as zero is what makes a
    // ceiling decorative; inventing an average for it is what VISION §9 calls
    // a synthesized figure masquerading as a report. It is counted, named, and
    // added to nothing.
    const { ledger } = ledgerOver([
      { costUsd: decimal(2), workOrder: { budgetCeilingUsd: null } },
      { costUsd: null, workOrder: { budgetCeilingUsd: null } },
    ]);

    const tally = await ledger.tally(30, NOW);

    expect(tally.totalUsd).toBe(2);
    expect(tally.estimatedUsd).toBe(0);
    expect(tally.unboundedRuns).toBe(1);
    expect(tally.runsWithoutCost).toBe(1);
  });

  it('survives a run whose work order is missing', async () => {
    // `workOrder` is a relation and a row can outlive it. A crash here would
    // take out the gate, and a gate that throws is a gate that is not
    // enforcing anything.
    const { ledger } = ledgerOver([{ costUsd: null, workOrder: null }]);

    const tally = await ledger.tally(30, NOW);

    expect(tally.unboundedRuns).toBe(1);
    expect(tally.totalUsd).toBe(0);
  });

  it('treats a NaN conversion as unreported rather than as a number', async () => {
    // #167 found the same column converted two different ways in two
    // services, one of which produced NaN. Inside a ceiling that is the worst
    // possible failure: `NaN >= limit` is false, so a broken conversion would
    // read as unlimited headroom and open the gate.
    const { ledger } = ledgerOver([
      {
        costUsd: { toNumber: () => Number.NaN },
        workOrder: { budgetCeilingUsd: decimal(7) },
      },
    ]);

    const tally = await ledger.tally(30, NOW);

    expect(Number.isNaN(tally.totalUsd)).toBe(false);
    expect(tally.runsWithoutCost).toBe(1);
    expect(tally.estimatedUsd).toBe(7);
  });

  it('accepts a plain number as well as a Decimal', async () => {
    const { ledger } = ledgerOver([
      { costUsd: 1.25, workOrder: { budgetCeilingUsd: 3 } },
    ]);

    expect((await ledger.tally(30, NOW)).reportedUsd).toBe(1.25);
  });

  it('windows on the injected clock, not on the wall clock', async () => {
    // Determinism is an acceptance criterion, and a gate whose boundary
    // cannot be pinned to an instant cannot be tested at its boundary.
    const { ledger, findMany } = ledgerOver([]);

    const tally = await ledger.tally(7, NOW);

    expect(tally.window.to).toEqual(NOW);
    expect(tally.window.from).toEqual(new Date('2026-08-16T12:00:00Z'));
    expect(tally.window.days).toBe(7);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          startedAt: { gte: new Date('2026-08-16T12:00:00Z'), lte: NOW },
        },
      }),
    );
  });

  it('rounds to cents, so a float tail never reaches a comparison', async () => {
    const { ledger } = ledgerOver([
      { costUsd: decimal(0.1), workOrder: { budgetCeilingUsd: null } },
      { costUsd: decimal(0.2), workOrder: { budgetCeilingUsd: null } },
    ]);

    expect((await ledger.tally(30, NOW)).totalUsd).toBe(0.3);
  });

  it('reports an empty window as zero rather than as unknown', async () => {
    // Opposite of the cockpit read model's rule, and deliberately so: for a
    // GATE, "nothing has been spent" is a true and useful statement about
    // headroom. `null` here would have to be handled as a special case at
    // every comparison.
    const tally = await (await ledgerOver([])).ledger.tally(30, NOW);

    expect(tally.totalUsd).toBe(0);
    expect(tally.runs).toBe(0);
    expect(tally.unboundedRuns).toBe(0);
  });
});
