/**
 * Formatting for the watchdog coverage panel (#104).
 *
 * Three small functions, and each of them exists to avoid restating something
 * the API already decided.
 */

import type {
  RateLimitSignal,
  StreamingFidelity,
  WatchdogCheckId,
} from '../../types/cockpit';

/**
 * A threshold, rendered the way the API renders it.
 *
 * This is a deliberate PORT of `formatDuration` in
 * `apps/api/src/watchdog/silent-detection.ts`, character-for-character in its
 * output, and NOT a call to `components/trust/trustFormat.ts`'s function of
 * the same name. That one is coarse on purpose — it answers "how long has this
 * grant got?" with `4h` and anything under a minute with "less than a minute",
 * which is right for a grant that lives for days and catastrophic here: the
 * `full`-fidelity silence threshold is 90 seconds, and "less than a minute" is
 * not merely vague about it, it is wrong.
 *
 * The API's own comment explains the rounding rule this copies:
 *
 * > Rounding to whole minutes on both sides produced "silent for 2m, exceeding
 * > the 2m threshold" for a 95-second silence against a 90-second threshold —
 * > a justification that cannot justify itself.
 *
 * The number an operator reads here is the number they use to decide whether a
 * quiet run is worth chasing, and the sentence they read it next to is the
 * watchdog's own `reason` string, which already contains the API's rendering
 * of the same value. Two renderings of one number is the cheapest possible way
 * to make them look like two different numbers — so this matches, and
 * `watchdogFormat.test.ts` pins the shared cases.
 */
export function formatThresholdMs(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  if (mins < 60) return secs === 0 ? `${mins}m` : `${mins}m ${secs}s`;

  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}

/**
 * A check's display name, derived MECHANICALLY from its id.
 *
 * `'loop-detection'` → `'Loop detection'`. There is no lookup table here, and
 * that absence is the point: the cockpit must not hold a second, editable copy
 * of the check taxonomy. A table of pretty names is one edit away from a table
 * of descriptions, and a description written here would be a client-side claim
 * about what a detector does — the exact drift `check-coverage.ts` refuses to
 * allow, and which its `signal` and `reason` fields exist to prevent.
 *
 * The mechanical derivation also means a fifth check added server-side renders
 * with a correct name on the day it ships rather than as a blank cell.
 */
export function formatCheckName(check: WatchdogCheckId): string {
  const words = check.split('-').join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * A declared capability, or the fact that nothing was declared.
 *
 * **Null is not `'none'`, and this function's whole job is to keep them
 * apart.** `'none'` is a runner that filed a manifest saying it streams
 * nothing — a known, bounded limitation. Null is a runner that filed no
 * manifest at all: nothing is known about it, the most permissive thresholds
 * apply by default, and the fix is to register the runner rather than to
 * replace it. Collapsing the two into the word "None" would hide the more
 * alarming of the two behind the less alarming one.
 */
export function formatDeclaration(
  value: StreamingFidelity | RateLimitSignal | null,
): string {
  if (value === null) return 'No manifest filed';
  return value.charAt(0).toUpperCase() + value.slice(1);
}
