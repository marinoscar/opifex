import type { PrismaService } from '../../prisma/prisma.service';
import {
  noSupervisorSpendTally,
  SupervisorSpendLedgerService,
} from './supervisor-spend-ledger.service';

/**
 * What the supervisor has spent on itself (#261, ADR-0017).
 *
 * The assertions here are mostly about two things the tally must never do:
 * read a row from any table but `supervisor_invocations`, and let an unpriced
 * call disappear into a total that then looks complete.
 */
describe('SupervisorSpendLedgerService', () => {
  const NOW = new Date('2026-08-25T12:00:00Z');

  /** A Prisma `Decimal`, as far as anything here is concerned. */
  const decimal = (value: number) => ({ toNumber: () => value });

  function ledgerOver(rows: unknown[]): {
    ledger: SupervisorSpendLedgerService;
    findMany: jest.Mock;
    run: { findMany: jest.Mock };
  } {
    const findMany = jest.fn().mockResolvedValue(rows);
    const run = { findMany: jest.fn() };
    const prisma = {
      supervisorInvocation: { findMany },
      run,
    } as unknown as PrismaService;
    return {
      ledger: new SupervisorSpendLedgerService(prisma),
      findMany,
      run,
    };
  }

  it('sums the invocations that reported a cost', async () => {
    const { ledger } = ledgerOver([
      { costUsd: decimal(0.02), unpricedCalls: 0 },
      { costUsd: decimal(0.03), unpricedCalls: 0 },
    ]);

    const tally = await ledger.tally(1, NOW);

    expect(tally.reportedUsd).toBe(0.05);
    expect(tally.unpricedCalls).toBe(0);
    expect(tally.invocations).toBe(2);
  });

  it('reads SupervisorInvocation and nothing else', async () => {
    // The architectural commitment, asserted rather than assumed.
    // `schema.prisma` states on the column itself that
    // `SupervisorInvocation.costUsd` is separate from `Run.costUsd` by
    // construction; a tally that touched `Run` would be the first place in
    // this codebase those two are added together, and the number it produced
    // would be the one a future dashboard reaches for.
    const { ledger, run } = ledgerOver([]);

    await ledger.tally(1, NOW);

    expect(run.findMany).not.toHaveBeenCalled();
  });

  it('carries the unpriced calls through instead of dropping them', async () => {
    // Rows are reduced in code rather than SUMmed in SQL for exactly this: a
    // `SUM` over a nullable column skips the nulls and cannot say how many it
    // skipped, and the count of what was skipped is the point of a ceiling.
    const { ledger } = ledgerOver([
      { costUsd: decimal(0.02), unpricedCalls: 0 },
      { costUsd: null, unpricedCalls: 3 },
      { costUsd: decimal(0.01), unpricedCalls: 1 },
    ]);

    const tally = await ledger.tally(1, NOW);

    // The measured part only. The unpriced calls are counted, never converted
    // to a figure nobody measured.
    expect(tally.reportedUsd).toBe(0.03);
    expect(tally.unpricedCalls).toBe(4);
  });

  it('counts a skipped invocation as an invocation and not as spend', async () => {
    // Every tick writes a row, including the ones that never ran (#90). Those
    // have a null cost and no calls, and must not look like unknown money.
    const { ledger } = ledgerOver([
      { costUsd: null, unpricedCalls: 0 },
      { costUsd: null, unpricedCalls: 0 },
    ]);

    const tally = await ledger.tally(1, NOW);

    expect(tally.reportedUsd).toBe(0);
    expect(tally.unpricedCalls).toBe(0);
    expect(tally.invocations).toBe(2);
  });

  it('queries the rolling window ending at the instant it was given', async () => {
    // `now` is injected rather than read from the clock: a gate whose boundary
    // cannot be pinned to an instant cannot be tested at its boundary.
    const { ledger, findMany } = ledgerOver([]);

    const tally = await ledger.tally(2, NOW);

    expect(findMany.mock.calls[0][0].where).toEqual({
      startedAt: {
        gte: new Date(NOW.getTime() - 2 * 86_400_000),
        lte: NOW,
      },
    });
    expect(tally.window).toEqual({
      from: new Date(NOW.getTime() - 2 * 86_400_000),
      to: NOW,
      days: 2,
    });
  });

  it('rounds to cents, so the ceiling is never passed by a float tail', async () => {
    const { ledger } = ledgerOver([
      { costUsd: decimal(0.1), unpricedCalls: 0 },
      { costUsd: decimal(0.2), unpricedCalls: 0 },
    ]);

    expect((await ledger.tally(1, NOW)).reportedUsd).toBe(0.3);
  });

  it('survives a cost column that is a plain number rather than a Decimal', async () => {
    // #167 found one column converted two ways in two services, and only one
    // worked. A silent NaN here would make every comparison false — `NaN >=
    // limit` is `false` — and read as headroom.
    const { ledger } = ledgerOver([
      { costUsd: 0.25, unpricedCalls: 0 },
      { costUsd: 'not a number', unpricedCalls: 0 },
    ]);

    expect((await ledger.tally(1, NOW)).reportedUsd).toBe(0.25);
  });

  it('describes an empty window without asking the database anything', () => {
    // Used when no ceiling is configured: the verdict is settled by the
    // ceiling alone, so the query would be work whose answer cannot matter.
    expect(noSupervisorSpendTally(1, NOW)).toEqual({
      reportedUsd: 0,
      unpricedCalls: 0,
      invocations: 0,
      window: { from: new Date(NOW.getTime() - 86_400_000), to: NOW, days: 1 },
    });
  });
});
