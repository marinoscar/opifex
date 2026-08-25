/**
 * The arithmetic behind VISION §10's metric 2 — **dead time per day**.
 *
 * Pure and deterministic, with the window supplied rather than read from the
 * clock, for the same reason `watchdog/silent-detection.ts` is: a test can
 * place an interval at an exact instant and the same inputs always produce the
 * same number. The writing half lives in `dead-time.service.ts`; this half
 * never touches a database.
 *
 * ## What a "day" is here, stated because an ambiguous denominator makes the
 * number uncomparable across days
 *
 * A day is a **rolling 24-hour bucket anchored at the window's start**, and the
 * window's start is `now − days × 24h`. Not a calendar day, and no timezone is
 * involved.
 *
 * That is not a fresh invention — it is the convention `cockpit/metrics.service.ts`
 * already buckets detection latency and cost by, and metric 2 adopting a
 * different one would put two sparklines side by side whose x-axes silently
 * disagreed. It also avoids picking a timezone the control plane has no basis
 * for: the operator's, the runner's and the repository's can all differ, and
 * whichever were chosen would make the number wrong for the other two.
 *
 * The buckets tile the window exactly — `days` buckets of 24h ending precisely
 * at `to` — so no bucket is partial and every bucket's denominator is the same
 * 24 hours. That is what makes one day comparable to the next.
 *
 * ## An interval that spans a boundary is SPLIT, not attributed to its start
 *
 * A 30-hour stall attributed wholly to the day it began would put 30 hours of
 * dead time inside a 24-hour day — a number that is impossible on its face,
 * and one that would make the day it ended look clean. So every interval is
 * clipped to each bucket it overlaps and contributes only the overlap.
 *
 * Dead time is an EXTENSIVE quantity — a duration — which is why it differs
 * from detection latency here. A latency is a point measurement and belongs
 * wholly to the instant it was taken; a duration is spread across the time it
 * occupied, and splitting it is the only convention under which the daily
 * values sum back to the window total.
 *
 * ## Which makes the open interval a non-case
 *
 * #232 asks how an interval still open at the window boundary is handled.
 * Under clipping it needs no special handling at all: an open interval is one
 * whose end is at or past `to`, exactly like a closed interval that outlived
 * the window. It contributes the part that has already elapsed and nothing
 * more.
 *
 * That answers the issue's worry — *"counting it as zero understates dead
 * time; counting `now − progressStoppedAt` mixes an open interval into a sum
 * of closed ones"* — by observing that the second is only a mixture if closed
 * intervals are NOT clipped. Once everything is clipped, both are the same
 * operation. The count of still-open intervals is reported separately anyway,
 * so a reader can tell that part of the number is still accruing.
 */

/** One interval, as the arithmetic needs it. Deliberately not a Prisma row. */
export interface DeadIntervalSample {
  kind: 'stalled' | 'parked';
  startedAt: Date;
  /** Null means still open. */
  endedAt: Date | null;
}

export interface DeadTimeWindow {
  /** Mean hours of dead time per day across the window. */
  hoursPerDay: number;
  /** The stalled half of it — supervision failures. */
  stalledHoursPerDay: number;
  /** The parked half of it — quota and gates the system is waiting out. */
  parkedHoursPerDay: number;
  /** One value per day, oldest first, in hours. Always `days` long. */
  perDayHours: number[];
  /** How many intervals contributed anything at all. */
  intervals: number;
  /** How many of those are still open, so still accruing. */
  openIntervals: number;
}

export const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/**
 * How much of one interval falls inside `[from, to)`, in milliseconds.
 *
 * An open interval is treated as running to `to`, which is where "an open
 * interval is counted, clipped at the window's end" is actually implemented.
 * Never negative: an interval entirely outside the window contributes zero
 * rather than a negative duration that would silently cancel a real one out.
 */
export function overlapMs(
  interval: DeadIntervalSample,
  from: Date,
  to: Date,
): number {
  const start = Math.max(interval.startedAt.getTime(), from.getTime());
  const end = Math.min((interval.endedAt ?? to).getTime(), to.getTime());
  return Math.max(0, end - start);
}

/**
 * Metric 2 over a window.
 *
 * `days` is the DENOMINATOR as well as the bucket count, and it is the
 * requested window length rather than "days that had data". Dividing by
 * days-with-data would make a quiet week read the same as a busy one, which
 * defeats a per-day metric: two dead hours across seven days is a different
 * factory from two dead hours in one day, and only the stated denominator
 * tells them apart.
 */
export function deadTimeInWindow(
  intervals: DeadIntervalSample[],
  from: Date,
  days: number,
): DeadTimeWindow {
  const to = new Date(from.getTime() + days * DAY_MS);

  let totalMs = 0;
  let stalledMs = 0;
  let parkedMs = 0;
  let contributing = 0;
  let openIntervals = 0;

  for (const interval of intervals) {
    const ms = overlapMs(interval, from, to);
    if (ms <= 0) continue;

    contributing += 1;
    totalMs += ms;
    if (interval.kind === 'stalled') stalledMs += ms;
    else parkedMs += ms;
    if (interval.endedAt === null) openIntervals += 1;
  }

  const perDayHours: number[] = [];
  for (let day = 0; day < days; day += 1) {
    const bucketFrom = new Date(from.getTime() + day * DAY_MS);
    const bucketTo = new Date(bucketFrom.getTime() + DAY_MS);
    const bucketMs = intervals.reduce(
      (total, interval) => total + overlapMs(interval, bucketFrom, bucketTo),
      0,
    );
    perDayHours.push(bucketMs / HOUR_MS);
  }

  return {
    hoursPerDay: totalMs / HOUR_MS / days,
    stalledHoursPerDay: stalledMs / HOUR_MS / days,
    parkedHoursPerDay: parkedMs / HOUR_MS / days,
    perDayHours,
    intervals: contributing,
    openIntervals,
  };
}

/**
 * The sentence the metric carries so a reader knows which conventions produced
 * its number.
 *
 * #232 requires the parked-time decision be *"stated where the column is
 * defined"*, and it is — in `schema.prisma` and the migration. But a schema
 * comment is not visible to somebody looking at a dashboard tile, and this
 * metric rests on three choices that could each defensibly have gone the other
 * way: parked time counts, spanning intervals are split, open intervals are
 * clipped and counted. A number that depends on three conventions and states
 * none of them is not checkable.
 */
export function describeBasis(window: DeadTimeWindow, days: number): string {
  const hours = (value: number) => value.toFixed(1);

  return (
    `Hours parked or stalled per day, over ${days} rolling 24h day(s). ` +
    `${hours(window.stalledHoursPerDay)} h/day stalled, ` +
    `${hours(window.parkedHoursPerDay)} h/day parked — VISION §10 counts both. ` +
    `Intervals spanning a day boundary are split across the days they occupy. ` +
    `${window.openIntervals} of ${window.intervals} interval(s) in the window are still ` +
    `open and counted up to now, so that part is still accruing.`
  );
}
