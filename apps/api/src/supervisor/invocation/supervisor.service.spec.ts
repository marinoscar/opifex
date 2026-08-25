import { ConfigService } from '@nestjs/config';

import type { HardCeiling } from '../../budget/hard-spend-ceiling';
import type { DecisionLogService } from '../decision-log/decision-log.service';
import type { SnapshotService } from '../snapshot/snapshot.service';
import type { SnapshotInput } from '../snapshot/snapshot.types';
import { SupervisorService } from './supervisor.service';
import {
  UnavailableSupervisorModel,
  type SupervisorModel,
} from './supervisor-model.port';
import type { SupervisorProposer } from './supervisor-proposer.port';
import type { SupervisorSpendCeilingService } from './supervisor-spend-ceiling';
import type {
  SupervisorSpendLedgerService,
  SupervisorSpendTally,
} from './supervisor-spend-ledger.service';

const NOW = new Date('2026-08-24T12:00:00.000Z');

function state(
  overrides: Partial<SnapshotInput['totals']> = {},
): SnapshotInput {
  return {
    generatedAt: NOW,
    windowDays: 1,
    totals: {
      runsRunning: 0,
      runsStalled: 0,
      runsBlocked: 0,
      runsSucceededInWindow: 0,
      runsFailedInWindow: 0,
      workOrdersQueued: 0,
      workOrdersHeld: 0,
      workOrdersQuarantined: 0,
      escalationsOutstanding: 0,
      ...overrides,
    },
    attentionRuns: [],
    recentRuns: [],
    queuedWorkOrders: [],
    quarantinedWorkOrders: [],
    escalations: [],
    specRejections: [],
  };
}

function configDouble(values: Record<string, unknown> = {}) {
  return {
    get: jest.fn((key: string) => values[key]),
  } as unknown as ConfigService;
}

/**
 * A ceiling and a tally, both configured to admit unless a test says otherwise.
 *
 * Every test in this file now needs them: since ADR-0017 a tick with no
 * ceiling does not run at all, so "the default supervisor" is one with a
 * ceiling it is nowhere near. The tests that care about the ceiling say so by
 * passing `ceiling` or `tally` explicitly.
 */
function ceilingDouble(overrides: Partial<HardCeiling> = {}) {
  const value: HardCeiling = {
    limitUsd: 5,
    windowDays: 1,
    malformed: null,
    ...overrides,
  };
  return { value } as unknown as SupervisorSpendCeilingService;
}

function tallyValue(
  overrides: Partial<SupervisorSpendTally> = {},
): SupervisorSpendTally {
  return {
    reportedUsd: 0,
    unpricedCalls: 0,
    invocations: 0,
    window: { from: new Date(NOW.getTime() - 86_400_000), to: NOW, days: 1 },
    ...overrides,
  };
}

function build(
  options: {
    config?: Record<string, unknown>;
    snapshot?: SnapshotInput;
    collectRejects?: Error;
    model?: SupervisorModel;
    proposers?: SupervisorProposer[];
    recordRejects?: Error;
    ceiling?: Partial<HardCeiling>;
    tally?: Partial<SupervisorSpendTally>;
    tallyRejects?: Error;
  } = {},
) {
  const collect = options.collectRejects
    ? jest.fn().mockRejectedValue(options.collectRejects)
    : jest.fn().mockResolvedValue(options.snapshot ?? state());
  const record = options.recordRejects
    ? jest.fn().mockRejectedValue(options.recordRejects)
    : jest.fn().mockResolvedValue({ invocationId: 'inv-1', proposalIds: [] });

  const snapshots = {
    collect,
    render: jest.fn(),
  } as unknown as SnapshotService;
  const log = { record } as unknown as DecisionLogService;

  const tally = options.tallyRejects
    ? jest.fn().mockRejectedValue(options.tallyRejects)
    : jest.fn().mockResolvedValue(tallyValue(options.tally));
  const ledger = { tally } as unknown as SupervisorSpendLedgerService;

  const service = new SupervisorService(
    configDouble({ 'supervisor.enabled': true, ...options.config }),
    snapshots,
    log,
    ceilingDouble(options.ceiling),
    ledger,
    options.model,
    options.proposers,
  );

  return { service, collect, record, tally };
}

