/**
 * How the quota screen's facts are rendered (#476).
 *
 * Small, pure, and taking an explicit `now` where a clock is involved — the
 * same contract `utils/time.ts` sets, and for the same reason: these strings
 * are what an operator decides on, and a function that reads `Date.now()`
 * internally cannot be tested without faking the clock.
 */

import type { ExhaustedWindow } from '../../types/quota';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * The time ranges the history offers, as whole days back from now.
 *
 * Days rather than named calendar periods ("today", "this week") because the
 * API's bounds are instants and the question is "how far back am I looking",
 * not "which calendar box". `days: null` is all of time — a real option, since
 * the history is sparse by design: nothing is dispatched while the observation
 * week is read-only, and a screen that defaulted to a window with no rows in
 * it would read as broken rather than as quiet.
 */
export interface HistoryRange {
  /** Stable value for the select. Never derived from the label. */
  id: string;
  label: string;
  /** How far back, or null for no lower bound at all. */
  days: number | null;
}

export const HISTORY_RANGES: readonly HistoryRange[] = [
  { id: '1d', label: 'Last 24 hours', days: 1 },
  { id: '7d', label: 'Last 7 days', days: 7 },
  { id: '30d', label: 'Last 30 days', days: 30 },
  { id: '90d', label: 'Last 90 days', days: 90 },
  { id: 'all', label: 'All time', days: null },
];

/**
 * The default, and why it is the widest bounded one.
 *
 * 30 days matches the cost screen's default window, so the two retrospective
 * screens answer "how has it been going" over the same span unless somebody
 * says otherwise.
 */
export const DEFAULT_HISTORY_RANGE = '30d';

/**
 * A range as the API's `since`, or undefined for no lower bound.
 *
 * Full ISO instants, because both endpoints declare `z.iso.datetime()` and a
 * bare `YYYY-MM-DD` is refused by the query schema — a filter that 400s is
 * worse than one that is not offered.
 */
export function sinceFor(
  rangeId: string,
  now: Date = new Date(),
): string | undefined {
  const range = HISTORY_RANGES.find((candidate) => candidate.id === rangeId);
  if (!range || range.days === null) return undefined;
  return new Date(now.getTime() - range.days * DAY).toISOString();
}

/**
 * How long an episode lasted — always an UPPER BOUND, never a measurement.
 *
 * `durationMs` is derived from the run blocking again or from
 * `Run.lastEventAt`, because nothing writes `RunAttempt` rows and the exact
 * resume instant is stored nowhere. The caller is responsible for saying "at
 * most" beside this; what this function guarantees is that it never invents a
 * figure for an episode that is still open.
 *
 * Deliberately more precise than `trustFormat.formatDuration`, which collapses
 * to whole hours: the difference between a 4h block and a 4h 55m one is the
 * difference between a five-hour window and most of an afternoon, and that is
 * the quantity #476 exists to make visible.
 */
export function formatEpisodeDuration(durationMs: number | null): string {
  // Null is NOT zero, and here it is not even "short": the episode has no
  // observed end at all. An em dash would read as "nothing to show" on a row
  // whose whole point is that something is still happening.
  if (durationMs === null) return 'still open';

  const span = Math.max(0, durationMs);
  if (span < MINUTE) return 'under a minute';
  if (span < HOUR) return `${Math.floor(span / MINUTE)}m`;

  const hours = Math.floor(span / HOUR);
  const minutes = Math.floor((span % HOUR) / MINUTE);
  if (span < DAY) return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;

  const days = Math.floor(span / DAY);
  const remainingHours = Math.floor((span % DAY) / HOUR);
  return remainingHours === 0 ? `${days}d` : `${days}d ${remainingHours}h`;
}

/**
 * An absolute instant, for a reset time.
 *
 * ABSOLUTE where ages are relative, the same asymmetry `formatHoldEnd` makes
 * on the trust screen: a reset is a moment an operator plans around ("it is
 * back at 16:20"), and "in 3h" is the one form that cannot be checked against
 * the vendor's own figure.
 *
 * An unparseable value is returned RAW rather than as "Invalid Date" — the
 * operator can still act on the string, and nobody can mistake it for a real
 * instant.
 */
export function formatInstant(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

/**
 * What a window's `blockedRuns` actually says — including when it is zero.
 *
 * **Zero is the case the windows endpoint exists for.** A window that reached
 * its ceiling with nothing dispatched against it leaves no `run_events` row,
 * so it is invisible to the episodes list, and it is still a true answer to
 * "when did we hit rate limits". Rendering a bare `0` in a numeric column
 * would read as a missing join; this says the thing in words.
 */
export function describeBlockedRuns(window: ExhaustedWindow): string {
  if (window.blockedRuns === 0) return 'Nothing dispatched';

  const runs =
    window.blockedRuns === 1 ? '1 run' : `${window.blockedRuns} runs`;
  // The two counts differ whenever a run blocked against the same window more
  // than once, which is ordinary — a run resumes, tries again and is refused
  // again. Saying only the run count would understate the noise.
  if (window.blockedEvents === window.blockedRuns) return `${runs} blocked`;
  return `${runs} blocked · ${window.blockedEvents} blocks`;
}

/**
 * Opifex's OWN consumption through a window, named for whose it is.
 *
 * Never the window's total: VISION §11's subscription is shared with the
 * operator's interactive use, which burns the same window and leaves no record
 * here. `null` cost is not `$0.00` — a runner that does not report cost is a
 * supported case, and a total that ignored those runs would understate
 * consumption while looking precise.
 */
export function describeConsumption(consumption: {
  runs: number;
  runsWithoutCost: number;
  reportedUsd: number | null;
}): string {
  const runs = consumption.runs === 1 ? '1 run' : `${consumption.runs} runs`;
  const cost =
    consumption.reportedUsd === null
      ? 'no cost reported'
      : `$${consumption.reportedUsd.toFixed(2)} reported`;

  if (consumption.runsWithoutCost === 0) return `${runs} · ${cost}`;
  return `${runs} · ${cost} · ${consumption.runsWithoutCost} without cost`;
}
