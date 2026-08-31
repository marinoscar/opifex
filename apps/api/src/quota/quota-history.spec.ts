import type { RunStatus } from '@prisma/client';

import type { BlockedReason } from '../run-events/run-event.types';
import { QUOTA_BLOCK_REASONS } from '../dispatch/dispatch.service';
import {
  RATE_LIMIT_REASONS,
  boundedAt,
  deriveDisposition,
  episodeEscalation,
  matchWindow,
  toEpisode,
  type EpisodeEscalation,
  type EpisodeFacts,
  type EpisodeWindow,
} from './quota-history';

/**
 * The pure interpretation layer for #476. No Prisma, no Nest — every case
 * here is a plain object in and a plain object out, which is the whole point
 * of splitting this file from `quota-history.service.ts` in the first place.
 */
describe('quota-history (pure)', () => {
  const OCCURRED_AT = new Date('2026-08-25T10:00:00.000Z');

  function facts(overrides: Partial<EpisodeFacts> = {}): EpisodeFacts {
    return {
      eventId: 'event-1',
      occurredAt: OCCURRED_AT,
      blockedUntil: new Date('2026-08-25T15:00:00.000Z'),
      reason: 'rate-limit',
      runId: 'run-1',
      runnerKey: 'claude-code-local',
      runStatus: 'blocked',
      runResumesAt: null,
      runEndedAt: null,
      runLastEventAt: null,
      workOrderIdentity: 'WO-1',
      repository: 'acme/widgets',
      issueNumber: 42,
      nextBlockAt: null,
      escalations: [],
      window: null,
      ...overrides,
    };
  }

  function escalation(
    overrides: Partial<EpisodeEscalation> = {},
  ): EpisodeEscalation {
    return {
      kind: 'system',
      status: 'open',
      raisedAt: new Date('2026-08-25T10:30:00.000Z'),
      summary: 'undated block, patience exceeded',
      ...overrides,
    };
  }

  // ---------------------------------------------------------------------
  // RATE_LIMIT_REASONS parity with dispatch.service.ts
  // ---------------------------------------------------------------------

  describe('RATE_LIMIT_REASONS', () => {
    it('agrees with QUOTA_BLOCK_REASONS in dispatch.service.ts', () => {
      // Restated rather than imported — importing back would close an ES
      // module cycle, since `dispatch.service.ts` value-imports
      // `quota/quota-window.ts` (see this file's own doc comment). Nothing
      // else joins the two lists, so a rename in one that is not mirrored in
      // the other would silently make the endpoint's filter and dispatch's
      // routing disagree about what "quota" means.
      expect([...RATE_LIMIT_REASONS].sort()).toEqual(
        [...QUOTA_BLOCK_REASONS].sort(),
      );
    });

    it('is a subset of the wire BlockedReason vocabulary', () => {
      const reasons: readonly BlockedReason[] = RATE_LIMIT_REASONS;
      expect(reasons).toEqual(['rate-limit', 'quota-exhausted']);
    });
  });

  // ---------------------------------------------------------------------
  // boundedAt
  // ---------------------------------------------------------------------

  describe('boundedAt', () => {
    it('bounds an earlier block by the run’s next block', () => {
      const nextBlockAt = new Date('2026-08-25T16:00:00.000Z');
      expect(boundedAt(facts({ nextBlockAt }))).toEqual(nextBlockAt);
    });

    it('prefers nextBlockAt even when runLastEventAt is also later', () => {
      // nextBlockAt is the tighter, more certain bound — a run cannot block
      // again without having run again, whereas lastEventAt just says
      // "something happened eventually".
      const nextBlockAt = new Date('2026-08-25T12:00:00.000Z');
      const runLastEventAt = new Date('2026-08-25T18:00:00.000Z');
      expect(boundedAt(facts({ nextBlockAt, runLastEventAt }))).toEqual(
        nextBlockAt,
      );
    });

    it('bounds the latest block by runLastEventAt when strictly later', () => {
      const runLastEventAt = new Date('2026-08-25T11:00:00.000Z');
      expect(boundedAt(facts({ nextBlockAt: null, runLastEventAt }))).toEqual(
        runLastEventAt,
      );
    });

    it('is null when lastEventAt equals occurredAt — the block IS the last event', () => {
      expect(
        boundedAt(facts({ nextBlockAt: null, runLastEventAt: OCCURRED_AT })),
      ).toBeNull();
    });

    it('is null when lastEventAt is before occurredAt', () => {
      const earlier = new Date('2026-08-25T09:00:00.000Z');
      expect(
        boundedAt(facts({ nextBlockAt: null, runLastEventAt: earlier })),
      ).toBeNull();
    });

    it('is null with no next block and no later activity at all', () => {
      expect(
        boundedAt(facts({ nextBlockAt: null, runLastEventAt: null })),
      ).toBeNull();
    });
  });

  // ---------------------------------------------------------------------
  // episodeEscalation
  // ---------------------------------------------------------------------

  describe('episodeEscalation', () => {
    it('finds a system escalation raised inside the (bounded) window', () => {
      const nextBlockAt = new Date('2026-08-25T16:00:00.000Z');
      const raised = escalation({
        raisedAt: new Date('2026-08-25T12:00:00.000Z'),
      });
      const result = episodeEscalation(
        facts({ nextBlockAt, escalations: [raised] }),
      );
      expect(result).toEqual(raised);
    });

    it('ignores an escalation raised before the block', () => {
      const before = escalation({
        raisedAt: new Date('2026-08-25T09:00:00.000Z'),
      });
      expect(episodeEscalation(facts({ escalations: [before] }))).toBeNull();
    });

    it('ignores an escalation raised after the episode bound', () => {
      const nextBlockAt = new Date('2026-08-25T16:00:00.000Z');
      const after = escalation({
        raisedAt: new Date('2026-08-25T17:00:00.000Z'),
      });
      expect(
        episodeEscalation(facts({ nextBlockAt, escalations: [after] })),
      ).toBeNull();
    });

    it('counts anything after the block when the episode is unbounded', () => {
      // No nextBlockAt, no runLastEventAt after occurredAt: the run is still
      // sitting in this episode, so everything after the block counts.
      const late = escalation({
        raisedAt: new Date('2028-01-01T00:00:00.000Z'),
      });
      expect(
        episodeEscalation(
          facts({
            nextBlockAt: null,
            runLastEventAt: null,
            escalations: [late],
          }),
        ),
      ).toEqual(late);
    });

    it('does NOT attribute a non-system escalation to the episode', () => {
      // This is the deliberate restriction: a `budget_exceeded` (or
      // `run_stalled`) escalation raised while the run happened to be
      // parked is a real event, but it is not what Opifex did about the
      // rate limit.
      const budgetExceeded = escalation({
        kind: 'budget_exceeded',
        raisedAt: new Date('2026-08-25T12:00:00.000Z'),
      });
      expect(
        episodeEscalation(facts({ escalations: [budgetExceeded] })),
      ).toBeNull();
    });

    it('picks the earliest system escalation when several land inside the window', () => {
      const later = escalation({
        raisedAt: new Date('2026-08-25T14:00:00.000Z'),
        summary: 'later',
      });
      const earlier = escalation({
        raisedAt: new Date('2026-08-25T11:00:00.000Z'),
        summary: 'earlier',
      });
      const result = episodeEscalation(
        facts({ escalations: [later, earlier] }),
      );
      expect(result?.summary).toBe('earlier');
    });
  });

  // ---------------------------------------------------------------------
  // deriveDisposition — precedence, branch by branch
  // ---------------------------------------------------------------------

  describe('deriveDisposition', () => {
    it('escalated wins even when the run is also parked', () => {
      const raised = escalation();
      const result = deriveDisposition(
        facts({
          runStatus: 'blocked',
          runResumesAt: new Date('2026-08-25T15:05:00.000Z'),
          escalations: [raised],
        }),
      );
      expect(result.disposition).toBe('escalated');
      expect(result.escalation).toEqual(raised);
      expect(result.basis).toContain('system');
    });

    it('does NOT escalate on a non-system escalation inside the same window', () => {
      // The restriction #476's own comment calls out as deliberate and the
      // thing most likely to rot: a `budget_exceeded` escalation landing
      // squarely inside the episode must not produce `escalated`.
      const budgetExceeded = escalation({
        kind: 'budget_exceeded',
        raisedAt: new Date('2026-08-25T10:30:00.000Z'),
      });
      const result = deriveDisposition(
        facts({
          runStatus: 'blocked',
          runResumesAt: new Date('2026-08-25T15:05:00.000Z'),
          escalations: [budgetExceeded],
        }),
      );
      expect(result.disposition).not.toBe('escalated');
      expect(result.disposition).toBe('parked');
    });

    it('parked: latest block, run blocked, resume scheduled', () => {
      const resumesAt = new Date('2026-08-25T15:05:00.000Z');
      const result = deriveDisposition(
        facts({
          nextBlockAt: null,
          runStatus: 'blocked',
          runResumesAt: resumesAt,
        }),
      );
      expect(result.disposition).toBe('parked');
      expect(result.basis).toContain(resumesAt.toISOString());
      expect(result.escalation).toBeNull();
    });

    it('awaiting-park: latest block, run blocked, nothing scheduled', () => {
      const result = deriveDisposition(
        facts({ nextBlockAt: null, runStatus: 'blocked', runResumesAt: null }),
      );
      expect(result.disposition).toBe('awaiting-park');
      expect(result.basis).toMatch(/no resume has been scheduled/);
    });

    it('an OLDER block on a run that is currently blocked/parked does NOT claim parked', () => {
      // The first honesty guard: a run with two blocks. The live
      // `runResumesAt` describes the CURRENT (latest) block only. Reading it
      // back onto an earlier one — which has a later block bounding it —
      // must not produce `parked` or `awaiting-park`.
      const nextBlockAt = new Date('2026-08-25T20:00:00.000Z');
      const result = deriveDisposition(
        facts({
          nextBlockAt,
          runStatus: 'blocked',
          runResumesAt: new Date('2026-08-25T20:05:00.000Z'),
        }),
      );
      expect(result.disposition).not.toBe('parked');
      expect(result.disposition).not.toBe('awaiting-park');
      // It is bounded by the later block, so it reads resumed.
      expect(result.disposition).toBe('resumed');
    });

    it('resumed: an earlier block bounded by the run’s next block', () => {
      const nextBlockAt = new Date('2026-08-25T16:00:00.000Z');
      const result = deriveDisposition(
        facts({ nextBlockAt, runStatus: 'succeeded', runEndedAt: null }),
      );
      expect(result.disposition).toBe('resumed');
      expect(result.basis).toContain('blocked again');
    });

    it('resumed: the latest block, run reported again, run not yet terminal', () => {
      const runLastEventAt = new Date('2026-08-25T11:00:00.000Z');
      const result = deriveDisposition(
        facts({ nextBlockAt: null, runStatus: 'running', runLastEventAt }),
      );
      expect(result.disposition).toBe('resumed');
      expect(result.basis).toContain('reported again');
    });

    it('concluded: latest block, run reported again, and has since concluded', () => {
      const runLastEventAt = new Date('2026-08-25T11:00:00.000Z');
      const result = deriveDisposition(
        facts({ nextBlockAt: null, runStatus: 'succeeded', runLastEventAt }),
      );
      expect(result.disposition).toBe('concluded');
      expect(result.basis).toContain('concluded');
    });

    it('concluded: terminal run, no event after the block at all', () => {
      const result = deriveDisposition(
        facts({
          nextBlockAt: null,
          runStatus: 'quarantined',
          runLastEventAt: null,
        }),
      );
      expect(result.disposition).toBe('concluded');
      expect(result.basis).toMatch(/no event reported/);
    });

    it('concluded via runEndedAt even when runStatus is not itself terminal-looking', () => {
      // `terminal` is `runEndedAt !== null OR status in TERMINAL_RUN_STATUSES`
      // — assert the runEndedAt half independently of the status list.
      const result = deriveDisposition(
        facts({
          nextBlockAt: null,
          runStatus: 'blocked',
          runEndedAt: new Date('2026-08-25T12:00:00.000Z'),
          runResumesAt: null,
          runLastEventAt: null,
        }),
      );
      // Still `blocked` status routes through the park branch first — this
      // case only differentiates `terminal` when the park branch does not
      // apply, i.e. once runStatus is no longer literally 'blocked'.
      expect(result.disposition).toBe('awaiting-park');
    });

    it('unknown: nothing stored says anything', () => {
      const result = deriveDisposition(
        facts({
          nextBlockAt: null,
          runStatus: 'running',
          runResumesAt: null,
          runEndedAt: null,
          runLastEventAt: null,
          escalations: [],
        }),
      );
      expect(result.disposition).toBe('unknown');
      expect(result.basis).toMatch(/nothing stored says/);
    });

    it('stalled is not terminal — an unbounded stalled run with no escalation is unknown, not concluded', () => {
      const result = deriveDisposition(
        facts({
          nextBlockAt: null,
          runStatus: 'stalled',
          runResumesAt: null,
          runEndedAt: null,
          runLastEventAt: null,
        }),
      );
      expect(result.disposition).toBe('unknown');
    });

    it('a non-latest block on a run that later succeeded reads resumed, not concluded', () => {
      // The asymmetry the doc comment calls out explicitly: the conclusion
      // belongs to the LAST episode, not to an earlier one that was itself
      // followed by another block.
      const nextBlockAt = new Date('2026-08-25T16:00:00.000Z');
      const result = deriveDisposition(
        facts({ nextBlockAt, runStatus: 'succeeded', runEndedAt: new Date() }),
      );
      expect(result.disposition).toBe('resumed');
    });

    it('every branch populates a non-empty dispositionBasis', () => {
      const cases: EpisodeFacts[] = [
        // escalated
        facts({ escalations: [escalation()] }),
        // parked
        facts({
          nextBlockAt: null,
          runStatus: 'blocked',
          runResumesAt: new Date('2026-08-25T15:05:00.000Z'),
        }),
        // awaiting-park
        facts({ nextBlockAt: null, runStatus: 'blocked', runResumesAt: null }),
        // resumed (bounded by next block)
        facts({ nextBlockAt: new Date('2026-08-25T16:00:00.000Z') }),
        // concluded (bounded, terminal)
        facts({
          nextBlockAt: null,
          runStatus: 'failed',
          runLastEventAt: new Date('2026-08-25T11:00:00.000Z'),
        }),
        // concluded (unbounded, terminal)
        facts({ nextBlockAt: null, runStatus: 'failed', runLastEventAt: null }),
        // unknown
        facts({
          nextBlockAt: null,
          runStatus: 'running',
          runResumesAt: null,
          runLastEventAt: null,
        }),
      ];

      for (const c of cases) {
        const { basis } = deriveDisposition(c);
        expect(typeof basis).toBe('string');
        expect(basis.length).toBeGreaterThan(0);
      }
    });
  });

  // ---------------------------------------------------------------------
  // toEpisode
  // ---------------------------------------------------------------------

  describe('toEpisode', () => {
    it('nulls resumesAt for a non-latest block even if runResumesAt is set', () => {
      // Second honesty guard, exercised at the response-shaping layer:
      // `Run.resumesAt` must be nulled on a historic episode.
      const nextBlockAt = new Date('2026-08-25T16:00:00.000Z');
      const episode = toEpisode(
        facts({
          nextBlockAt,
          runStatus: 'blocked',
          runResumesAt: new Date('2026-08-25T20:00:00.000Z'),
        }),
      );
      expect(episode.resumesAt).toBeNull();
    });

    it('nulls resumesAt for the latest block when the run is not currently blocked', () => {
      const episode = toEpisode(
        facts({
          nextBlockAt: null,
          runStatus: 'succeeded',
          runResumesAt: new Date('2026-08-25T20:00:00.000Z'),
          runLastEventAt: new Date('2026-08-25T11:00:00.000Z'),
        }),
      );
      expect(episode.resumesAt).toBeNull();
    });

    it('carries resumesAt only for the latest, currently-blocked, parked episode', () => {
      const resumesAt = new Date('2026-08-25T15:05:00.000Z');
      const episode = toEpisode(
        facts({
          nextBlockAt: null,
          runStatus: 'blocked',
          runResumesAt: resumesAt,
        }),
      );
      expect(episode.resumesAt).toBe(resumesAt.toISOString());
      expect(episode.disposition).toBe('parked');
    });

    it('computes durationMs from the bound, and null when unbounded', () => {
      const nextBlockAt = new Date('2026-08-25T16:00:00.000Z');
      const bounded = toEpisode(facts({ nextBlockAt }));
      expect(bounded.durationMs).toBe(
        nextBlockAt.getTime() - OCCURRED_AT.getTime(),
      );

      const unbounded = toEpisode(
        facts({ nextBlockAt: null, runLastEventAt: null }),
      );
      expect(unbounded.durationMs).toBeNull();
      expect(unbounded.nextActivityAt).toBeNull();
    });

    it('serializes an episode with a reset time (blockedUntil set)', () => {
      // #476's own stated criterion, case 1: an episode WITH a reset time.
      const episode = toEpisode(
        facts({ blockedUntil: new Date('2026-08-25T15:00:00.000Z') }),
      );
      expect(episode.blockedUntil).toBe('2026-08-25T15:00:00.000Z');
    });

    it('serializes an episode with no reset time (blockedUntil null)', () => {
      // #476's own stated criterion, case 2: an episode WITHOUT a reset time.
      const episode = toEpisode(facts({ blockedUntil: null }));
      expect(episode.blockedUntil).toBeNull();
    });

    it('serializes a resolved episode (bounded, run reported again)', () => {
      // #476's own stated criterion, case 3: one that resolved.
      const runLastEventAt = new Date('2026-08-25T12:00:00.000Z');
      const episode = toEpisode(
        facts({ nextBlockAt: null, runStatus: 'running', runLastEventAt }),
      );
      expect(episode.disposition).toBe('resumed');
      expect(episode.nextActivityAt).toBe(runLastEventAt.toISOString());
      expect(episode.durationMs).toBe(
        runLastEventAt.getTime() - OCCURRED_AT.getTime(),
      );
    });

    it('carries the matched window through untouched, or null', () => {
      const window: EpisodeWindow = {
        kind: 'five_hour',
        resetsAt: new Date('2026-08-25T15:00:00.000Z'),
        pressure: 'allowed',
        peakPressure: 'exhausted',
        firstObservedAt: new Date('2026-08-25T10:00:00.000Z'),
        lastObservedAt: new Date('2026-08-25T14:55:00.000Z'),
        observations: 12,
      };
      const withWindow = toEpisode(facts({ window }));
      expect(withWindow.window).toEqual({
        kind: 'five_hour',
        resetsAt: '2026-08-25T15:00:00.000Z',
        pressure: 'allowed',
        peakPressure: 'exhausted',
        firstObservedAt: '2026-08-25T10:00:00.000Z',
        lastObservedAt: '2026-08-25T14:55:00.000Z',
        observations: 12,
      });

      const withoutWindow = toEpisode(facts({ window: null }));
      expect(withoutWindow.window).toBeNull();
    });

    it('carries the escalation through untouched, or null', () => {
      const raised = escalation();
      const withEscalation = toEpisode(facts({ escalations: [raised] }));
      expect(withEscalation.escalation).toEqual({
        kind: raised.kind,
        status: raised.status,
        raisedAt: raised.raisedAt.toISOString(),
        summary: raised.summary,
      });

      const withoutEscalation = toEpisode(facts({ escalations: [] }));
      expect(withoutEscalation.escalation).toBeNull();
    });

    it.each<RunStatus>([
      'running',
      'succeeded',
      'stalled',
      'blocked',
      'failed',
      'quarantined',
    ])('passes runStatus %s through verbatim', (runStatus) => {
      const episode = toEpisode(facts({ runStatus }));
      expect(episode.runStatus).toBe(runStatus);
    });
  });

  // ---------------------------------------------------------------------
  // matchWindow
  // ---------------------------------------------------------------------

  describe('matchWindow', () => {
    function window(
      overrides: Partial<EpisodeWindow & { runnerKey: string }> = {},
    ): EpisodeWindow & { runnerKey: string } {
      return {
        runnerKey: 'claude-code-local',
        kind: 'five_hour',
        resetsAt: new Date('2026-08-25T15:00:00.000Z'),
        pressure: 'allowed',
        peakPressure: 'exhausted',
        firstObservedAt: new Date('2026-08-25T10:00:00.000Z'),
        lastObservedAt: new Date('2026-08-25T14:55:00.000Z'),
        observations: 12,
        ...overrides,
      };
    }

    it('returns null when blockedUntil is null — nothing to match on', () => {
      expect(matchWindow('claude-code-local', null, [window()])).toBeNull();
    });

    it('matches on an exact runner + reset instant', () => {
      const w = window();
      const result = matchWindow(
        'claude-code-local',
        new Date('2026-08-25T15:00:00.000Z'),
        [w],
      );
      expect(result).toEqual(w);
    });

    it('does NOT match a near-miss reset instant — no nearest-window fallback', () => {
      const w = window({ resetsAt: new Date('2026-08-25T15:00:01.000Z') });
      const result = matchWindow(
        'claude-code-local',
        new Date('2026-08-25T15:00:00.000Z'),
        [w],
      );
      expect(result).toBeNull();
    });

    it('does not match a window on a different runner with the same instant', () => {
      const w = window({ runnerKey: 'other-runner' });
      const result = matchWindow(
        'claude-code-local',
        new Date('2026-08-25T15:00:00.000Z'),
        [w],
      );
      expect(result).toBeNull();
    });

    it('picks the worse peakPressure when two kinds share the exact instant', () => {
      const resetsAt = new Date('2026-08-25T15:00:00.000Z');
      const warning = window({ kind: 'five_hour', peakPressure: 'warning' });
      const exhausted = window({ kind: 'weekly', peakPressure: 'exhausted' });
      const result = matchWindow('claude-code-local', resetsAt, [
        warning,
        exhausted,
      ]);
      expect(result?.kind).toBe('weekly');
    });

    it('breaks a peakPressure tie by the earlier firstObservedAt', () => {
      const resetsAt = new Date('2026-08-25T15:00:00.000Z');
      const later = window({
        kind: 'five_hour',
        firstObservedAt: new Date('2026-08-25T11:00:00.000Z'),
      });
      const earlier = window({
        kind: 'weekly',
        firstObservedAt: new Date('2026-08-25T09:00:00.000Z'),
      });
      const result = matchWindow('claude-code-local', resetsAt, [
        later,
        earlier,
      ]);
      expect(result?.kind).toBe('weekly');
    });
  });
});
