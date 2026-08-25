import type { RunnerQuotaObservation } from '../runners/runner.types';
import {
  collapseObservations,
  quotaPositionFrom,
  windowSpan,
  worsePressure,
} from './quota-window';

const RESETS_AT = new Date('2026-08-25T15:00:00.000Z');

function sighting(
  overrides: Partial<RunnerQuotaObservation> = {},
): RunnerQuotaObservation {
  return {
    runnerKey: 'claude-code-local',
    kind: 'five_hour',
    resetsAt: RESETS_AT,
    pressure: 'allowed',
    observedAt: new Date('2026-08-25T12:00:00.000Z'),
    ...overrides,
  };
}

describe('windowSpan', () => {
  it('derives the start from the length the vendor label names', () => {
    // `five_hour` states a duration in its own name. Reading it is parsing,
    // not estimating — which is why this is the only derivation in the file.
    const span = windowSpan({
      kind: 'five_hour',
      resetsAt: RESETS_AT,
      firstObservedAt: new Date('2026-08-25T10:30:00.000Z'),
    });

    expect(span.startedAt).toEqual(new Date('2026-08-25T10:00:00.000Z'));
    expect(span.startedAtBasis).toBe('vendor-window-length');
    expect(span.partial).toBe(false);
  });

  it('falls back to the first sighting for a label it does not know', () => {
    // A length guessed for an unknown label would misdate the window's start,
    // and everything summed inside it.
    const span = windowSpan({
      kind: 'fortnightly_special',
      resetsAt: RESETS_AT,
      firstObservedAt: new Date('2026-08-25T14:00:00.000Z'),
    });

    expect(span.startedAt).toEqual(new Date('2026-08-25T14:00:00.000Z'));
    expect(span.startedAtBasis).toBe('first-observation');
    expect(span.partial).toBe(true);
  });

  it('spans the whole known window even when the first sighting is late', () => {
    // The tempting mistake, pinned. Consumption comes from `run_events`, which
    // are persisted as they arrive whether or not a rate-limit line has been
    // seen — so a run that spent money before the first sighting has its rows
    // either way. Clipping the span to the sighting would understate the
    // window while looking precise.
    const span = windowSpan({
      kind: 'weekly',
      resetsAt: RESETS_AT,
      firstObservedAt: new Date('2026-08-25T14:00:00.000Z'),
    });

    expect(span.startedAt).toEqual(new Date('2026-08-18T15:00:00.000Z'));
    expect(span.startedAtBasis).toBe('vendor-window-length');
    expect(span.partial).toBe(false);
  });
});

describe('worsePressure', () => {
  it('orders the readings, with unknown losing to anything real', () => {
    expect(worsePressure('allowed', 'warning')).toBe('warning');
    expect(worsePressure('exhausted', 'allowed')).toBe('exhausted');
    expect(worsePressure('unknown', 'allowed')).toBe('allowed');
    expect(worsePressure('warning', 'unknown')).toBe('warning');
  });
});

describe('collapseObservations', () => {
  it('collapses repeat sightings of one window into a single row', () => {
    // The adapter reports every sighting because that is the dumbest thing it
    // can do correctly. Collapsing happens once, here.
    const [window] = collapseObservations([
      sighting({ observedAt: new Date('2026-08-25T12:00:00.000Z') }),
      sighting({ observedAt: new Date('2026-08-25T12:01:00.000Z') }),
      sighting({ observedAt: new Date('2026-08-25T12:02:00.000Z') }),
    ]);

    expect(window.observations).toBe(3);
    expect(window.firstObservedAt).toEqual(
      new Date('2026-08-25T12:00:00.000Z'),
    );
    expect(window.lastObservedAt).toEqual(new Date('2026-08-25T12:02:00.000Z'));
  });

  it('keeps the latest reading current and the worst one as the peak', () => {
    // `pressure` forgets: a window refused at noon reads `allowed` again at
    // one o'clock, and only the peak still says the wall was hit.
    const [window] = collapseObservations([
      sighting({
        pressure: 'exhausted',
        observedAt: new Date('2026-08-25T12:00:00.000Z'),
      }),
      sighting({
        pressure: 'allowed',
        observedAt: new Date('2026-08-25T12:30:00.000Z'),
      }),
    ]);

    expect(window.pressure).toBe('allowed');
    expect(window.peakPressure).toBe('exhausted');
  });

  it('keeps two runners on separate rows for the same instant', () => {
    // #231's first open question. A fleet with a cloud runner and a local one
    // genuinely has two subscriptions; folding them here would make that case
    // unrepresentable, and a reader can always sum but never un-sum.
    const windows = collapseObservations([
      sighting({ runnerKey: 'claude-code-local' }),
      sighting({ runnerKey: 'claude-code-cloud' }),
    ]);

    expect(windows).toHaveLength(2);
  });

  it('keeps two window kinds apart', () => {
    // The five-hour window and the weekly one roll independently, and a
    // subscription is under both at once.
    const windows = collapseObservations([
      sighting({ kind: 'five_hour' }),
      sighting({ kind: 'weekly' }),
    ]);

    expect(windows).toHaveLength(2);
  });
});

describe('quotaPositionFrom', () => {
  const NOW = new Date('2026-08-25T12:00:00.000Z');

  it('asserts availability positively, which the blocked signal cannot', () => {
    // The improvement #105 predicted in prose: it derives its position from
    // runs sitting `blocked`, so the absence of a park is silence rather than
    // health. A served rate-limit line is the vendor saying there is room.
    const position = quotaPositionFrom(
      {
        kind: 'five_hour',
        resetsAt: RESETS_AT,
        pressure: 'allowed',
        lastObservedAt: NOW,
      },
      NOW,
    );

    expect(position?.exhausted).toBe(false);
    expect(position?.resumesAt).toBe(RESETS_AT.toISOString());
    expect(position?.basis).toContain('allowed');
  });

  it('reports exhaustion with the same shape #105 already defined', () => {
    const position = quotaPositionFrom(
      {
        kind: 'five_hour',
        resetsAt: RESETS_AT,
        pressure: 'exhausted',
        lastObservedAt: NOW,
      },
      NOW,
    );

    expect(position?.exhausted).toBe(true);
  });

  it('treats a warning as pressure, not as exhaustion', () => {
    // Requests are still being served. Routing away from a runner the vendor
    // is still serving would cost throughput to buy nothing.
    const position = quotaPositionFrom(
      {
        kind: 'five_hour',
        resetsAt: RESETS_AT,
        pressure: 'warning',
        lastObservedAt: NOW,
      },
      NOW,
    );

    expect(position?.exhausted).toBe(false);
  });

  it('has no position for a window that has already rolled', () => {
    // The same rule `quotaPositions` applies to a block whose reset has
    // passed: a stale window says nothing about the current one.
    expect(
      quotaPositionFrom(
        {
          kind: 'five_hour',
          resetsAt: new Date('2026-08-25T11:00:00.000Z'),
          pressure: 'exhausted',
          lastObservedAt: NOW,
        },
        NOW,
      ),
    ).toBeUndefined();
  });

  it('has no position for a reading nobody could parse', () => {
    // Undefined routes as UNKNOWN, which is freely — the correct treatment of
    // a status this system does not recognize, and never as exhausted.
    expect(
      quotaPositionFrom(
        {
          kind: 'five_hour',
          resetsAt: RESETS_AT,
          pressure: 'unknown',
          lastObservedAt: NOW,
        },
        NOW,
      ),
    ).toBeUndefined();
  });
});
