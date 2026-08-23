/**
 * Time formatting for the cockpit.
 *
 * Epic #19. Pure functions taking an explicit `now`, which is the whole point:
 * a component that calls `Date.now()` internally cannot be tested without
 * faking the clock, and "3m ago" is a string an operator makes decisions on.
 *
 * `Intl.RelativeTimeFormat` is deliberately not used. It produces "3 minutes
 * ago", and these strings appear in dense table cells and in the attention
 * panel where the column is ~60px wide. The compact forms below are the
 * convention across the app's data surfaces.
 */

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * `2026-08-19T09:58:00Z` -> `3m ago`.
 *
 * Returns `null` for a missing or unparseable timestamp rather than a
 * placeholder string, so the CALLER decides how absence is rendered — which is
 * the honesty contract's rule that nothing invents a value on someone else's
 * behalf. `Invalid Date` is unparseable, not "now".
 *
 * A future timestamp reads "in 5m" rather than "-5m ago": clock skew between
 * the control plane and the browser is real, and a negative age looks like a
 * bug in the UI rather than a fact about the data.
 */
export function formatRelativeTime(
  value: string | Date | null | undefined,
  now: Date = new Date(),
): string | null {
  if (value === null || value === undefined) return null;

  const then = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(then.getTime())) return null;

  const deltaMs = now.getTime() - then.getTime();
  const isFuture = deltaMs < 0;
  const magnitude = Math.abs(deltaMs);

  const amount =
    magnitude < MINUTE
      ? 'just now'
      : magnitude < HOUR
        ? `${Math.floor(magnitude / MINUTE)}m`
        : magnitude < DAY
          ? `${Math.floor(magnitude / HOUR)}h`
          : `${Math.floor(magnitude / DAY)}d`;

  if (amount === 'just now') return isFuture ? 'in a moment' : 'just now';
  return isFuture ? `in ${amount}` : `${amount} ago`;
}

/**
 * A wall-clock time, for "stale since 14:32".
 *
 * The header uses an ABSOLUTE time for staleness while rows use relative ages,
 * and that asymmetry is intentional: a relative "updated 4m ago" that is
 * itself only refreshed every 30s is a stale string about staleness. A clock
 * time cannot go stale.
 */
export function formatClockTime(value: Date | null | undefined): string | null {
  if (!value || Number.isNaN(value.getTime())) return null;
  return value.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
}
