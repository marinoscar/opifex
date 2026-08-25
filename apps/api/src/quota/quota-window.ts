import type { RunnerQuotaPosition } from '../dispatch/dispatch-policy';
import {
  QUOTA_PRESSURE_ORDER,
  type QuotaPressure,
  type RunnerQuotaObservation,
} from '../runners/runner.types';

/**
 * Quota arithmetic, and the case for what it refuses to compute (#231).
 *
 * ## Metric 6 does not compute, and this file is where that is argued
 *
 * VISION §10's sixth success metric is quota BURN — consumption over window
 * capacity. `cockpit/metrics.service.ts` returns `NOT_MEASURED` for it and
 * says why in prose. #231 was filed to close that gap. It does not, and the
 * reason is worth stating precisely rather than leaving as an omission,
 * because the shape of the answer looks so nearly available:
 *
 *  1. **The denominator does not exist.** The subscription's window limit is
 *     not published in any machine-readable form. #102 established there is no
 *     non-interactive cloud API at all, and `runner-capability.schema.json`
 *     has no field a runner could declare one in. The available substitutes
 *     are an operator-declared ceiling — a guess sitting in a denominator —
 *     and a self-calibrated one, discussed below.
 *  2. **The numerator is incomplete, and unboundedly so.** This is the
 *     decisive half, and the one the issue does not name. VISION §11 says the
 *     subscription is SHARED: automated runs compete with the operator's own
 *     interactive use. Opifex sees its own runs and nothing else. An operator
 *     who spends an hour in an interactive session burns the same five-hour
 *     window and leaves no `run_events` row behind. So even a perfect capacity
 *     number would be divided into a numerator missing a share nothing here
 *     can see or bound.
 *
 * Point 2 also disposes of the tempting self-calibration — "the consumption
 * seen just before a rate limit fired is a lower bound on capacity". What that
 * actually measures is *capacity minus that window's interactive use*, which
 * is a different number every window. Divide by it and burn reads 40% on a
 * busy week and over 100% on a quiet one, with the entire variation caused by
 * something the metric does not observe. A number that moves for reasons it
 * cannot name is worse than a null, because a null is at least honest about
 * how much it knows.
 *
 * So: **observed-only**. No capacity, no fraction, and `quotaBurn` stays
 * `NOT_MEASURED` — with a sharper reason than before. Consumption is now
 * recorded against real windows; capacity is unobtainable and the numerator is
 * co-tenanted.
 *
 * ## What IS honest, and it is more than nothing
 *
 * Two facts, both first-hand, neither a ratio:
 *
 *  - **The window**, from the vendor's own `resetsAt`. Not a bucket somebody
 *    chose — the actual boundary the vendor will reset at. That is what makes
 *    consumption-per-window comparable window to window, and it is exactly
 *    what #113's reset-window-aware scheduling needs.
 *  - **The pressure**, an ordinal the vendor states itself: served, warned,
 *    refused. `warning` is the valuable one, because it is the only signal in
 *    the system that arrives BEFORE a run is parked.
 *
 * Against that frame, Opifex's own consumption has a meaningful TREND even
 * though it has no meaningful RATIO. Which is why it is named
 * `opifexConsumption` everywhere it travels, on the same principle
 * `SpendTally.estimatedUsd` follows: a qualification that is not in the field
 * name stops being distinguishable one call site later.
 */

/**
 * Vendor window labels, and how long they say the window is.
 *
 * A translation of a word the vendor chose, not a capacity: `five_hour` states
 * a duration in its own name, and reading it is closer to parsing than to
 * estimating. A label not in this table yields no derived start at all rather
 * than a default — guessing a length would misdate the window's start, and
 * everything summed inside it.
 *
 * Kept here rather than in the adapter so that a second runner observing the
 * same vendor cannot arrive at a different length for the same word.
 */
