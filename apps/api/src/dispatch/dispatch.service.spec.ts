import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../prisma/prisma.service';
import type { RunnerCapabilities } from '../runners/runner.types';
import {
  DispatchService,
  OCCUPYING_STATUSES,
  QUOTA_BLOCK_REASONS,
  toCapabilities,
} from './dispatch.service';

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

/**
 * A run sitting `blocked`, as `loadQuotaBlocks` selects it.
 *
 * The LAGGING half of the quota signal (#105): a dated, first-hand block the
 * runner reported, which can only ever be observed after a run has already hit
 * the wall. The leading half is {@link meterWindow} — since #285 there are two
 * of them, and `resolveQuotaPosition` ranks them.
 */
function blockedRun(
  overrides: {
    runnerKey?: string;
    resumesAt?: Date | null;
    blockedReason?: string | null;
    blockedUntil?: Date | null;
  } = {},
) {
  const {
    runnerKey = 'claude-code-local',
    resumesAt = null,
    blockedReason = 'rate-limit',
    blockedUntil = new Date(Date.now() + 3 * 60 * 60_000),
  } = overrides;

  return { runnerKey, resumesAt, events: [{ blockedReason, blockedUntil }] };
}

describe('DispatchService', () => {
  let prisma: {
    runner: { findMany: jest.Mock };
    run: { groupBy: jest.Mock; count: jest.Mock; findMany: jest.Mock };
    quotaWindow: { findMany: jest.Mock };
  };
  let service: DispatchService;

  function build(maxConcurrent: number | null = null) {
    service = new DispatchService(
      prisma as unknown as PrismaService,
      new ConfigService({ dispatch: { maxConcurrent } }),
    );
    jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
    jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
  }

  beforeEach(() => {
    prisma = {
      runner: { findMany: jest.fn().mockResolvedValue([runnerRow()]) },
      run: {
        groupBy: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
      },
      quotaWindow: { findMany: jest.fn().mockResolvedValue([]) },
    };
    build();
  });

  describe('what counts as occupying a slot', () => {
    it('counts running, stalled and blocked', () => {
      // `blocked` is the debatable one: a rate-limited run is doing nothing,
      // but it WILL resume on that runner (#56), and freeing the slot now
      // means over-subscribing the moment it does — which breaks the one
      // number the runner told us about itself.
      expect([...OCCUPYING_STATUSES].sort()).toEqual([
        'blocked',
        'running',
        'stalled',
      ]);
    });

    it('counts none of the terminal statuses', () => {
      for (const done of ['succeeded', 'failed', 'quarantined']) {
        expect(OCCUPYING_STATUSES).not.toContain(done);
      }
    });

    it('asks the database for exactly those', async () => {
      await service.decide([]);

      expect(prisma.run.count).toHaveBeenCalledWith({
        where: { status: { in: OCCUPYING_STATUSES } },
      });
    });
  });

  describe('loading the pool', () => {
    it('counts load with one group-by, not a query per runner', async () => {
      // This runs for every queued work order. A query per runner is how a
      // dispatch path that should be arithmetic becomes an N+1.
      prisma.runner.findMany.mockResolvedValue([
        runnerRow({ key: 'a' }),
        runnerRow({ key: 'b' }),
        runnerRow({ key: 'c' }),
      ]);

      await service.decide([]);

      expect(prisma.run.groupBy).toHaveBeenCalledTimes(1);
    });

    it('attributes live runs to the right runner', async () => {
      prisma.runner.findMany.mockResolvedValue([
        runnerRow({ key: 'busy' }),
        runnerRow({ key: 'idle' }),
      ]);
      prisma.run.groupBy.mockResolvedValue([
        { runnerKey: 'busy', _count: { _all: 2 } },
      ]);

      const decision = await service.decide([]);

      expect(decision.runnerKey).toBe('idle');
    });

    it('treats a runner with no live runs as idle rather than unknown', async () => {
      prisma.run.groupBy.mockResolvedValue([]);

      expect((await service.decide([])).candidates[0].headroom).toBe(2);
    });

    it('drops a runner that registered no capability manifest', async () => {
      // There is nothing to match needs against. Defaulting one would route
      // real work on invented facts.
      prisma.runner.findMany.mockResolvedValue([
        runnerRow({ capability: null }),
      ]);

      const decision = await service.decide([]);

      expect(decision.outcome).toBe('queued');
      expect(decision.queueReason).toBe('no-runners-registered');
    });

    it('says which runner it dropped, rather than dropping it quietly', async () => {
      prisma.runner.findMany.mockResolvedValue([
        runnerRow({ key: 'naked', capability: null }),
      ]);
      const warn = jest.spyOn(service['logger'], 'warn');

      await service.decide([]);

      expect(
        warn.mock.calls.some(([line]) => String(line).includes('naked')),
      ).toBe(true);
    });

    it('recovers availability from the stored manifest (#253)', async () => {
      // `available` has no column — the verbatim manifest is where a field the
      // database does not model yet survives, and the schema says so in as
      // many words. A fact the runner declared, registration wrote down and
      // routing never saw would be the same as a fact nobody recorded, except
      // that this one decides whether work is routed at all.
      prisma.runner.findMany.mockResolvedValue([
        runnerRow({
          capability: {
            ...runnerRow().capability,
            manifest: {
              available: false,
              unavailableReason: '`claude --version` could not be probed',
            },
          },
        }),
      ]);

      const decision = await service.decide([]);

      expect(decision.outcome).toBe('queued');
      expect(decision.reason).toContain('could not be probed');
      // Capacity survives intact: it is unusable, not gone.
      expect(decision.candidates[0].headroom).toBe(2);
    });

    it('routes a runner whose manifest never mentions availability', async () => {
      // Every manifest written before 1.3.0, which is all of them. Absent
      // means available, and a falsy read here would ground the fleet.
      const decision = await service.decide([]);

      expect(decision.outcome).toBe('dispatch');
    });

    it('does not ground a runner over a manifest it cannot read', async () => {
      // The manifest is JSON the database hands back as whatever went in. A
      // parse slip must fail towards routing, not away from it: the schema
      // already refused a malformed manifest at registration, so this is the
      // second line rather than the first.
      for (const manifest of [null, 'not-an-object', ['available'], {}]) {
        prisma.runner.findMany.mockResolvedValue([
          runnerRow({ capability: { ...runnerRow().capability, manifest } }),
        ]);

        expect((await service.decide([])).outcome).toBe('dispatch');
      }
    });

    it('loads runners in a stable order', async () => {
      await service.decide([]);

      expect(prisma.runner.findMany.mock.calls[0][0].orderBy).toEqual({
        key: 'asc',
      });
    });
  });

  describe('the global ceiling', () => {
    it('is off when unconfigured', async () => {
      build(null);
      prisma.run.count.mockResolvedValue(9999);

      expect((await service.decide([])).outcome).toBe('dispatch');
    });

    it('queues the work order once the fleet is at it', async () => {
      build(3);
      prisma.run.count.mockResolvedValue(3);

      expect((await service.decide([])).queueReason).toBe(
        'global-concurrency-reached',
      );
    });
  });

  describe('the decision it returns', () => {
    it('dispatches to a capable runner', async () => {
      const decision = await service.decide([
        'full-streaming',
        'cost-reporting',
      ]);

      expect(decision).toMatchObject({
        outcome: 'dispatch',
        runnerKey: 'claude-code-local',
      });
    });

    it('translates the database row into the seam type faithfully', async () => {
      prisma.runner.findMany.mockResolvedValue([
        runnerRow({
          capability: { ...runnerRow().capability, streamingFidelity: 'none' },
        }),
      ]);

      const decision = await service.decide(['full-streaming']);

      expect(decision.candidates[0].unmetNeeds).toEqual(['full-streaming']);
    });

    it('carries the work-order identity into the log line only', async () => {
      // Routing never branches on it — the identity is for the record.
      const log = jest.spyOn(service['logger'], 'log');

      await service.decide([], 'wo_opifex_312_a3f91c2_a1');

      expect(log.mock.calls[0][0]).toContain('wo_opifex_312_a3f91c2_a1');
    });

    it('warns rather than logs when it cannot place the work order', async () => {
      prisma.runner.findMany.mockResolvedValue([]);
      const warn = jest.spyOn(service['logger'], 'warn');

      await service.decide([]);

      expect(warn).toHaveBeenCalled();
    });
  });

  describe('the restated capability enums', () => {
    it.each([
      ['invocationModel', 'RunnerInvocationModel'],
      ['executionLocus', 'RunnerExecutionLocus'],
      ['streamingFidelity', 'RunnerStreamingFidelity'],
      ['rateLimitSignal', 'RunnerSignalQuality'],
      ['stabilityTier', 'RunnerStabilityTier'],
    ])(
      '%s survives the round trip for every Prisma value',
      async (field, prismaEnum) => {
        // The policy is written against a restated union so it stays pure. That
        // is only safe while the two agree — a value the translation mangled
        // would fail to route with no error anywhere.
        const prisma_ = await import('@prisma/client');
        const values = Object.values(
          (prisma_ as unknown as Record<string, Record<string, string>>)[
            prismaEnum
          ],
        );

        for (const value of values) {
          prisma.runner.findMany.mockResolvedValue([
            runnerRow({
              capability: { ...runnerRow().capability, [field]: value },
            }),
          ]);

          const decision = await service.decide([]);
          expect(decision.candidates).toHaveLength(1);
        }
      },
    );
  });
  describe('the quota position it derives (#105)', () => {
    it('reads a position from blocked runs, with no meter reading present', async () => {
      // The lagging signal on its own, which is what a runner that has never
      // emitted a rate-limit line still has: a run blocked on a rate limit
      // with a reset time in the future. Since #285 it is one of two sources,
      // and `resolveQuotaPosition` takes this one when the meter is silent.
      prisma.run.findMany.mockResolvedValue([blockedRun()]);

      const decision = await service.decide([]);

      expect(decision.outcome).toBe('queued');
      expect(decision.queueReason).toBe('capable-runners-quota-exhausted');
    });

    it('resolves the time comparison here, where the clock lives', async () => {
      // The policy is pure and has no now. A reset that has already passed is
      // no longer a quota fact, and it is THIS class that decides that.
      prisma.run.findMany.mockResolvedValue([
        blockedRun({ blockedUntil: new Date(Date.now() - 60_000) }),
      ]);

      expect((await service.decide([])).outcome).toBe('dispatch');
    });

    it('waits out the jitter too, taking the later of the two dates', async () => {
      // `blockedUntil` is when the vendor said the window rolls; `resumesAt`
      // is that plus #56's jitter. Treating the runner as refilled while the
      // run that found the block is still waiting buys a second block.
      prisma.run.findMany.mockResolvedValue([
        blockedRun({
          blockedUntil: new Date(Date.now() - 60_000),
          resumesAt: new Date(Date.now() + 60_000),
        }),
      ]);

      expect((await service.decide([])).outcome).toBe('queued');
    });

    it('ignores a block that says nothing about quota', async () => {
      // `awaiting-approval` is a fact about one run, not about the
      // subscription. Taking a runner out of service for it would be inventing
      // a quota fact nobody observed.
      prisma.run.findMany.mockResolvedValue([
        blockedRun({ blockedReason: 'awaiting-approval' }),
      ]);

      expect((await service.decide([])).outcome).toBe('dispatch');
    });

    it('treats an unclassifiable block as unknown rather than as exhausted', async () => {
      // VISION §6 cuts this way too: `unknown` is not zero.
      prisma.run.findMany.mockResolvedValue([
        blockedRun({ blockedReason: 'unknown' }),
      ]);

      expect((await service.decide([])).outcome).toBe('dispatch');
    });

    it('leaves an UNDATED quota block to the watchdog rather than parking routing on it', async () => {
      // Nothing can say when it lifts, so marking the runner exhausted would
      // keep it out of routing until a human intervened - turning one undated
      // block into an open-ended refusal to use the fleet's only runner. #56
      // already escalates this case, which is what it needs.
      prisma.run.findMany.mockResolvedValue([
        blockedRun({ blockedUntil: null, resumesAt: null }),
      ]);

      expect((await service.decide([])).outcome).toBe('dispatch');
    });

    it('attributes exhaustion to the runner that reported it, not the fleet', async () => {
      prisma.runner.findMany.mockResolvedValue([
        runnerRow({ key: 'spent' }),
        runnerRow({ key: 'fresh' }),
      ]);
      prisma.run.findMany.mockResolvedValue([
        blockedRun({ runnerKey: 'spent' }),
      ]);

      expect((await service.decide([])).runnerKey).toBe('fresh');
    });

    it('records and logs the avoided park, which is the countable event', async () => {
      // The before-and-after measure #105 is judged by. The arithmetic that
      // turns these into dead time per day is #232's and is not built.
      prisma.runner.findMany.mockResolvedValue([
        runnerRow({ key: 'spent' }),
        runnerRow({ key: 'fresh' }),
      ]);
      prisma.run.findMany.mockResolvedValue([
        blockedRun({ runnerKey: 'spent' }),
      ]);
      const log = jest.spyOn(service['logger'], 'log');

      const decision = await service.decide([], 'wo_opifex_105_a3f91c2_a1');

      expect(decision.avoidedQuotaPark).toBe(true);
      expect(
        log.mock.calls.some(([line]) =>
          String(line).includes('avoided a park'),
        ),
      ).toBe(true);
    });

    it('claims nothing was moved when the whole fleet is spent', async () => {
      // Today's real fleet: one runner (#102/#103 are blocked on the vendor
      // CLI refusing `--cloud` with `--print`). It parks, exactly as before.
      prisma.run.findMany.mockResolvedValue([blockedRun()]);

      const decision = await service.decide([]);

      expect(decision.avoidedQuotaPark).toBe(false);
    });

    it('asks for the whole fleet once, not once per runner', async () => {
      prisma.runner.findMany.mockResolvedValue([
        runnerRow({ key: 'a' }),
        runnerRow({ key: 'b' }),
        runnerRow({ key: 'c' }),
      ]);

      await service.decide([]);

      expect(prisma.run.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.run.findMany.mock.calls[0][0]).toMatchObject({
        where: { status: 'blocked' },
      });
    });

    it('reads only the runner-reported block reasons as quota facts', async () => {
      // Spelled against the wire vocabulary so a rename fails to compile
      // rather than silently matching nothing.
      expect([...QUOTA_BLOCK_REASONS].sort()).toEqual([
        'quota-exhausted',
        'rate-limit',
      ]);
    });
  });

  describe('model tiers (#265)', () => {
    // The tier a runner serves has no column. It lives in the verbatim
    // manifest, and until #265 nothing read it back out — so `servesTier` saw
    // `undefined` for every runner in the fleet, took its "serves any tier"
    // default every time, and the refusal below could not fire in production
    // however well `dispatch-policy.spec.ts` covered it.

    function withManifest(manifest: unknown) {
      prisma.runner.findMany.mockResolvedValue([
        runnerRow({
          key: 'small-only',
          capability: { ...runnerRow().capability, manifest },
        }),
      ]);
    }

    it('refuses a runner that cannot serve the tier the work order asked for', async () => {
      // THE test. Everything else here is a boundary on it.
      withManifest({ modelTiers: ['small'] });

      const decision = await service.decide([], 'wo_x', 'large');

      expect(decision.outcome).toBe('queued');
      expect(decision.candidates[0].eligible).toBe(false);
      expect(decision.candidates[0].reason).toContain(
        "serves model tier(s) small and this work order asked for 'large'",
      );
    });

    it('routes work of a tier the runner does declare', async () => {
      withManifest({ modelTiers: ['small', 'large'] });

      const decision = await service.decide([], 'wo_x', 'large');

      expect(decision).toMatchObject({
        outcome: 'dispatch',
        runnerKey: 'small-only',
      });
    });

    it('leaves the tiers absent when the manifest never mentions them', async () => {
      // Every manifest written before 1.2.0. Absent means ANY, which is what
      // keeps the field additive in behaviour as well as in schema: writing a
      // default list in would make silence indistinguishable from a claim.
      withManifest({});

      const decision = await service.decide([], 'wo_x', 'large');

      expect(decision.outcome).toBe('dispatch');
    });

    it.each([
      ['a bare string', 'large'],
      ['an empty list, which the schema forbids', []],
      ['a tier this build does not know', ['small', 'huge']],
      ['an object', { tier: 'small' }],
      ['numbers', [1, 2]],
      ['an explicit null', null],
    ])('does not let %s change routing', async (_case, modelTiers) => {
      // A malformed value is treated as ABSENT, never repaired. Filtering
      // `['small', 'huge']` down to `['small']` would invent a restriction the
      // runner never declared and refuse work it can do; keeping the unknown
      // string would let a value nothing understands decide a route. Absent
      // restores the documented default and changes nothing.
      withManifest({ modelTiers });

      expect((await service.decide([], 'wo_x', 'large')).outcome).toBe(
        'dispatch',
      );
    });

    it('says out loud that it discarded a declaration', async () => {
      // The fallback is not free: the runner is now being sent work it may
      // have been trying to refuse, and the only other symptom is a dispatch
      // that looks entirely ordinary.
      withManifest({ modelTiers: ['small', 'huge'] });
      const warn = jest.spyOn(service['logger'], 'warn');

      await service.decide([], 'wo_x', 'large');

      expect(
        warn.mock.calls.some(
          ([line]) =>
            String(line).includes('small-only') &&
            String(line).includes('modelTiers'),
        ),
      ).toBe(true);
    });
  });

  describe('the projection into the seam type', () => {
    // #265 was not a missing line, it was a missing test. `servesTier` was
    // right and covered, the stored manifest was right, and the ONE step
    // between them — this projection — was covered for the fields somebody
    // remembered. `available` (#253) escaped the same way and had its round
    // trip added by hand.
    //
    // So the map below is keyed by `keyof RunnerCapabilities`, and that is the
    // load-bearing part: a field added to the seam type and not described here
    // fails to compile, and one described here but left out of the projection
    // fails the assertion. Neither can be forgotten quietly.

    type Projected<K extends keyof RunnerCapabilities> =
      | {
          /** Which part of the stored row the value has to survive. */
          from: 'runner' | 'column' | 'manifest';
          /** The value as the database holds it. */
          stored: unknown;
          /** What a faithful projection must produce. */
          expected: RunnerCapabilities[K];
        }
      // The manifest column itself, kept whole. Its expectation is the
      // document assembled below rather than a literal, so a new
      // manifest-sourced field cannot make this entry stale.
      | { from: 'verbatim' };

    const ROUND_TRIP: {
      [K in keyof RunnerCapabilities]-?: Projected<K>;
    } = {
      key: { from: 'runner', stored: 'projected', expected: 'projected' },
      displayName: {
        from: 'runner',
        stored: 'Projected Runner',
        expected: 'Projected Runner',
      },
      version: { from: 'runner', stored: '9.9.9', expected: '9.9.9' },

      schemaVersion: { from: 'column', stored: '1.3.0', expected: '1.3.0' },
      invocationModel: {
        from: 'column',
        stored: 'http_api',
        expected: 'http_api',
      },
      executionLocus: {
        from: 'column',
        stored: 'vendor_cloud',
        expected: 'vendor_cloud',
      },
      streamingFidelity: {
        from: 'column',
        stored: 'partial',
        expected: 'partial',
      },
      rateLimitSignal: {
        from: 'column',
        stored: 'heuristic',
        expected: 'heuristic',
      },
      stabilityTier: { from: 'column', stored: 'beta', expected: 'beta' },
      reportsCost: { from: 'column', stored: false, expected: false },
      resumable: { from: 'column', stored: true, expected: true },
      maxConcurrency: { from: 'column', stored: 7, expected: 7 },
      branchPatterns: {
        from: 'column',
        stored: ['projected/*'],
        expected: ['projected/*'],
      },

      // The two with no column. Both decide whether work is routed at all,
      // and both reach routing only because something reads them back out.
      modelTiers: {
        from: 'manifest',
        stored: ['small', 'large'],
        expected: ['small', 'large'],
      },
      available: { from: 'manifest', stored: false, expected: false },
      unavailableReason: {
        from: 'manifest',
        stored: 'the CLI could not be probed',
        expected: 'the CLI could not be probed',
      },

      manifest: { from: 'verbatim' },
    };

    /** The stored row, assembled from the map rather than written twice. */
    function stored() {
      const runner: Record<string, unknown> = {};
      const capability: Record<string, unknown> = {};
      const manifest: Record<string, unknown> = {
        // A field nothing models, to prove the column is kept whole and not
        // rebuilt from the fields this projection happens to know about.
        vendor: { anything: 'kept verbatim' },
      };

      for (const [field, spec] of Object.entries(ROUND_TRIP)) {
        if (spec.from === 'runner') runner[field] = spec.stored;
        if (spec.from === 'column') capability[field] = spec.stored;
        if (spec.from === 'manifest') manifest[field] = spec.stored;
      }
      capability.manifest = manifest;

      return { runner, capability, manifest };
    }

    function project(): RunnerCapabilities {
      const row = stored();
      return toCapabilities(
        row.runner as Parameters<typeof toCapabilities>[0],
        row.capability as Parameters<typeof toCapabilities>[1],
        { warn: jest.fn() },
      );
    }

    it.each(Object.keys(ROUND_TRIP))(
      'carries %s from the stored row into the seam type',
      (field) => {
        const key = field as keyof RunnerCapabilities;
        const spec = ROUND_TRIP[key];
        const expected =
          spec.from === 'verbatim' ? stored().manifest : spec.expected;

        // Wrapped in an object so a failure names the field rather than
        // reporting a bare value that could belong to any of them.
        expect({ [key]: project()[key] }).toEqual({ [key]: expected });
      },
    );

    it('produces no field the seam type does not describe', () => {
      // The other direction: an invented field would be one the policy could
      // start reading without anything here having agreed to it.
      expect(Object.keys(project()).sort()).toEqual(
        Object.keys(ROUND_TRIP).sort(),
      );
    });

    it('does not alias the verbatim manifest into the routing input', () => {
      // `manifest` is handed out whole for the record. A `modelTiers` that
      // pointed at the same array would let a consumer mutating one change a
      // routing decision made from the other.
      const capabilities = project();

      expect(capabilities.modelTiers).not.toBe(
        (capabilities.manifest as { modelTiers: unknown }).modelTiers,
      );
    });
  });
});
