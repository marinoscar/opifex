import type { RunnerCapabilities, RunnerNeed } from '../runners/runner.types';
import {
  decideDispatch,
  isPreview,
  satisfies,
  unmetNeeds,
  type DispatchLimits,
  type RunnerPoolEntry,
  type RunnerQuotaPosition,
} from './dispatch-policy';

function capabilities(
  overrides: Partial<RunnerCapabilities> = {},
): RunnerCapabilities {
  return {
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
    ...overrides,
  };
}

function entry(
  overrides: Partial<RunnerCapabilities> = {},
  live = 0,
  enabled = true,
): RunnerPoolEntry {
  return { capabilities: capabilities(overrides), enabled, liveRuns: live };
}

const NO_LIMIT: DispatchLimits = {
  globalMaxConcurrent: null,
  globalLiveRuns: 0,
};

describe('dispatch policy', () => {
  describe('needs match capabilities, never a runner name', () => {
    it.each([
      [
        'full-streaming',
        { streamingFidelity: 'full' },
        { streamingFidelity: 'partial' },
      ],
      ['cost-reporting', { reportsCost: true }, { reportsCost: false }],
      [
        'structured-rate-limits',
        { rateLimitSignal: 'structured' },
        { rateLimitSignal: 'heuristic' },
      ],
      [
        'own-infrastructure',
        { executionLocus: 'own_infrastructure' },
        { executionLocus: 'vendor_cloud' },
      ],
    ] as const)(
      '%s is satisfied by the declaration and nothing else',
      (need, met, unmet) => {
        expect(satisfies(need as RunnerNeed, capabilities(met))).toBe(true);
        expect(satisfies(need as RunnerNeed, capabilities(unmet))).toBe(false);
      },
    );

    it('reports every unmet need, not just the first', () => {
      // An operator fixing one and re-dispatching only to be told about the
      // next stops trusting the message.
      const unmet = unmetNeeds(
        ['full-streaming', 'cost-reporting', 'own-infrastructure'],
        capabilities({ streamingFidelity: 'none', reportsCost: false }),
      );

      expect(unmet).toEqual(['full-streaming', 'cost-reporting']);
    });

    it('takes no input naming a runner', () => {
      // VISION §6: work orders never name a runner. The signature is the
      // enforcement — there is nowhere to put one.
      const decision = decideDispatch({ needs: [] }, [entry()], NO_LIMIT);

      expect(decision.outcome).toBe('dispatch');
    });
  });

  describe('choosing', () => {
    it('dispatches to a runner that meets every need', () => {
      const decision = decideDispatch(
        { needs: ['full-streaming'] },
        [entry()],
        NO_LIMIT,
      );

      expect(decision).toMatchObject({
        outcome: 'dispatch',
        runnerKey: 'claude-code-local',
      });
    });

    it('skips a runner missing a capability and takes one that has it', () => {
      const decision = decideDispatch(
        { needs: ['cost-reporting'] },
        [entry({ key: 'cheap', reportsCost: false }), entry({ key: 'full' })],
        NO_LIMIT,
      );

      expect(decision.runnerKey).toBe('full');
    });

    it('spreads work rather than saturating one runner', () => {
      // A single runner's failure should not take every live run with it.
      const decision = decideDispatch(
        { needs: [] },
        [
          entry({ key: 'busy', maxConcurrency: 4 }, 3),
          entry({ key: 'idle', maxConcurrency: 4 }, 0),
        ],
        NO_LIMIT,
      );

      expect(decision.runnerKey).toBe('idle');
    });

    it('ranks the candidates, so the winner is the head of the list', () => {
      const decision = decideDispatch(
        { needs: [] },
        [entry({ key: 'busy' }, 1), entry({ key: 'idle' }, 0)],
        NO_LIMIT,
      );

      expect(decision.candidates[0].runnerKey).toBe('idle');
      expect(decision.candidates[0].eligible).toBe(true);
    });
  });

  describe('determinism', () => {
    it('breaks a perfect tie the same way every time', () => {
      // Two runners identical on everything must still order the same way, or
      // the recorded reason describes a choice nobody can arrive at again.
      const pool = [entry({ key: 'zeta' }), entry({ key: 'alpha' })];

      expect(decideDispatch({ needs: [] }, pool, NO_LIMIT).runnerKey).toBe(
        'alpha',
      );
      expect(
        decideDispatch({ needs: [] }, [...pool].reverse(), NO_LIMIT).runnerKey,
      ).toBe('alpha');
    });

    it('does not depend on the order the pool arrived in', () => {
      const pool = [
        entry({ key: 'a' }, 2),
        entry({ key: 'b' }, 0),
        entry({ key: 'c' }, 1),
      ];

      const forwards = decideDispatch({ needs: [] }, pool, NO_LIMIT);
      const backwards = decideDispatch(
        { needs: [] },
        [...pool].reverse(),
        NO_LIMIT,
      );

      expect(forwards.runnerKey).toBe(backwards.runnerKey);
      expect(forwards.candidates.map((c) => c.runnerKey)).toEqual(
        backwards.candidates.map((c) => c.runnerKey),
      );
    });

    it('reads no clock', () => {
      // VISION §7 puts dispatch in the always-on hot path. A decision that
      // varied with the time would be unreproducible from its inputs.
      jest.useFakeTimers().setSystemTime(new Date('2027-01-01T00:00:00Z'));
      const later = decideDispatch({ needs: [] }, [entry()], NO_LIMIT);
      jest.useRealTimers();

      expect(later.runnerKey).toBe('claude-code-local');
    });
  });

  describe('concurrency', () => {
    it('will not exceed a runner limit', () => {
      const decision = decideDispatch(
        { needs: [] },
        [entry({ maxConcurrency: 2 }, 2)],
        NO_LIMIT,
      );

      expect(decision.outcome).toBe('queued');
      expect(decision.queueReason).toBe('capable-runners-are-at-capacity');
    });

    it('names the limit it hit', () => {
      const decision = decideDispatch(
        { needs: [] },
        [entry({ maxConcurrency: 2 }, 2)],
        NO_LIMIT,
      );

      expect(decision.reason).toContain('concurrency limit of 2');
    });

    it('enforces a global ceiling across the fleet', () => {
      const decision = decideDispatch({ needs: [] }, [entry()], {
        globalMaxConcurrent: 3,
        globalLiveRuns: 3,
      });

      expect(decision.queueReason).toBe('global-concurrency-reached');
    });

    it('reports the GLOBAL limit rather than blaming a runner', () => {
      // Reporting "runner X is full" when the real limit is the fleet's would
      // send somebody to raise the wrong number.
      const decision = decideDispatch(
        { needs: [] },
        [entry({ maxConcurrency: 9 }, 0)],
        {
          globalMaxConcurrent: 3,
          globalLiveRuns: 3,
        },
      );

      expect(decision.reason).toContain('global limit of 3');
    });

    it('dispatches while under the global ceiling', () => {
      const decision = decideDispatch({ needs: [] }, [entry()], {
        globalMaxConcurrent: 3,
        globalLiveRuns: 2,
      });

      expect(decision.outcome).toBe('dispatch');
    });

    it('treats a null global ceiling as no ceiling', () => {
      const decision = decideDispatch({ needs: [] }, [entry()], {
        globalMaxConcurrent: null,
        globalLiveRuns: 9999,
      });

      expect(decision.outcome).toBe('dispatch');
    });

    it('never reports negative headroom', () => {
      // An over-subscribed runner (a stale row, a manual insert) must read as
      // full rather than as having a negative number of slots.
      const decision = decideDispatch(
        { needs: [] },
        [entry({ maxConcurrency: 1 }, 5)],
        NO_LIMIT,
      );

      expect(decision.candidates[0].headroom).toBe(0);
    });
  });

  describe('model tiers (#205)', () => {
    // VISION §11: "scheduling and model tiering are first-class concerns, not
    // optimizations." A tier is a SIZE, never a model name — naming one would
    // put a vendor's catalogue into the contract every runner speaks.

    it('routes to a runner that serves the requested tier', () => {
      const decision = decideDispatch(
        { needs: [], modelTier: 'small' },
        [entry({ modelTiers: ['small', 'standard'] })],
        NO_LIMIT,
      );

      expect(decision.outcome).toBe('dispatch');
    });

    it('refuses a runner that does not serve it, and says which it does', () => {
      // Refused rather than dispatched-and-hoped: a runner that cannot serve
      // the tier would run the work at whatever size it does have, which is
      // exactly the quota decision VISION §11 wants made deliberately.
      const decision = decideDispatch(
        { needs: [], modelTier: 'large' },
        [entry({ modelTiers: ['small'] })],
        NO_LIMIT,
      );

      expect(decision.outcome).toBe('queued');
      const [candidate] = decision.candidates;
      expect(candidate.eligible).toBe(false);
      expect(candidate.reason).toContain('small');
      expect(candidate.reason).toContain('large');
    });

    it('treats a runner declaring no tiers as serving any', () => {
      // What keeps the field additive in BEHAVIOUR as well as in schema: a
      // runner written before tiers existed stays eligible for work it had
      // been taking all along.
      const decision = decideDispatch(
        { needs: [], modelTier: 'large' },
        [entry({ modelTiers: undefined })],
        NO_LIMIT,
      );

      expect(decision.outcome).toBe('dispatch');
    });

    it('ignores tiers entirely when the work order asked for none', () => {
      const decision = decideDispatch(
        { needs: [] },
        [entry({ modelTiers: ['small'] })],
        NO_LIMIT,
      );

      expect(decision.outcome).toBe('dispatch');
    });

    it('picks the runner that serves the tier over one that does not', () => {
      const decision = decideDispatch(
        { needs: [], modelTier: 'large' },
        [
          entry({ key: 'small-only', modelTiers: ['small'] }),
          entry({ key: 'big', modelTiers: ['large'] }),
        ],
        NO_LIMIT,
      );

      expect(decision.outcome).toBe('dispatch');
      expect(decision.runnerKey).toBe('big');
    });

    it('does not count a stable runner as a GA fallback for a tier it cannot serve', () => {
      // The subtle one. VISION §11 requires "every preview runner needs a GA
      // fallback accepting IDENTICAL work orders" — and a stable runner that
      // cannot serve the requested tier cannot accept this one. Counting it
      // anyway is how a fleet ends up load-bearing on a preview runner.
      const decision = decideDispatch(
        { needs: [], modelTier: 'large' },
        [
          entry({
            key: 'preview',
            stabilityTier: 'experimental',
            modelTiers: ['large'],
          }),
          entry({
            key: 'stable-small',
            stabilityTier: 'stable',
            modelTiers: ['small'],
          }),
        ],
        NO_LIMIT,
      );

      expect(decision.outcome).toBe('queued');
      const preview = decision.candidates.find(
        (c) => c.runnerKey === 'preview',
      );
      expect(preview?.reason).toContain('load-bearing');
    });
  });

  describe('the preview acknowledgement (ADR 0007)', () => {
    // A single-runner fleet cannot satisfy VISION §11's GA-fallback rule, and
    // VISION §3.7 forbids building the second runner to satisfy it. The
    // acknowledgement keeps "never SILENTLY load-bearing" and gives up "never
    // load-bearing", which is unreachable by construction.
    const ACKNOWLEDGED: DispatchLimits = {
      ...NO_LIMIT,
      allowPreviewWithoutGaFallback: true,
    };

    it('still refuses by default, because a bypass that defaults on is not a rule', () => {
      const decision = decideDispatch(
        { needs: ['full-streaming'] },
        [entry({ key: 'claude-code-local', stabilityTier: 'experimental' })],
        NO_LIMIT,
      );

      expect(decision.outcome).toBe('queued');
      expect(decision.queueReason).toBe(
        'only-preview-runners-and-no-ga-fallback',
      );
    });

    it('dispatches to the only runner once the operator has acknowledged it', () => {
      const decision = decideDispatch(
        { needs: ['full-streaming', 'own-infrastructure'] },
        [entry({ key: 'claude-code-local', stabilityTier: 'experimental' })],
        ACKNOWLEDGED,
      );

      expect(decision.outcome).toBe('dispatch');
      expect(decision.runnerKey).toBe('claude-code-local');
    });

    it('records WHY it was allowed, not just that it was', () => {
      // #64 requires the decision be reconstructible from the reason alone.
      // "This ran on a preview runner because somebody accepted that" is the
      // fact a reader six weeks later cannot recover from anywhere else.
      const decision = decideDispatch(
        { needs: [] },
        [entry({ key: 'claude-code-local', stabilityTier: 'experimental' })],
        ACKNOWLEDGED,
      );

      const chosen = decision.candidates.find(
        (c) => c.runnerKey === 'claude-code-local',
      );
      expect(chosen?.reason).toContain('acknowledged');
      expect(chosen?.reason).toContain('experimental');
    });

    it('does not override anything except the fallback rule', () => {
      // The acknowledgement is about tier alone. A runner that cannot do the
      // work is still ineligible, and letting this flag paper over an unmet
      // need would route work to a runner that will fail at it.
      const decision = decideDispatch(
        { needs: ['cost-reporting'] },
        [
          entry({
            key: 'claude-code-local',
            stabilityTier: 'experimental',
            reportsCost: false,
          }),
        ],
        ACKNOWLEDGED,
      );

      expect(decision.outcome).toBe('queued');
      expect(decision.queueReason).toBe('no-runner-has-the-capabilities');
    });

    it("still respects the runner's own concurrency ceiling", () => {
      const decision = decideDispatch(
        { needs: [] },
        [
          entry(
            {
              key: 'claude-code-local',
              stabilityTier: 'experimental',
              maxConcurrency: 1,
            },
            1,
          ),
        ],
        ACKNOWLEDGED,
      );

      expect(decision.outcome).toBe('queued');
      expect(decision.queueReason).toBe('capable-runners-are-at-capacity');
    });

    it('still respects the global fleet ceiling', () => {
      const decision = decideDispatch(
        { needs: [] },
        [entry({ key: 'claude-code-local', stabilityTier: 'experimental' })],
        {
          globalMaxConcurrent: 1,
          globalLiveRuns: 1,
          allowPreviewWithoutGaFallback: true,
        },
      );

      expect(decision.outcome).toBe('queued');
      expect(decision.queueReason).toBe('global-concurrency-reached');
    });

    it('still prefers a GA runner when one exists', () => {
      // The acknowledgement is a floor, not a preference. A fleet that has a
      // stable runner must not start choosing the preview one because the
      // flag happens to be set.
      const decision = decideDispatch(
        { needs: [] },
        [
          entry({
            key: 'preview',
            stabilityTier: 'experimental',
            maxConcurrency: 9,
          }),
          entry({ key: 'ga', stabilityTier: 'stable', maxConcurrency: 1 }),
        ],
        ACKNOWLEDGED,
      );

      // Headroom still ranks, so `preview` wins on slots — what matters is
      // that `ga` is eligible and the acknowledgement changed nothing for it.
      const ga = decision.candidates.find((c) => c.runnerKey === 'ga');
      expect(ga?.eligible).toBe(true);
      expect(ga?.reason).not.toContain('acknowledged');
    });

    it('leaves a disabled preview runner disabled', () => {
      const decision = decideDispatch(
        { needs: [] },
        [
          {
            capabilities: capabilities({ stabilityTier: 'experimental' }),
            enabled: false,
            liveRuns: 0,
          },
        ],
        ACKNOWLEDGED,
      );

      expect(decision.outcome).toBe('queued');
    });
  });

  describe('preview runners are never load-bearing', () => {
    it.each(['experimental', 'beta'] as const)(
      'treats %s as preview',
      (tier) => {
        expect(isPreview(capabilities({ stabilityTier: tier }))).toBe(true);
      },
    );

    it('treats stable as GA', () => {
      expect(isPreview(capabilities({ stabilityTier: 'stable' }))).toBe(false);
    });

    it('refuses a preview runner when nothing GA could take the work', () => {
      // VISION §11: every preview runner needs a GA fallback accepting
      // identical work orders.
      const decision = decideDispatch(
        { needs: [] },
        [entry({ key: 'preview', stabilityTier: 'beta' })],
        NO_LIMIT,
      );

      expect(decision.outcome).toBe('queued');
      expect(decision.queueReason).toBe(
        'only-preview-runners-and-no-ga-fallback',
      );
    });

    it('allows a preview runner once a GA one could take the same work order', () => {
      const decision = decideDispatch(
        { needs: [] },
        [
          entry({ key: 'preview', stabilityTier: 'beta', maxConcurrency: 9 }),
          entry({ key: 'ga', stabilityTier: 'stable', maxConcurrency: 1 }),
        ],
        NO_LIMIT,
      );

      // Preview wins on headroom, which is fine — it is not load-bearing,
      // because `ga` could take this work order if it vanished.
      expect(decision.outcome).toBe('dispatch');
      expect(decision.runnerKey).toBe('preview');
    });

    it('counts a FULL GA runner as a fallback', () => {
      // A fallback that is momentarily busy is still a fallback. The question
      // is "could a GA runner take this work order", not "is one free now".
      const decision = decideDispatch(
        { needs: [] },
        [
          entry({ key: 'preview', stabilityTier: 'beta' }),
          entry({ key: 'ga', stabilityTier: 'stable', maxConcurrency: 1 }, 1),
        ],
        NO_LIMIT,
      );

      expect(decision.runnerKey).toBe('preview');
    });

    it('does NOT count a GA runner that cannot meet the needs', () => {
      // One that cannot take this work order was never a fallback for it.
      const decision = decideDispatch(
        { needs: ['full-streaming'] },
        [
          entry({
            key: 'preview',
            stabilityTier: 'beta',
            streamingFidelity: 'full',
          }),
          entry({
            key: 'ga',
            stabilityTier: 'stable',
            streamingFidelity: 'none',
          }),
        ],
        NO_LIMIT,
      );

      expect(decision.outcome).toBe('queued');
      expect(decision.queueReason).toBe(
        'only-preview-runners-and-no-ga-fallback',
      );
    });

    it('says the fleet would become load-bearing on a preview', () => {
      const decision = decideDispatch(
        { needs: [] },
        [entry({ key: 'preview', stabilityTier: 'experimental' })],
        NO_LIMIT,
      );

      expect(decision.reason).toContain('load-bearing');
    });

    it('prefers nothing over a preview runner, rather than dispatching anyway', () => {
      expect(
        decideDispatch(
          { needs: [] },
          [entry({ stabilityTier: 'beta' })],
          NO_LIMIT,
        ).runnerKey,
      ).toBeNull();
    });
  });

  describe('queueing rather than failing', () => {
    it('queues when no runner has the capabilities', () => {
      // #64: "a work order with no capable runner queues with a clear reason
      // rather than failing." A failure would need a human to re-dispatch it
      // once a runner appeared.
      const decision = decideDispatch(
        { needs: ['full-streaming'] },
        [entry({ streamingFidelity: 'none' })],
        NO_LIMIT,
      );

      expect(decision).toMatchObject({
        outcome: 'queued',
        runnerKey: null,
        queueReason: 'no-runner-has-the-capabilities',
      });
    });

    it('queues when nothing is registered at all', () => {
      expect(decideDispatch({ needs: [] }, [], NO_LIMIT).queueReason).toBe(
        'no-runners-registered',
      );
    });

    it('distinguishes disabled runners from an empty fleet', () => {
      // Different fixes: one needs a runner registered, the other needs a
      // switch flipped.
      const decision = decideDispatch(
        { needs: [] },
        [entry({}, 0, false)],
        NO_LIMIT,
      );

      expect(decision.reason).toContain('disabled');
    });

    it('reports the failure that needs the most action', () => {
      // "Nothing can meet these needs" needs a runner registered; "everything
      // capable is busy" needs only patience. Reporting the milder of the two
      // would understate the problem.
      const decision = decideDispatch(
        { needs: ['cost-reporting'] },
        [entry({ key: 'incapable', reportsCost: false }, 0)],
        NO_LIMIT,
      );

      expect(decision.queueReason).toBe('no-runner-has-the-capabilities');
    });

    it('reports capacity when the capable runners are merely busy', () => {
      const decision = decideDispatch(
        { needs: ['cost-reporting'] },
        [
          entry({ key: 'incapable', reportsCost: false }),
          entry({ key: 'busy', maxConcurrency: 1 }, 1),
        ],
        NO_LIMIT,
      );

      expect(decision.queueReason).toBe('capable-runners-are-at-capacity');
    });
  });

  describe('the reasoning is the record', () => {
    it('names the winner, the needs and the headroom', () => {
      // #47's standard, applied here: a reviewer reconstructs the decision
      // from this line alone, without reading code.
      const decision = decideDispatch(
        { needs: ['full-streaming', 'cost-reporting'] },
        [entry({ maxConcurrency: 3 }, 1)],
        NO_LIMIT,
      );

      expect(decision.reason).toContain('claude-code-local');
      expect(decision.reason).toContain('full-streaming, cost-reporting');
      expect(decision.reason).toContain('2 slot(s) free');
    });

    it('records a verdict for every runner considered, not only the winner', () => {
      const decision = decideDispatch(
        { needs: [] },
        [entry({ key: 'a' }), entry({ key: 'b' }), entry({ key: 'c' })],
        NO_LIMIT,
      );

      expect(decision.candidates).toHaveLength(3);
      expect(decision.candidates.every((c) => c.reason.length > 0)).toBe(true);
    });

    it('names the specific missing capability on a rejection', () => {
      const decision = decideDispatch(
        { needs: ['cost-reporting'] },
        [entry({ reportsCost: false })],
        NO_LIMIT,
      );

      expect(decision.candidates[0].reason).toContain('cost-reporting');
      expect(decision.candidates[0].unmetNeeds).toEqual(['cost-reporting']);
    });

    it('explains a queued decision by listing what each runner did wrong', () => {
      const decision = decideDispatch(
        { needs: ['cost-reporting'] },
        [
          entry({ key: 'a', reportsCost: false }),
          entry({ key: 'b', reportsCost: false }),
        ],
        NO_LIMIT,
      );

      expect(decision.reason).toContain('a does not advertise');
      expect(decision.reason).toContain('b does not advertise');
    });

    it('says so plainly when a work order declares no needs', () => {
      expect(
        decideDispatch({ needs: [] }, [entry()], NO_LIMIT).reason,
      ).toContain('no specific capabilities');
    });
  });
  describe('quota-aware routing (#105)', () => {
    // Already resolved against a clock by the caller. `resumesAt` is a
    // pre-formatted string precisely so nothing in the policy can compare it.
    const EXHAUSTED: RunnerQuotaPosition = {
      exhausted: true,
      resumesAt: '2026-08-23T18:00:00.000Z',
      basis:
        "1 run(s) on this runner are blocked on 'rate-limit' with a reset time",
    };

    function withQuota(
      base: RunnerPoolEntry,
      quota?: RunnerQuotaPosition,
    ): RunnerPoolEntry {
      return { ...base, quota };
    }

    describe('a two-runner fleet, which is the whole point of the feature', () => {
      // There is exactly ONE registered runner today (`claude-code-local`);
      // #102/#103's cloud runner is blocked because the vendor CLI refuses
      // `--cloud` with `--print`. So this behaviour cannot fire against the
      // real fleet yet, and the fixture is what carries it: the policy takes a
      // plain array, so proving it costs nothing but two entries.
      const pool = [
        withQuota(entry({ key: 'spent' }), EXHAUSTED),
        withQuota(entry({ key: 'fresh' })),
      ];

      it('moves the work to the runner with quota rather than parking it', () => {
        const decision = decideDispatch({ needs: [] }, pool, NO_LIMIT);

        expect(decision).toMatchObject({
          outcome: 'dispatch',
          runnerKey: 'fresh',
        });
      });

      it('records that a park was avoided, which is the countable event', () => {
        // VISION §10's metric 2 is dead time per day, and its arithmetic waits
        // on #232. This is the event that arithmetic will count.
        expect(
          decideDispatch({ needs: [] }, pool, NO_LIMIT).avoidedQuotaPark,
        ).toBe(true);
      });

      it('says so in the reason, not only in a boolean', () => {
        const decision = decideDispatch({ needs: [] }, pool, NO_LIMIT);

        expect(decision.reason).toContain('avoided a park');
        expect(decision.reason).toContain('spent');
      });

      it('prefers the runner with quota even when the spent one has more headroom', () => {
        // Headroom is the tiebreaker among USABLE runners. A runner that
        // cannot spend a token has no usable headroom at all.
        const decision = decideDispatch(
          { needs: [] },
          [
            withQuota(entry({ key: 'spent', maxConcurrency: 8 }), EXHAUSTED),
            withQuota(entry({ key: 'fresh', maxConcurrency: 1 })),
          ],
          NO_LIMIT,
        );

        expect(decision.runnerKey).toBe('fresh');
      });
    });

    describe('quota is a tiebreaker among capable runners, never an override', () => {
      it('will not send work to an incapable runner because it has quota', () => {
        // The acceptance criterion stated as a test: an incapable runner with
        // quota against a capable one without it must QUEUE. Structurally
        // guaranteed — the quota check runs after `unmetNeeds`, so a runner
        // missing a capability is already rejected when quota is looked at.
        const decision = decideDispatch(
          { needs: ['cost-reporting'] },
          [
            withQuota(entry({ key: 'incapable', reportsCost: false })),
            withQuota(entry({ key: 'capable' }), EXHAUSTED),
          ],
          NO_LIMIT,
        );

        expect(decision.outcome).toBe('queued');
        expect(decision.runnerKey).toBeNull();
      });

      it('will not relax a model tier for quota either', () => {
        const decision = decideDispatch(
          { needs: [], modelTier: 'large' },
          [
            withQuota(entry({ key: 'small-only', modelTiers: ['small'] })),
            withQuota(entry({ key: 'big', modelTiers: ['large'] }), EXHAUSTED),
          ],
          NO_LIMIT,
        );

        expect(decision.outcome).toBe('queued');
      });

      it('does not count an incapable runner as a park this feature avoided', () => {
        // It was never an alternative, so nothing moved off it. Counting it
        // would inflate the one number #105 is judged by.
        const decision = decideDispatch(
          { needs: ['cost-reporting'] },
          [
            withQuota(
              entry({ key: 'incapable', reportsCost: false }),
              EXHAUSTED,
            ),
            withQuota(entry({ key: 'capable' })),
          ],
          NO_LIMIT,
        );

        expect(decision.outcome).toBe('dispatch');
        expect(decision.avoidedQuotaPark).toBe(false);
      });

      it('never returns an exhausted acknowledged preview runner as eligible', () => {
        // The preview branch can return ELIGIBLE, which is why the quota check
        // sits in front of it rather than after.
        const decision = decideDispatch(
          { needs: [] },
          [
            withQuota(
              entry({ key: 'preview', stabilityTier: 'beta' }),
              EXHAUSTED,
            ),
          ],
          { ...NO_LIMIT, allowPreviewWithoutGaFallback: true },
        );

        expect(decision.outcome).toBe('queued');
        expect(decision.queueReason).toBe('capable-runners-quota-exhausted');
      });
    });

    describe('unknown is not zero', () => {
      it('routes freely to a runner that has never blocked', () => {
        // VISION §6. A runner with no observed quota position is usable; the
        // absent field is what says so.
        const decision = decideDispatch({ needs: [] }, [entry()], NO_LIMIT);

        expect(decision.outcome).toBe('dispatch');
        expect(decision.candidates[0].quota).toBeUndefined();
      });

      it('routes to a runner whose position says it is NOT exhausted', () => {
        // The shape #231 will populate once a real meter exists.
        const decision = decideDispatch(
          { needs: [] },
          [
            withQuota(entry(), {
              exhausted: false,
              resumesAt: null,
              basis: 'no dated quota block observed',
            }),
          ],
          NO_LIMIT,
        );

        expect(decision.outcome).toBe('dispatch');
      });
    });

    describe('falling back to parking, cleanly', () => {
      const soleRunner = [withQuota(entry({ key: 'only' }), EXHAUSTED)];

      it('queues rather than failing when the only capable runner is spent', () => {
        // Today's real fleet. One runner out of quota still parks, exactly as
        // #56 already handles — this feature adds a better REASON, not a
        // failure and not a dispatch into a spent quota.
        const decision = decideDispatch({ needs: [] }, soleRunner, NO_LIMIT);

        expect(decision).toMatchObject({
          outcome: 'queued',
          runnerKey: null,
          queueReason: 'capable-runners-quota-exhausted',
          avoidedQuotaPark: false,
        });
      });

      it('names the reset time, so the wait is dated rather than open-ended', () => {
        const decision = decideDispatch({ needs: [] }, soleRunner, NO_LIMIT);

        expect(decision.candidates[0].reason).toContain(
          '2026-08-23T18:00:00.000Z',
        );
        expect(decision.reason).toContain('2026-08-23T18:00:00.000Z');
      });

      it('distinguishes out-of-quota from no-capable-runner', () => {
        // Different operator responses: one is patience with a known end, the
        // other is a runner nobody has registered.
        const spent = decideDispatch({ needs: [] }, soleRunner, NO_LIMIT);
        const missing = decideDispatch(
          { needs: ['cost-reporting'] },
          [entry({ reportsCost: false })],
          NO_LIMIT,
        );

        expect(spent.queueReason).toBe('capable-runners-quota-exhausted');
        expect(missing.queueReason).toBe('no-runner-has-the-capabilities');
      });

      it('reports quota rather than capacity when both are in play', () => {
        // A full runner frees a slot on its own; an exhausted one waits on a
        // vendor window. `diagnose` reports the one that needs the most
        // action, and that is the second.
        const decision = decideDispatch(
          { needs: [] },
          [
            withQuota(entry({ key: 'busy', maxConcurrency: 1 }, 1)),
            withQuota(entry({ key: 'spent' }), EXHAUSTED),
          ],
          NO_LIMIT,
        );

        expect(decision.queueReason).toBe('capable-runners-quota-exhausted');
      });

      it('still reports plain capacity when no quota is spent', () => {
        const decision = decideDispatch(
          { needs: [] },
          [withQuota(entry({ key: 'busy', maxConcurrency: 1 }, 1))],
          NO_LIMIT,
        );

        expect(decision.queueReason).toBe('capable-runners-are-at-capacity');
      });
    });

    describe('still a pure function', () => {
      it('reads no clock, even though the fact it acts on is about time', () => {
        // The comparison happened in `DispatchService.loadPool`. Winding the
        // clock past the reset changes nothing here — if this test started
        // dispatching, a `new Date()` had crept into the policy.
        jest.useFakeTimers().setSystemTime(new Date('2099-01-01T00:00:00Z'));
        const decision = decideDispatch(
          { needs: [] },
          [withQuota(entry(), EXHAUSTED)],
          NO_LIMIT,
        );
        jest.useRealTimers();

        expect(decision.queueReason).toBe('capable-runners-quota-exhausted');
      });

      it('decides identically from identical inputs', () => {
        const pool = [
          withQuota(entry({ key: 'spent' }), EXHAUSTED),
          withQuota(entry({ key: 'fresh' })),
        ];

        expect(decideDispatch({ needs: [] }, pool, NO_LIMIT)).toEqual(
          decideDispatch({ needs: [] }, [...pool].reverse(), NO_LIMIT),
        );
      });

      it('takes no runner name, quota or not', () => {
        // #105 keeps VISION §6 intact: the input is still needs plus a pool.
        const decision = decideDispatch(
          { needs: [], identity: 'wo_opifex_105_a3f91c2_a1' },
          [withQuota(entry({ key: 'spent' }), EXHAUSTED), entry({ key: 'ok' })],
          NO_LIMIT,
        );

        expect(decision.runnerKey).toBe('ok');
      });
    });

    describe('the position is part of the record', () => {
      it('carries the observed position onto the verdict it decided', () => {
        const decision = decideDispatch(
          { needs: [] },
          [withQuota(entry(), EXHAUSTED)],
          NO_LIMIT,
        );

        expect(decision.candidates[0].quota).toEqual(EXHAUSTED);
      });

      it('names the basis, so the reason does not assert a bare fact', () => {
        const decision = decideDispatch(
          { needs: [] },
          [withQuota(entry(), EXHAUSTED)],
          NO_LIMIT,
        );

        expect(decision.candidates[0].reason).toContain('blocked on');
      });
    });
  });
});
