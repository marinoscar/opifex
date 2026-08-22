import type { RunnerCapabilities, RunnerNeed } from '../runners/runner.types';
import {
  decideDispatch,
  isPreview,
  satisfies,
  unmetNeeds,
  type DispatchLimits,
  type RunnerPoolEntry,
} from './dispatch-policy';

function capabilities(overrides: Partial<RunnerCapabilities> = {}): RunnerCapabilities {
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

function entry(overrides: Partial<RunnerCapabilities> = {}, live = 0, enabled = true): RunnerPoolEntry {
  return { capabilities: capabilities(overrides), enabled, liveRuns: live };
}

const NO_LIMIT: DispatchLimits = { globalMaxConcurrent: null, globalLiveRuns: 0 };

describe('dispatch policy', () => {
  describe('needs match capabilities, never a runner name', () => {
    it.each([
      ['full-streaming', { streamingFidelity: 'full' }, { streamingFidelity: 'partial' }],
      ['cost-reporting', { reportsCost: true }, { reportsCost: false }],
      ['structured-rate-limits', { rateLimitSignal: 'structured' }, { rateLimitSignal: 'heuristic' }],
      ['own-infrastructure', { executionLocus: 'own_infrastructure' }, { executionLocus: 'vendor_cloud' }],
    ] as const)('%s is satisfied by the declaration and nothing else', (need, met, unmet) => {
      expect(satisfies(need as RunnerNeed, capabilities(met))).toBe(true);
      expect(satisfies(need as RunnerNeed, capabilities(unmet))).toBe(false);
    });

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
      const decision = decideDispatch({ needs: ['full-streaming'] }, [entry()], NO_LIMIT);

      expect(decision).toMatchObject({ outcome: 'dispatch', runnerKey: 'claude-code-local' });
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
        [entry({ key: 'busy', maxConcurrency: 4 }, 3), entry({ key: 'idle', maxConcurrency: 4 }, 0)],
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

      expect(decideDispatch({ needs: [] }, pool, NO_LIMIT).runnerKey).toBe('alpha');
      expect(decideDispatch({ needs: [] }, [...pool].reverse(), NO_LIMIT).runnerKey).toBe('alpha');
    });

    it('does not depend on the order the pool arrived in', () => {
      const pool = [entry({ key: 'a' }, 2), entry({ key: 'b' }, 0), entry({ key: 'c' }, 1)];

      const forwards = decideDispatch({ needs: [] }, pool, NO_LIMIT);
      const backwards = decideDispatch({ needs: [] }, [...pool].reverse(), NO_LIMIT);

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
      const decision = decideDispatch({ needs: [] }, [entry({ maxConcurrency: 2 }, 2)], NO_LIMIT);

      expect(decision.outcome).toBe('queued');
      expect(decision.queueReason).toBe('capable-runners-are-at-capacity');
    });

    it('names the limit it hit', () => {
      const decision = decideDispatch({ needs: [] }, [entry({ maxConcurrency: 2 }, 2)], NO_LIMIT);

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
      const decision = decideDispatch({ needs: [] }, [entry({ maxConcurrency: 9 }, 0)], {
        globalMaxConcurrent: 3,
        globalLiveRuns: 3,
      });

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
      const decision = decideDispatch({ needs: [] }, [entry({ maxConcurrency: 1 }, 5)], NO_LIMIT);

      expect(decision.candidates[0].headroom).toBe(0);
    });
  });

  describe('preview runners are never load-bearing', () => {
    it.each(['experimental', 'beta'] as const)('treats %s as preview', (tier) => {
      expect(isPreview(capabilities({ stabilityTier: tier }))).toBe(true);
    });

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
      expect(decision.queueReason).toBe('only-preview-runners-and-no-ga-fallback');
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
          entry({ key: 'preview', stabilityTier: 'beta', streamingFidelity: 'full' }),
          entry({ key: 'ga', stabilityTier: 'stable', streamingFidelity: 'none' }),
        ],
        NO_LIMIT,
      );

      expect(decision.outcome).toBe('queued');
      expect(decision.queueReason).toBe('only-preview-runners-and-no-ga-fallback');
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
        decideDispatch({ needs: [] }, [entry({ stabilityTier: 'beta' })], NO_LIMIT).runnerKey,
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
      expect(decideDispatch({ needs: [] }, [], NO_LIMIT).queueReason).toBe('no-runners-registered');
    });

    it('distinguishes disabled runners from an empty fleet', () => {
      // Different fixes: one needs a runner registered, the other needs a
      // switch flipped.
      const decision = decideDispatch({ needs: [] }, [entry({}, 0, false)], NO_LIMIT);

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
        [entry({ key: 'incapable', reportsCost: false }), entry({ key: 'busy', maxConcurrency: 1 }, 1)],
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
        [entry({ key: 'a', reportsCost: false }), entry({ key: 'b', reportsCost: false })],
        NO_LIMIT,
      );

      expect(decision.reason).toContain('a does not advertise');
      expect(decision.reason).toContain('b does not advertise');
    });

    it('says so plainly when a work order declares no needs', () => {
      expect(decideDispatch({ needs: [] }, [entry()], NO_LIMIT).reason).toContain(
        'no specific capabilities',
      );
    });
  });
});