function proposer(
  name: string,
  impl: SupervisorProposer['propose'],
): SupervisorProposer {
  return { name, actionClass: 'run-diagnosis', propose: impl };
}

describe('SupervisorService (#89)', () => {
  describe('when the supervisor is disabled', () => {
    it('records a skipped_disabled row and reads no state', async () => {
      const { service, collect, record } = build({
        config: { 'supervisor.enabled': false },
      });

      const id = await service.invoke(NOW);

      expect(id).toBe('inv-1');
      expect(collect).not.toHaveBeenCalled();
      expect(record.mock.calls[0][0].outcome).toBe('skipped_disabled');
    });

    it('can be disabled entirely by configuration', async () => {
      const { service } = build({ config: { 'supervisor.enabled': false } });
      expect(service.enabled).toBe(false);
    });

    it('treats a missing config value as off, not on', async () => {
      const { service } = build({
        config: { 'supervisor.enabled': undefined },
      });
      expect(service.enabled).toBe(false);
    });
  });

  describe('quota awareness', () => {
    it('stands down while a worker is parked on a rate limit', async () => {
      const { service, record } = build({
        snapshot: state({ runsBlocked: 1 }),
      });

      await service.invoke(NOW);

      const draft = record.mock.calls[0][0];
      expect(draft.outcome).toBe('skipped_quota');
      expect(draft.failureReason).toContain('parked on a rate limit');
    });

    it('never calls a proposer when it stands down', async () => {
      const propose = jest.fn();
      const { service } = build({
        snapshot: state({ runsBlocked: 1 }),
        proposers: [proposer('p', propose)],
      });

      await service.invoke(NOW);

      expect(propose).not.toHaveBeenCalled();
    });

    it('proceeds when nothing is parked', async () => {
      const { service, record } = build({
        snapshot: state({ runsRunning: 2 }),
      });

      await service.invoke(NOW);

      expect(record.mock.calls[0][0].outcome).toBe('completed');
    });

    it('proceeds with many runs live, since ADR-0016 removed the ceiling', async () => {
      // The inverse of the test that used to sit here ('honours a configured
      // live-run ceiling'). A busy factory is no longer a reason to skip a
      // tick: every proposer runs once per invocation whatever `runsRunning`
      // is, so the count the ceiling gated on never determined what the tick
      // cost. `SUPERVISOR_LIVE_RUN_CEILING` is left set in the config double
      // on purpose -- a deployment that still has it exported must not still
      // be gated by it.
      const propose = jest.fn().mockResolvedValue([]);
      const { service, record } = build({
        config: { 'supervisor.liveRunCeiling': 2 },
        snapshot: state({ runsRunning: 50 }),
        proposers: [proposer('p', propose)],
      });

      await service.invoke(NOW);

      expect(record.mock.calls[0][0].outcome).toBe('completed');
      expect(propose).toHaveBeenCalled();
    });
  });

  describe('its own spend ceiling (#261, ADR-0017)', () => {
    const askOnce = async (ctx: {
      model: SupervisorModel;
      snapshot: string;
    }) => {
      await ctx.model.ask({ snapshot: ctx.snapshot, instruction: 'x' });
      return [];
    };

    function pricedModel(costUsd: number | null): SupervisorModel {
      return {
        name: 'm',
        ask: jest.fn().mockResolvedValue({
          text: 'ok',
          costUsd,
          tokensInput: 10,
          tokensOutput: 2,
        }),
      };
    }

    it('refuses the tick when the window is already at the ceiling', async () => {
      const propose = jest.fn();
      const { service, record, collect } = build({
        ceiling: { limitUsd: 5 },
        tally: { reportedUsd: 5, invocations: 12 },
        proposers: [proposer('p', propose)],
      });

      await service.invoke(NOW);

      const draft = record.mock.calls[0][0];
      expect(draft.outcome).toBe('skipped_budget');
      expect(draft.failureReason).toContain('$5.00');
      expect(draft.failureReason).toContain('1d');
      expect(propose).not.toHaveBeenCalled();
      // Earlier than the quota gate on purpose: a tick refused on dollars
      // should not pay for the queries that describe what it will not read.
      expect(collect).not.toHaveBeenCalled();
    });

    it('refuses when no ceiling is configured, and says which variable to set', async () => {
      const { service, record, tally } = build({
        ceiling: { limitUsd: null },
      });

      await service.invoke(NOW);

      const draft = record.mock.calls[0][0];
      expect(draft.outcome).toBe('skipped_budget');
      expect(draft.failureReason).toContain(
        'SUPERVISOR_HARD_SPEND_CEILING_USD',
      );
      // Nothing to compare a tally against, so nothing asks the database for
      // one.
      expect(tally).not.toHaveBeenCalled();
    });

    it('refuses a malformed ceiling as its own case, not as an absent one', async () => {
      const { service, record } = build({
        ceiling: { limitUsd: null, malformed: '5O' },
      });

      await service.invoke(NOW);

      const draft = record.mock.calls[0][0];
      expect(draft.outcome).toBe('skipped_budget');
      expect(draft.failureReason).toContain('"5O"');
    });

    it('is a different outcome from skipped_quota', async () => {
      // The two name different facts: one says the factory is parked, the
      // other says a dollar figure has no room. Waiting fixes only the first.
      const budget = build({
        ceiling: { limitUsd: 1 },
        tally: { reportedUsd: 2 },
        snapshot: state({ runsBlocked: 3 }),
      });
      await budget.service.invoke(NOW);

      const quota = build({ snapshot: state({ runsBlocked: 3 }) });
      await quota.service.invoke(NOW);

      expect(budget.record.mock.calls[0][0].outcome).toBe('skipped_budget');
      expect(quota.record.mock.calls[0][0].outcome).toBe('skipped_quota');
    });

    it('runs the tick when there is headroom', async () => {
      const propose = jest.fn().mockResolvedValue([]);
      const { service, record } = build({
        ceiling: { limitUsd: 5 },
        tally: { reportedUsd: 4.99 },
        proposers: [proposer('p', propose)],
      });

      await service.invoke(NOW);

      expect(record.mock.calls[0][0].outcome).toBe('completed');
      expect(propose).toHaveBeenCalled();
    });

    it('stops between proposers once this tick has spent the headroom', async () => {
      // The check `decideBudgetOverrun` cannot make: each proposer makes at
      // most one call and it prices synchronously on return, so the ceiling
      // can be enforced BEFORE the next proposer spends anything.
      const seen: string[] = [];
      const p = (name: string) =>
        proposer(name, async (ctx) => {
          seen.push(name);
          await ctx.model.ask({ snapshot: ctx.snapshot, instruction: 'x' });
          return [];
        });

      const { service, record } = build({
        ceiling: { limitUsd: 5 },
        tally: { reportedUsd: 4.9 },
        model: pricedModel(0.2),
        proposers: [p('a'), p('b'), p('c')],
      });

      await service.invoke(NOW);

      // 'a' ran and took the tally to $5.10; 'b' and 'c' never got the model.
      expect(seen).toEqual(['a']);

      const draft = record.mock.calls[0][0];
      expect(draft.outcome).toBe('partial');
      expect(draft.failureReason).toContain('Stopped after 1 of 3');
      expect(draft.failureReason).toContain('ceiling');
    });

    it('reads differently from a proposer failure, and says both when both happened', async () => {
      const { service, record } = build({
        ceiling: { limitUsd: 5 },
        tally: { reportedUsd: 4.9 },
        model: pricedModel(0.2),
        proposers: [
          proposer('boom', async (ctx) => {
            await ctx.model.ask({ snapshot: ctx.snapshot, instruction: 'x' });
            throw new Error('boom');
          }),
          proposer('never', askOnce),
        ],
      });

      await service.invoke(NOW);

      const reason = record.mock.calls[0][0].failureReason;
      expect(reason).toContain('Stopped after 1 of 2');
      expect(reason).toContain('At least one proposer also failed.');
      expect(reason).not.toBe('At least one proposer failed.');
    });

    it('does not count an unpriced call as zero, and does not stop on it alone', async () => {
      // An unpriced call contributed real money nothing could convert. It must
      // not read as free, and it must not take the supervisor down either —
      // that would turn "Anthropic shipped a model the table lacks" into an
      // indefinite outage.
      const propose = jest.fn().mockResolvedValue([]);
      const { service, record } = build({
        ceiling: { limitUsd: 5 },
        tally: { reportedUsd: 1, unpricedCalls: 7, invocations: 4 },
        model: pricedModel(null),
        proposers: [proposer('a', askOnce), proposer('b', propose)],
      });

      await service.invoke(NOW);

      const draft = record.mock.calls[0][0];
      expect(draft.outcome).toBe('completed');
      expect(propose).toHaveBeenCalled();
      expect(draft.costUsd).toBeNull();
      expect(draft.unpricedCalls).toBe(1);
    });

    it('names the unknown part when it refuses, so the figure reads as a floor', async () => {
      const { service, record } = build({
        ceiling: { limitUsd: 5 },
        tally: { reportedUsd: 5, unpricedCalls: 3, invocations: 9 },
      });

      await service.invoke(NOW);

      expect(record.mock.calls[0][0].failureReason).toContain(
        'floor, not a total',
      );
    });

    it('measures the window the ceiling names, at the instant of the tick', async () => {
      const { service, tally } = build({ ceiling: { windowDays: 30 } });

      await service.invoke(NOW);

      expect(tally).toHaveBeenCalledWith(30, NOW);
    });

    it('records failed, not skipped_budget, when the spend cannot be read at all', async () => {
      // A ceiling that cannot be checked still stops the tick, but the log
      // must not claim a ceiling was reached when nobody could read what had
      // been spent.
      const { service, record, collect } = build({
        tallyRejects: new Error('database is down'),
      });

      await expect(service.invoke(NOW)).resolves.toBe('inv-1');

      const draft = record.mock.calls[0][0];
      expect(draft.outcome).toBe('failed');
      expect(draft.failureReason).toContain('database is down');
      expect(collect).not.toHaveBeenCalled();
    });
  });

  describe('failing safe', () => {
    it('records a failed row rather than throwing when state cannot be read', async () => {
      const { service, record } = build({
        collectRejects: new Error('database is down'),
      });

      await expect(service.invoke(NOW)).resolves.toBe('inv-1');
      expect(record.mock.calls[0][0].outcome).toBe('failed');
      expect(record.mock.calls[0][0].failureReason).toContain(
        'database is down',
      );
    });

    it('keeps the other proposals when one proposer throws', async () => {
      // The whole point of `partial`: one bad proposer must not cost four
      // good proposals.
      const { service, record } = build({
        proposers: [
          proposer('bad', () => Promise.reject(new Error('boom'))),
          proposer('good', () =>
            Promise.resolve([
              {
                actionClass: 'run-diagnosis' as const,
                outcome: 'proposed' as const,
                summary: 's',
                reasoning: 'r',
              },
            ]),
          ),
        ],
      });

      await service.invoke(NOW);

      expect(record.mock.calls[0][0].outcome).toBe('partial');
      expect(record.mock.calls[0][1]).toHaveLength(1);
    });

    it('returns null rather than throwing when even the log cannot be written', async () => {
      const { service } = build({ recordRejects: new Error('no database') });

      await expect(service.invoke(NOW)).resolves.toBeNull();
    });

    it('does not throw when the model itself is unavailable', async () => {
      // The default binding refuses rather than pretending, and a proposer
      // that calls it fails like any other proposer.
      const { service, record } = build({
        model: new UnavailableSupervisorModel(),
        proposers: [
          proposer('needs-model', async (ctx) => {
            await ctx.model.ask({ snapshot: ctx.snapshot, instruction: 'x' });
            return [];
          }),
        ],
      });

      await expect(service.invoke(NOW)).resolves.toBe('inv-1');
      expect(record.mock.calls[0][0].outcome).toBe('partial');
    });
  });

  describe('what it records', () => {
    it('names the model on every invocation', async () => {
      const model: SupervisorModel = {
        name: 'small-model-1',
        ask: jest.fn(),
      };
      const { service, record } = build({ model });

      await service.invoke(NOW);

      expect(record.mock.calls[0][0].model).toBe('small-model-1');
    });

    it('records "none" when no adapter is bound', async () => {
      const { service, record } = build();
      await service.invoke(NOW);
      expect(record.mock.calls[0][0].model).toBe('none');
    });

    it('stores the snapshot rendered from the state it just read', async () => {
      const { service, record } = build({
        snapshot: state({ runsRunning: 3 }),
      });

      await service.invoke(NOW);

      const draft = record.mock.calls[0][0];
      expect(draft.snapshotText).toContain('# Factory snapshot');
      expect(draft.snapshotText).toContain('3 running');
      expect(draft.snapshotGeneratedAt).toBe(NOW);
      expect(draft.snapshotCharacters).toBe(draft.snapshotText.length);
    });

    it('reads state once, not twice', async () => {
      // Rendering from the state already in hand rather than through
      // `render()` — which would re-issue every query — is also what
      // guarantees the stored text matches what the quota gate judged.
      const { service, collect } = build();

      await service.invoke(NOW);

      expect(collect).toHaveBeenCalledTimes(1);
    });

    it('sums the cost of every model call, whoever made it', async () => {
      // Metered by the service, not trusted to each proposer: a proposer that
      // forgot would make the supervisor look cheaper than it is.
      const model: SupervisorModel = {
        name: 'm',
        ask: jest.fn().mockResolvedValue({
          text: 'ok',
          costUsd: 0.01,
          tokensInput: 100,
          tokensOutput: 20,
        }),
      };
      const ask = async (ctx: { model: SupervisorModel; snapshot: string }) => {
        await ctx.model.ask({ snapshot: ctx.snapshot, instruction: 'x' });
        return [];
      };
      const { service, record } = build({
        model,
        proposers: [proposer('a', ask), proposer('b', ask)],
      });

      await service.invoke(NOW);

      const draft = record.mock.calls[0][0];
      expect(draft.costUsd).toBeCloseTo(0.02);
      expect(draft.tokensInput).toBe(200);
      expect(draft.tokensOutput).toBe(40);
    });

    it('leaves cost null when the adapter reports none', async () => {
      const model: SupervisorModel = {
        name: 'm',
        ask: jest.fn().mockResolvedValue({
          text: 'ok',
          costUsd: null,
          tokensInput: null,
          tokensOutput: null,
        }),
      };
      const { service, record } = build({
        model,
        proposers: [
          proposer('a', async (ctx) => {
            await ctx.model.ask({ snapshot: ctx.snapshot, instruction: 'x' });
            return [];
          }),
        ],
      });

      await service.invoke(NOW);

      // Null, not 0: VISION §6 makes cost reporting a declared capability, so
      // an adapter that does not report must not look free.
      expect(record.mock.calls[0][0].costUsd).toBeNull();
    });

    it('counts the calls that priced at null instead of dropping them (#282)', async () => {
      // The MIXED tick, which is the case the old `add()` got wrong on its
      // own: one call prices, one does not, and the row used to report the
      // known half as if it were the whole bill. `unpricedCalls` is what makes
      // $0.01 readable as a floor rather than a total.
      const model: SupervisorModel = {
        name: 'm',
        ask: jest
          .fn()
          .mockResolvedValueOnce({
            text: 'ok',
            costUsd: 0.01,
            tokensInput: 100,
            tokensOutput: 20,
          })
          .mockResolvedValueOnce({
            text: 'ok',
            costUsd: null,
            tokensInput: 40,
            tokensOutput: 5,
          }),
      };

      const ask = async (ctx: { model: SupervisorModel; snapshot: string }) => {
        await ctx.model.ask({ snapshot: ctx.snapshot, instruction: 'x' });
        return [];
      };
      const { service, record } = build({
        model,
        proposers: [proposer('a', ask), proposer('b', ask)],
      });

      await service.invoke(NOW);

      const draft = record.mock.calls[0][0];
      expect(draft.costUsd).toBeCloseTo(0.01);
      expect(draft.unpricedCalls).toBe(1);
    });

    it('counts every call when nothing priced at all', async () => {
      const model: SupervisorModel = {
        name: 'm',
        ask: jest.fn().mockResolvedValue({
          text: 'ok',
          costUsd: null,
          tokensInput: null,
          tokensOutput: null,
        }),
      };
      const ask = async (ctx: { model: SupervisorModel; snapshot: string }) => {
        await ctx.model.ask({ snapshot: ctx.snapshot, instruction: 'x' });
        return [];
      };
      const { service, record } = build({
        model,
        proposers: [proposer('a', ask), proposer('b', ask)],
      });

      await service.invoke(NOW);

      const draft = record.mock.calls[0][0];
      expect(draft.costUsd).toBeNull();
      expect(draft.unpricedCalls).toBe(2);
    });

    it('counts nothing unpriced when every call priced', async () => {
      const model: SupervisorModel = {
        name: 'm',
        ask: jest.fn().mockResolvedValue({
          text: 'ok',
          costUsd: 0.02,
          tokensInput: 10,
          tokensOutput: 2,
        }),
      };
      const { service, record } = build({
        model,
        proposers: [
          proposer('a', async (ctx) => {
            await ctx.model.ask({ snapshot: ctx.snapshot, instruction: 'x' });
            return [];
          }),
        ],
      });

      await service.invoke(NOW);

      const draft = record.mock.calls[0][0];
      expect(draft.costUsd).toBeCloseTo(0.02);
      expect(draft.unpricedCalls).toBe(0);
    });

    it('records an invocation with no proposers at all', async () => {
      const { service, record } = build();

      await service.invoke(NOW);

      expect(record.mock.calls[0][0].outcome).toBe('completed');
      expect(record.mock.calls[0][1]).toEqual([]);
    });

    it('hands every proposer the identical snapshot text', async () => {
      const seen: string[] = [];
      const capture = (ctx: { snapshot: string }) => {
        seen.push(ctx.snapshot);
        return Promise.resolve([]);
      };
      const { service, record } = build({
        proposers: [proposer('a', capture), proposer('b', capture)],
      });

      await service.invoke(NOW);

      expect(seen[0]).toBe(seen[1]);
      expect(seen[0]).toBe(record.mock.calls[0][0].snapshotText);
    });
  });

  describe('statelessness', () => {
    it('carries nothing between invocations', async () => {
      // VISION §7's requirement. Two invocations must each read state and each
      // write their own row; anything remembered is the context drift the
      // section describes.
      const { service, collect, record } = build();

      await service.invoke(NOW);
      await service.invoke(new Date(NOW.getTime() + 3_600_000));

      expect(collect).toHaveBeenCalledTimes(2);
      expect(record).toHaveBeenCalledTimes(2);
      expect(record.mock.calls[0][0].startedAt).not.toBe(
        record.mock.calls[1][0].startedAt,
      );
    });
  });
});
