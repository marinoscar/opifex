import type { RunnerQuotaObservation } from '../runners/runner.types';
import {
  collapseObservations,
  meterQuotaPosition,
  QUOTA_METER_HEALTH_HORIZON_MS,
  quotaPositionFrom,
  windowSpan,
  worsePressure,
  type MeterWindow,
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

/**
 * One stored window, as {@link meterQuotaPosition} reads it.
 *
 * No such helper was left behind by the implementation — the spec's Prisma
 * double needs a `MeterWindow`-shaped row too (see `dispatch.service.spec.ts`),
 * and duplicating the literal in every test here is how a horizon boundary
 * typo goes unnoticed.
 */
function meterWindow(overrides: Partial<MeterWindow> = {}): MeterWindow {
  return {
    kind: 'five_hour',
    // Live by construction: one hour out, well past `NOW` below.
    resetsAt: new Date('2026-08-25T13:00:00.000Z'),
    pressure: 'allowed',
    lastObservedAt: new Date('2026-08-25T12:00:00.000Z'),
    ...overrides,
  };
}

describe('meterQuotaPosition', () => {
  const NOW = new Date('2026-08-25T12:00:00.000Z');

  it('has no position for an empty meter', () => {
    expect(meterQuotaPosition([], NOW)).toBeUndefined();
  });

  it('reports the meter healthy when its one window is fresh and allowed', () => {
    const position = meterQuotaPosition(
      [meterWindow({ pressure: 'allowed', lastObservedAt: NOW })],
      NOW,
    );

    expect(position?.exhausted).toBe(false);
  });

  it('reports exhaustion for a single exhausted window', () => {
    const position = meterQuotaPosition(
      [meterWindow({ pressure: 'exhausted', lastObservedAt: NOW })],
      NOW,
    );

    expect(position?.exhausted).toBe(true);
  });

  // Case 7 — the issue's own words: "a stale meter observation does not
  // assert health".
  it('drops a stale ALLOWED reading rather than trusting it, and does not report health', () => {
    // Observed just past the horizon. Two things can have spent the window
    // since: this runner going quiet, or VISION §11's interactive co-tenant —
    // and nothing here can see which.
    const staleAllowed = meterWindow({
      pressure: 'allowed',
      lastObservedAt: new Date(
        NOW.getTime() - QUOTA_METER_HEALTH_HORIZON_MS - 1,
      ),
    });

    expect(meterQuotaPosition([staleAllowed], NOW)).toBeUndefined();
  });

  it('an exhausted window still binds alongside an unrelated stale-allowed one', () => {
    // A stale ALLOWED window is dropped entirely rather than downgraded, so
    // it cannot cancel out an exhausted window that is genuinely live — the
    // "worst reading among fresh windows" step in `meterQuotaPosition` never
    // even sees it. The cross-function version of this claim — that a STALE
    // meter reading must not silence a blocked run's own exhaustion — is
    // `resolveQuotaPosition`'s to make, and is pinned in
    // `dispatch.service.spec.ts`.
    const position = meterQuotaPosition(
      [
        meterWindow({ kind: 'five_hour', pressure: 'exhausted' }),
        meterWindow({
          kind: 'weekly',
          pressure: 'allowed',
          resetsAt: new Date('2026-09-01T12:00:00.000Z'),
          lastObservedAt: new Date(
            NOW.getTime() - QUOTA_METER_HEALTH_HORIZON_MS - 1,
          ),
        }),
      ],
      NOW,
    );

    expect(position?.exhausted).toBe(true);
  });

  // Case 8 — the asymmetry `QUOTA_METER_HEALTH_HORIZON_MS`'s doc comment
  // argues at length: exhaustion is dated by the window's own `resetsAt` and
  // needs no freshness rule, while health does.
  it('still parks on an EXHAUSTED reading no matter how long ago it was observed', () => {
    const staleExhausted = meterWindow({
      pressure: 'exhausted',
      lastObservedAt: new Date('2026-08-25T00:00:00.000Z'), // 12 hours stale
    });

    const position = meterQuotaPosition([staleExhausted], NOW);

    expect(position?.exhausted).toBe(true);
  });

  it('does NOT park on an exhausted reading once its own window has rolled', () => {
    // The asymmetry is about the horizon, not about `resetsAt` — a rolled
    // window says nothing about the current one, exhausted or not.
    const rolled = meterWindow({
      pressure: 'exhausted',
      resetsAt: new Date('2026-08-25T11:00:00.000Z'), // already in the past
      lastObservedAt: new Date('2026-08-25T10:00:00.000Z'),
    });

    expect(meterQuotaPosition([rolled], NOW)).toBeUndefined();
  });

  // Case 9 — THE case. `QuotaService.readings()` keeps only the newest live
  // window per runner, which would hide an exhausted `five_hour` window
  // behind a healthy `weekly` one (the weekly `resetsAt` is almost always
  // later). `meterQuotaPosition` must bind on EVERY live window instead. If a
  // future refactor folds `loadQuotaMeter` into `readings()`, this is the one
  // test standing between that change and a runner being dispatched into an
  // exhausted window it is still inside of.
  it('an exhausted five_hour window binds even behind a healthy weekly one (guards against the readings() masking bug)', () => {
    const position = meterQuotaPosition(
      [
        meterWindow({
          kind: 'five_hour',
          pressure: 'exhausted',
          resetsAt: new Date('2026-08-25T13:00:00.000Z'),
          lastObservedAt: NOW,
        }),
        meterWindow({
          kind: 'weekly',
          pressure: 'allowed',
          resetsAt: new Date('2026-09-01T12:00:00.000Z'), // later — would win a "newest" tie-break
          lastObservedAt: NOW,
        }),
      ],
      NOW,
    );

    expect(position?.exhausted).toBe(true);
    // The five-hour reset, not the weekly one — the runner is usable again
    // when the binding window rolls, not when the unrelated healthy one does.
    expect(position?.resumesAt).toBe('2026-08-25T13:00:00.000Z');
  });

  it('reports the LATER reset when more than one window is exhausted', () => {
    // Not usable again until the last binding window has rolled — reporting
    // the earliest would promise a refill the other limit still refuses.
    const position = meterQuotaPosition(
      [
        meterWindow({
          kind: 'five_hour',
          pressure: 'exhausted',
          resetsAt: new Date('2026-08-25T13:00:00.000Z'),
        }),
        meterWindow({
          kind: 'weekly',
          pressure: 'exhausted',
          resetsAt: new Date('2026-09-01T12:00:00.000Z'),
        }),
      ],
      NOW,
    );

    expect(position?.resumesAt).toBe('2026-09-01T12:00:00.000Z');
  });

  // Case 10.
  it('reports the WORST fresh reading among non-exhausted windows: a warning over an allowed', () => {
    const position = meterQuotaPosition(
      [
        meterWindow({
          kind: 'five_hour',
          pressure: 'warning',
          lastObservedAt: NOW,
        }),
        meterWindow({
          kind: 'weekly',
          pressure: 'allowed',
          resetsAt: new Date('2026-09-01T12:00:00.000Z'),
          lastObservedAt: NOW,
        }),
      ],
      NOW,
    );

    expect(position?.exhausted).toBe(false);
    expect(position?.basis).toContain('warning');
  });

  // Case 11.
  it('has no position for an unparseable reading, even if it is the only window', () => {
    const position = meterQuotaPosition(
      [meterWindow({ pressure: 'unknown', lastObservedAt: NOW })],
      NOW,
    );

    expect(position).toBeUndefined();
  });

  it('drops a stale WARNING reading on the same horizon as allowed', () => {
    // `warning` never parks on its own — it is a claim about pressure at an
    // instant, same as `allowed`, so it earns no exception from the horizon.
    const staleWarning = meterWindow({
      pressure: 'warning',
      lastObservedAt: new Date(
        NOW.getTime() - QUOTA_METER_HEALTH_HORIZON_MS - 1,
      ),
    });

    expect(meterQuotaPosition([staleWarning], NOW)).toBeUndefined();
  });
});
