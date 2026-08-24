/**
 * "What happens if ignored" — VISION §8's fourth field, derived (#98).
 *
 * The other three fields an operator needs to decide (`summary`, `reasoning`,
 * `blastRadius`) are written by whoever raised the request and are rendered
 * verbatim. This one is not carried on the row at all: it is derived from the
 * RECORDED `timeoutPolicy` and `timeoutAt`, which is the same pair the API's
 * notification builder derives its sentence from
 * (`apps/api/src/notifications/approval-payload.ts`) and the same pair the
 * sweeper acts on. Deriving it from the class's reversibility instead would
 * re-implement ADR-0014's total order in a second place, and the failure mode
 * is the worst available: the screen promises one thing and the sweeper does
 * another, four hours later, while the operator is asleep.
 *
 * ## The parked case must not imply a deadline
 *
 * `park_and_escalate` has `timeoutAt === null`, and that null IS the
 * never-auto-approve guarantee. `countdownAt` is therefore null for it, and
 * the caller renders NO countdown element — not an em dash, not "—", not a
 * disabled timer. An empty countdown slot still reads as a slot where a
 * deadline lives, and an operator who believes a deadline exists is an
 * operator who will let it lapse expecting something to happen. Nothing will.
 *
 * The `sentence` for that case contains no time-shaped substring for the same
 * reason. Its API-side twin asserts exactly that.
 */

import type { ApprovalTimeoutPolicy } from '../../types/approvals';

export interface IfIgnoredDescription {
  /**
   * The table-cell form. Never mentions a time — a triage row is scanned, and
   * the instant is the detail screen's job.
   */
  short: string;
  /** The sentence on the detail screen, above the fold. */
  sentence: string;
  /**
   * The instant to count down to, or NULL when there is no timer at all.
   *
   * Null is an instruction: render no countdown element.
   */
  countdownAt: string | null;
  /** True only for `park_and_escalate`: silence resolves this never. */
  waitsForever: boolean;
}

/** An absolute local time, for "Proceeds on its own at ...". */
export function formatDeadline(iso: string): string {
  const at = new Date(iso);
  // An unparseable timestamp is shown raw rather than as "Invalid Date": the
  // operator can still act on the string, and a caller cannot mistake it for a
  // real instant.
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export function describeIfIgnored(
  policy: ApprovalTimeoutPolicy,
  timeoutAt: string | null,
): IfIgnoredDescription {
  if (policy === 'park_and_escalate') {
    return {
      short: 'Nothing happens — no timer',
      sentence:
        'Nothing happens until you answer. There is no timer: this can never ' +
        'be approved by silence, under any trust grant. It will still be here ' +
        'tomorrow, and the work behind it stays blocked until then.',
      countdownAt: null,
      waitsForever: true,
    };
  }

  // A timed policy always carries an instant. The fallback is not a defensive
  // reflex: if one ever arrives without it, naming the right OUTCOME with a
  // vaguer time beats refusing to render the field the operator decides on.
  // What it must NOT do is offer a countdown to an instant nobody supplied.
  const when = timeoutAt
    ? `at ${formatDeadline(timeoutAt)}`
    : 'when its window closes';

  if (policy === 'auto_approve') {
    return {
      short: 'Proceeds on its own',
      sentence:
        `Proceeds on its own ${when}. Nobody has to do anything, and the ` +
        'fact that it ran without a human looking is recorded either way.',
      countdownAt: timeoutAt,
      waitsForever: false,
    };
  }

  return {
    short: 'Refused; can be raised again',
    sentence:
      `Refused ${when}; nothing happens, no money is spent and nothing is ` +
      'changed. A refusal by silence is not a judgement about the action, so ' +
      'it can be raised again.',
    countdownAt: timeoutAt,
    waitsForever: false,
  };
}

/**
 * `3h 12m`, `4m 20s`, `2d 6h` — how long is left, compactly.
 *
 * Compact rather than `Intl.RelativeTimeFormat` for the reason `utils/time.ts`
 * gives: these strings live in a ~90px table cell.
 *
 * A non-positive remainder is NOT rendered as `0s`. The window has lapsed and
 * the sweeper has not reached the row yet — a decision made now still counts
 * and comes back with `decidedAfterTimeout: true` — so the string says so.
 */
export function formatCountdown(msRemaining: number): string {
  if (!Number.isFinite(msRemaining) || msRemaining <= 0) return 'window lapsed';

  const totalSeconds = Math.floor(msRemaining / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/** Milliseconds until `iso`, negative once it has passed. */
export function millisecondsUntil(iso: string, now: Date = new Date()): number {
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return Number.NaN;
  return at - now.getTime();
}
