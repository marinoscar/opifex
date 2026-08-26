/**
 * What the guided Claude sign-in looks like on screen (#386, epic #332).
 *
 * The API answers a `reason` and a `message`; this file decides what a screen
 * does with each one. That split is deliberate and mirrors
 * `credentialProbes.ts`: the API's sentence is written for a human and is
 * rendered verbatim, but *whether to offer another attempt* is a rendering
 * decision, and putting it here keeps it in one place rather than in a chain
 * of ternaries inside a dialog.
 *
 * ## Why `retryable` exists at all
 *
 * Two of the seven reasons are deployment faults. `cli_missing` means the
 * `claude` binary is not in the API container; `pty_unavailable` means
 * `script(1)` is not either. Neither changes because an operator pressed a
 * button again — the next attempt fails identically, in the same forty
 * seconds, with the same message. Offering Retry there is not a harmless
 * convenience: it tells the operator the problem is theirs and transient,
 * when it is neither, and it is the reason they will spend ten minutes
 * clicking before someone thinks to look at the image. The API distinguished
 * these four causes at real cost — reading vendor strings out of a shipped
 * binary — and collapsing them back into one red box on this side would throw
 * that away.
 */

import type { ClaudeAuthFailureReason } from '../types/claudeAuth';

/**
 * The one credential this flow can obtain.
 *
 * A key rather than a heuristic. The Credentials section renders a card per
 * secret the API publishes, and only this one has a CLI that can mint it; the
 * console/API-key path is a different credential with a different cost model
 * and stays a manual paste (#386, out of scope).
 */
export const CLAUDE_OAUTH_TOKEN_KEY = 'runners.claudeCodeLocal.oauthToken';

/** Whether this secret can be obtained by signing in rather than pasted. */
export function supportsGuidedSignIn(key: string): boolean {
  return key === CLAUDE_OAUTH_TOKEN_KEY;
}

export interface ClaudeAuthFailurePresentation {
  /** The alert heading — the one line that says which of the seven this is. */
  title: string;
  severity: 'error' | 'warning' | 'info';
  /**
   * Whether starting another sign-in could plausibly end differently.
   *
   * False only for the two deployment faults. See this file's header.
   */
  retryable: boolean;
  /**
   * What to do next, in the screen's words. Shown BESIDE the API's `message`,
   * not instead of it: the API explains the cause, this names the move.
   */
  nextStep: string;
}

const FAILURE_PRESENTATIONS: Record<
  ClaudeAuthFailureReason,
  ClaudeAuthFailurePresentation
> = {
  invalid_code: {
    title: 'That code was rejected',
    severity: 'warning',
    retryable: true,
    nextStep:
      'Start again and paste the whole code as soon as the browser gives ' +
      'it to you — it is single-use and expires within a few minutes, so ' +
      'the usual causes are a code that sat too long, one that was already ' +
      'used, or a copy that missed a character.',
  },
  no_subscription: {
    title: 'That Claude account cannot issue a token',
    severity: 'error',
    retryable: true,
    nextStep:
      'Trying again with the same account will fail the same way. Either ' +
      'sign in with an account on an active Claude Pro, Max, Team or ' +
      'Enterprise plan, or leave this credential unset and configure an ' +
      'Anthropic API key instead — that is a different credential, billed ' +
      'per token rather than against a subscription.',
  },
  cli_missing: {
    title: 'The Claude Code CLI is not installed in the API container',
    severity: 'error',
    retryable: false,
    nextStep:
      'This is a deployment fault, not something this sign-in can retry ' +
      'around: nothing was ever started, and another attempt fails ' +
      'identically. Check the binary named by ' +
      'runners.claudeCodeLocal.binary — Test CLI on this card asks exactly ' +
      'the same question — and install it in the API image.',
  },
  pty_unavailable: {
    title: 'The API container cannot allocate a terminal',
    severity: 'error',
    retryable: false,
    nextStep:
      'This is a deployment fault, not something this sign-in can retry ' +
      'around. `claude setup-token` refuses to run without a pseudo-' +
      'terminal, and this image is missing `script(1)` from `util-linux`. ' +
      'Rebuild the API image; until then this flow cannot start, and the ' +
      'token has to be pasted in by hand.',
  },
  timed_out: {
    title: 'This sign-in expired before a code arrived',
    severity: 'warning',
    retryable: true,
    nextStep:
      'Nothing was changed. A sign-in lasts ten minutes and the code the ' +
      'browser hands you is good for only a few, so open the link and this ' +
      'page side by side before starting again.',
  },
  cancelled: {
    title: 'This sign-in was cancelled',
    severity: 'info',
    retryable: true,
    nextStep:
      'Nothing was changed and the Claude Code process was stopped. Start ' +
      'again whenever you are ready.',
  },
  unknown: {
    title: 'The sign-in ended without a token',
    severity: 'error',
    retryable: true,
    nextStep:
      'The CLI stopped in a way neither the API nor this page recognises. ' +
      "The API log holds the CLI's own output for this attempt, with " +
      'anything token-shaped redacted. Retrying is reasonable once; if it ' +
      'repeats, read that log rather than the screen.',
  },
};

/**
 * How to render a failure.
 *
 * Falls back to `unknown` for a reason this build has never heard of, because
 * the API may be newer than the browser tab reading it and "no alert at all"
 * is the worst possible answer to a failure.
 */
export function claudeAuthFailurePresentation(
  reason: ClaudeAuthFailureReason,
): ClaudeAuthFailurePresentation {
  return FAILURE_PRESENTATIONS[reason] ?? FAILURE_PRESENTATIONS.unknown;
}

export interface ClaudeAuthExpiry {
  /** Whether this session is past its deadline according to the browser clock. */
  expired: boolean;
  /** Milliseconds left, floored at zero. Zero when `expiresAt` is unreadable. */
  remainingMs: number;
  /** `9:41`, or null when there is nothing honest to count down from. */
  countdown: string | null;
  /** The whole sentence, ready to render. */
  label: string;
}

/**
 * How long is left, derived at render from a clock sample.
 *
 * Derived, never stored: the only state a caller keeps is `now`, and this is
 * recomputed from it. An expiry copied into state at start would keep
 * rendering "8 minutes left" for a session the API has already killed.
 *
 * An unparseable `expiresAt` is reported as unknown rather than as expired.
 * Guessing "expired" would hide a live session behind a dead-looking screen;
 * guessing "fine" would let the operator paste into one that is gone. Saying
 * neither is the only claim the data supports.
 */
export function claudeAuthExpiry(
  expiresAt: string,
  now: number,
): ClaudeAuthExpiry {
  const deadline = Date.parse(expiresAt);

  if (Number.isNaN(deadline)) {
    return {
      expired: false,
      remainingMs: 0,
      countdown: null,
      label:
        'This sign-in has a deadline the API did not report in a readable ' +
        'form, so there is no countdown here. Sign-ins last ten minutes.',
    };
  }

  const remainingMs = Math.max(0, deadline - now);

  if (remainingMs === 0) {
    return {
      expired: true,
      remainingMs: 0,
      countdown: '0:00',
      label:
        'This sign-in has expired. A code pasted now would be refused — ' +
        'start a new one.',
    };
  }

  const totalSeconds = Math.floor(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const countdown = `${minutes}:${seconds.toString().padStart(2, '0')}`;

  return {
    expired: false,
    remainingMs,
    countdown,
    label: `Expires in ${countdown}. Ten minutes from the moment it started.`,
  };
}