export const WINDOW_LENGTH_MS: Readonly<Record<string, number>> = {
  five_hour: 5 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

/** Where a window's consumption is measured FROM, and on whose authority. */
export type WindowStartBasis =
  /** `resetsAt` minus the length the vendor's own label names. */
  | 'vendor-window-length'
  /** The first sighting: the label named no length this system recognizes. */
  | 'first-observation';

export interface WindowSpan {
  startedAt: Date;
  startedAtBasis: WindowStartBasis;
  /**
   * True when the span starts at a sighting rather than at a real boundary.
   *
   * Consumption over a partial span is a FLOOR for the window, not a total —
   * whatever ran before the first sighting is inside the window and outside
   * the sum. Surfaced rather than smoothed over, for the same reason
   * `SpendTally.unboundedRuns` is. False whenever the vendor's own label named
   * the length; see `windowSpan` for why a late first sighting does not make
   * such a window partial.
   */
  partial: boolean;
}

/**
 * The span to sum consumption over, for one window.
 *
 * ## A known length is NOT partial, even though the first sighting is late
 *
 * The instinct is that a five-hour window first seen at 10:30 can only be
 * summed from 10:30, because that is when Opifex started looking. It is wrong,
 * and the reason is where the consumption actually comes from: `run_events`,
 * which are persisted as they arrive whether or not any rate-limit line has
 * been seen. A run that spent money at 10:15 has its rows regardless. So when
 * the vendor's label names the length, the derived start is both correct and
 * complete for Opifex's own consumption, and clipping it to the first sighting
 * would UNDERSTATE the window while looking precise.
 *
 * The unknown-label case is genuinely partial, and for a different reason:
 * nothing says where that window began, so the span starts where the looking
 * did and whatever ran before it is inside the window and outside the sum.
 */
export function windowSpan(window: {
  kind: string;
  resetsAt: Date;
  firstObservedAt: Date;
}): WindowSpan {
  const length = WINDOW_LENGTH_MS[window.kind];
  if (length === undefined) {
    return {
      startedAt: window.firstObservedAt,
      startedAtBasis: 'first-observation',
      partial: true,
    };
  }

  return {
    startedAt: new Date(window.resetsAt.getTime() - length),
    startedAtBasis: 'vendor-window-length',
    partial: false,
  };
}

/** The worse of two readings. `unknown` loses to anything that is a reading. */
export function worsePressure(
  a: QuotaPressure,
  b: QuotaPressure,
): QuotaPressure {
  return QUOTA_PRESSURE_ORDER.indexOf(b) > QUOTA_PRESSURE_ORDER.indexOf(a)
    ? b
    : a;
}

/**
 * One window's worth of sightings, collapsed.
 *
 * The adapter reports every sighting because that is the dumbest thing it can
 * do correctly — the same principle that lets `poll` re-deliver events it has
 * already handed over. Collapsing happens once, here, so a single row is
 * written per window however many lines mentioned it.
 */
export interface CollapsedWindow {
  runnerKey: string;
  kind: string;
  resetsAt: Date;
  /** The LATEST sighting's reading, by `observedAt`. */
  pressure: QuotaPressure;
  /** The worst reading across every sighting in this batch. */
  peakPressure: QuotaPressure;
  firstObservedAt: Date;
  lastObservedAt: Date;
  observations: number;
}

export function collapseObservations(
  observations: readonly RunnerQuotaObservation[],
): CollapsedWindow[] {
  const byWindow = new Map<string, CollapsedWindow>();

  for (const observation of observations) {
    const key = [
      observation.runnerKey,
      observation.kind,
      observation.resetsAt.toISOString(),
    ].join(' ');

    const seen = byWindow.get(key);
    if (!seen) {
      byWindow.set(key, {
        runnerKey: observation.runnerKey,
        kind: observation.kind,
        resetsAt: observation.resetsAt,
        pressure: observation.pressure,
        peakPressure: observation.pressure,
        firstObservedAt: observation.observedAt,
        lastObservedAt: observation.observedAt,
        observations: 1,
      });
      continue;
    }

    seen.observations += 1;
    seen.peakPressure = worsePressure(seen.peakPressure, observation.pressure);
    if (observation.observedAt < seen.firstObservedAt) {
      seen.firstObservedAt = observation.observedAt;
    }
    // Latest wins for the CURRENT reading. `>=` so a batch of same-instant
    // sightings settles on the last one in stream order, which is the order
    // the CLI emitted them in.
    if (observation.observedAt >= seen.lastObservedAt) {
      seen.lastObservedAt = observation.observedAt;
      seen.pressure = observation.pressure;
    }
  }

  return [...byWindow.values()];
}

/**
 * A meter reading as ROUTING sees it — the shape #105 already defined.
 *
 * `dispatch/dispatch-policy.ts` predicted this exactly: *"When #231 lands it
 * can populate this same shape with a better basis, and the routing rule below
 * does not change."* So it populates that shape rather than introducing a
 * second one, and the improvement is in the `basis` plus one claim the derived
 * signal cannot make at all:
 *
 * > `exhausted: false` stays representable so a future meter can assert
 * > availability positively rather than by silence.
 *
 * That is what a vendor `allowed` reading is. #105 derives its position from
 * runs sitting `blocked`, so it can only ever observe exhaustion; the absence
 * of a park is silence, not health. A served rate-limit line is the vendor
 * saying there is room, which is a different and stronger claim.
 *
 * ONE WINDOW ONLY. A runner can have several live windows at once — a
 * `five_hour` and a `weekly` are different rows with different reset instants
 * — and resolving across them is {@link meterQuotaPosition}'s job. The
 * precedence between this signal and the blocked-run one it is ranked against
 * (#285) is stated and applied in `DispatchService`, which is where the clock
 * and the other signal both already live.
 */
export function quotaPositionFrom(
  window: {
    kind: string;
    resetsAt: Date;
    pressure: QuotaPressure;
    lastObservedAt: Date;
  },
  now: Date,
): RunnerQuotaPosition | undefined {
  // A window that has already rolled says nothing about the current one — the
  // same rule `quotaPositions` applies to a block whose reset has passed.
  if (window.resetsAt <= now) return undefined;
  // Unknown is not a position. Routing reads an absent position as UNKNOWN and
  // routes to it freely, which is the correct treatment of a reading nobody
  // could parse.
  if (window.pressure === 'unknown') return undefined;

  return {
    exhausted: window.pressure === 'exhausted',
    resumesAt: window.resetsAt.toISOString(),
    basis:
      `runner reported rate-limit status "${window.pressure}" for its ` +
      `${window.kind} window at ${window.lastObservedAt.toISOString()}`,
  };
}

/**
 * How long a meter reading may keep asserting HEALTH after it was observed.
 *
 * ## Why health expires and exhaustion does not
 *
 * A reading is not a subscription — it is a sighting of one, at one instant.
 * An `exhausted` reading carries its own expiry: the window's `resetsAt` is
 * the vendor's own statement of when the claim stops being true, and
 * `quotaPositionFrom` already drops a window that has rolled. So exhaustion
 * needs no freshness rule; it is dated by construction, and applying one would
 * discard a claim that is still true because nobody has restated it lately.
 *
 * `allowed` carries no such date. It says there was room at `lastObservedAt`
 * and nothing whatever about now, and two things can spend the window in
 * between. Opifex's own runs are the bounded one: their rate-limit lines
 * arrive within a poll interval (15s, `runners/run-poller.service.ts`). The
 * operator is the unbounded one — VISION §11 shares this subscription with
 * their interactive use, which burns the same window and leaves no row
 * anywhere in this system. An hour-old `allowed` is a claim about a window a
 * co-tenant may have emptied since, with nothing here able to see that they
 * did.
 *
 * Staleness is also not rare, because of where observations come from: they
 * arrive only from polling a live run, so a reading FREEZES the moment its
 * runner goes idle. An idle runner is precisely the one most likely to be
 * sitting behind an operator's interactive session.
 *
 * ## Why fifteen minutes
 *
 * Long enough that ordinary quiet is not mistaken for staleness: the CLI emits
 * rate-limit lines on its own cadence rather than on every poll (see
 * `QuotaWindow.observations` in the schema), so a perfectly healthy run can go
 * many polls without one, and a horizon of a minute or two would expire
 * readings that are merely unremarkable.
 *
 * Short enough that it cannot span a window: `five_hour` is the shortest label
 * the vendor uses, so a reading trusted at the very edge of this horizon still
 * describes 95% of the same window.
 *
 * ## The cost of getting the number wrong is asymmetric, on purpose
 *
 * A stale reading is treated as NO news, never as bad news: the position
 * disappears, the runner is UNKNOWN, and unknown routes freely (VISION §6). So
 * a horizon set too SHORT costs a basis line that says less than it could,
 * while one set too LONG lets a recorded dispatch decision claim present
 * health on an hour-old sighting — and #64 requires that recorded line be
 * reconstructible, which a stale claim quietly breaks. Erring short is the
 * cheap direction.
 */
export const QUOTA_METER_HEALTH_HORIZON_MS = 15 * 60_000;

/** One stored window, as routing reads it. A subset of the `quota_windows` row. */
export interface MeterWindow {
  kind: string;
  resetsAt: Date;
  pressure: QuotaPressure;
  lastObservedAt: Date;
}

/**
 * One runner's whole meter, collapsed to the single position routing consumes.
 *
 * ## Every live window binds, not just the newest one
 *
 * A runner can hold a `five_hour` and a `weekly` row at the same time, and the
 * weekly one almost always has the later `resetsAt`. Keeping only the newest
 * lets an exhausted five-hour window be hidden behind a healthy weekly one —
 * a wall that was recorded, observed, and then discarded by a tie-break.
 *
 * `QuotaService.readings()` did exactly that until #301, which is why this
 * function existed for routing alone: the fleet would have dispatched into
 * that wall. The cockpit path now calls this same function for its `position`
 * rather than carrying a second answer to the same question, so there is one
 * implementation of "which window binds" and both readers get it.
 *
 * So: **any live window exhausted means the runner is exhausted**, because
 * every one of them is a ceiling the vendor will enforce independently, and
 * **`resumesAt` is the latest of the exhausted ones**, because the runner is
 * not usable again until the last binding window has rolled. Reporting the
 * earliest would promise a refill that the other limit will refuse.
 *
 * ## Health needs a fresh reading; exhaustion does not
 *
 * See {@link QUOTA_METER_HEALTH_HORIZON_MS}. A stale `allowed` or `warning` is
 * dropped rather than downgraded — it is no news, so the runner falls back to
 * whatever the other signal says, and to UNKNOWN if that says nothing either.
 * `warning` is dropped on the same horizon for the same reason: it is a claim
 * about pressure at an instant, and it does not park a runner in any case.
 *
 * Among fresh non-exhausted windows the WORST reading is reported (a `warning`
 * beats an `allowed`), tie-broken by the most recent sighting. Neither changes
 * routing today — the policy branches only on `exhausted` — but the basis is
 * printed into the recorded decision, and "one of its windows was warning"
 * is the more honest of two true sentences.
 */
export function meterQuotaPosition(
  windows: readonly MeterWindow[],
  now: Date,
  horizonMs: number = QUOTA_METER_HEALTH_HORIZON_MS,
): RunnerQuotaPosition | undefined {
  // A window that has already rolled says nothing about the current one.
  const live = windows.filter((window) => window.resetsAt > now);

  const exhausted = live.filter((window) => window.pressure === 'exhausted');
  if (exhausted.length > 0) {
    const until = exhausted.reduce((a, b) => (a.resetsAt > b.resetsAt ? a : b));
    const observedAt = exhausted.reduce((a, b) =>
      a.lastObservedAt > b.lastObservedAt ? a : b,
    ).lastObservedAt;
    const kinds = [...new Set(exhausted.map((window) => window.kind))].sort();

    return {
      exhausted: true,
      resumesAt: until.resetsAt.toISOString(),
      basis:
        `runner reported rate-limit status "exhausted" for its ` +
        `${kinds.join(', ')} window${kinds.length > 1 ? 's' : ''} at ` +
        observedAt.toISOString() +
        (exhausted.length > 1
          ? ', and the latest of them governs when it lifts'
          : ''),
    };
  }

  const fresh = live.filter(
    (window) =>
      window.pressure !== 'unknown' &&
      now.getTime() - window.lastObservedAt.getTime() <= horizonMs,
  );
  if (fresh.length === 0) return undefined;

  const worst = fresh.reduce((a, b) => {
    if (worsePressure(a.pressure, b.pressure) !== a.pressure) return b;
    if (worsePressure(b.pressure, a.pressure) !== b.pressure) return a;
    return b.lastObservedAt > a.lastObservedAt ? b : a;
  });

  return quotaPositionFrom(worst, now);
}
