/**
 * The guided Claude sign-in, as the API serialises it (#386, epic #332).
 *
 * A hand-written mirror of
 * `apps/api/src/settings/operator-settings/claude-auth/dto/claude-auth.dto.ts`.
 * All four routes — `start`, the poll, `code` and `cancel` — answer the same
 * `ClaudeAuthSessionDto`, so there is one shape here and not four, and the
 * screen has one renderer for whatever comes back.
 *
 * ## The member this file must never grow
 *
 * `token`. The API seals the credential into
 * `runners.claudeCodeLocal.oauthToken` server-side and tells the browser
 * `configured: true` and nothing else — its own `claude-auth-secret-leak.spec.ts`
 * serialises every response and greps for the plaintext. Declaring a `token`
 * here would be this app inventing a field the contract does not have, and the
 * first component to render it would leak a year-long credential into the DOM.
 * `ClaudeAuthPanel`'s leak test is the counterpart on this side.
 */

/**
 * Where a sign-in is, from the operator's point of view.
 *
 * `awaiting_code` is the only state with something for a human to do, and the
 * only one in which `url` is populated — a finished session's URL is spent,
 * and showing it invites a second doomed attempt.
 */
export const CLAUDE_AUTH_STATUSES = [
  'awaiting_code',
  'exchanging',
  'completed',
  'failed',
  'cancelled',
  'expired',
] as const;

export type ClaudeAuthStatus = (typeof CLAUDE_AUTH_STATUSES)[number];

/**
 * Why it did not produce a token.
 *
 * Seven values rather than one, because the API went to real trouble to tell
 * them apart and each has a different next step: re-copy a code, check a plan,
 * rebuild the image, or nothing at all. `config/claudeAuth.ts` is where each
 * one becomes something on screen.
 */
export const CLAUDE_AUTH_FAILURE_REASONS = [
  'invalid_code',
  'no_subscription',
  'cli_missing',
  'pty_unavailable',
  'timed_out',
  'cancelled',
  'unknown',
] as const;

export type ClaudeAuthFailureReason =
  (typeof CLAUDE_AUTH_FAILURE_REASONS)[number];

export interface ClaudeAuthError {
  /** What the UI branches on. */
  reason: ClaudeAuthFailureReason;
  /** The sentence the operator reads, written by the API. */
  message: string;
}

export interface ClaudeAuthSession {
  sessionId: string;
  status: ClaudeAuthStatus;
  /** The vendor's authorize URL. Populated in `awaiting_code` and nowhere else. */
  url: string | null;
  startedAt: string;
  /** ISO, start + 10 minutes. Rendered as a countdown, not discovered on submit. */
  expiresAt: string;
  /**
   * Whether `runners.claudeCodeLocal.oauthToken` now resolves to something.
   * THE success signal, and the whole of it.
   */
  configured: boolean;
  error: ClaudeAuthError | null;
}

/** True for a session that will never change again. */
export function isTerminalClaudeAuthStatus(status: ClaudeAuthStatus): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'expired'
  );
}
