import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { CLAUDE_AUTH_FAILURE_REASONS } from '../claude-cli-output';

/**
 * Connect your Claude account, without a shell (#386, epic #332).
 *
 * The Claude subscription token was the one credential the Control Center
 * could not obtain, because `claude setup-token` needs a TTY and the operator
 * had to go and get one — `docker compose exec`, then copy the result into
 * `.env` by hand, which is the loop epic #332 exists to end. These four
 * endpoints drive the vendor's own CLI on a pty instead: start it, read the
 * authorize URL it prints, take the pasted code back over HTTP, and seal the
 * token it produces.
 *
 * ## The one thing this schema must never grow
 *
 * A `token` member. The token is sealed server-side into
 * `runners.claudeCodeLocal.oauthToken` and the browser is told `configured:
 * true` and nothing else. `claude-auth-secret-leak.spec.ts` serializes every
 * response of every endpoint and greps for the plaintext, for the same reason
 * `operator-settings-secret-leak.spec.ts` does it for the settings document:
 * a field-by-field assertion only tests the fields somebody thought of.
 */

/**
 * Where a session is, from an operator's point of view rather than the
 * process's.
 *
 * `awaiting_code` is the only state with anything for a human to do, which is
 * why the URL is only ever populated there — a completed or failed session
 * hands back a URL that now goes nowhere, and showing it invites a second
 * doomed attempt.
 */
export const CLAUDE_AUTH_STATUSES = [
  /** The CLI is up, the URL is captured, and it is blocked on the paste. */
  'awaiting_code',
  /** A code has been submitted and the vendor exchange is in flight. */
  'exchanging',
  /** A token was produced and sealed. Nothing further to do. */
  'completed',
  /** It ended without a token. `error` says why, in four different ways. */
  'failed',
  /** An operator pressed Cancel. The child was killed. */
  'cancelled',
  /** Nobody pasted a code in time. The child was killed. */
  'expired',
] as const;

export type ClaudeAuthStatus = (typeof CLAUDE_AUTH_STATUSES)[number];

/** True for a session that will never change again. */
export function isTerminal(status: ClaudeAuthStatus): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'expired'
  );
}

export const claudeAuthFailureReasonSchema = z.enum([
  ...CLAUDE_AUTH_FAILURE_REASONS,
] as [string, ...string[]]);

/**
 * Why it did not work, machine-readable and human-readable at once.
 *
 * Both, because they are for different readers: `reason` is what the UI
 * branches on (offer Retry for `invalid_code`, do not for `no_subscription`),
 * and `message` is the sentence the operator reads. Returning only one of the
 * two forces the other side to reconstruct it, badly.
 */
export const claudeAuthErrorSchema = z.object({
  reason: claudeAuthFailureReasonSchema,
  message: z.string(),
});

export const claudeAuthSessionSchema = z.object({
  sessionId: z.uuid(),
  status: z.enum(CLAUDE_AUTH_STATUSES),
  /**
   * The vendor's PKCE authorize URL, for `awaiting_code` and nothing else.
   *
   * Not a secret — it is meant for a browser — but it is single-use and short
   * lived, so a stale one is a trap rather than a convenience.
   */
  url: z.url().nullable(),
  startedAt: z.iso.datetime(),
  /**
   * When this session stops accepting a code.
   *
   * Returned so the UI can count down rather than discover expiry by being
   * refused. The authorization code the browser hands over is itself only
   * good for a few minutes, so a session that outlived its usefulness is the
   * common case, not the rare one.
   */
  expiresAt: z.iso.datetime(),
  /**
   * Whether `runners.claudeCodeLocal.oauthToken` now resolves to something.
   *
   * THE success signal, and the whole of it. It replaces returning the token,
   * which this API never does.
   */
  configured: z.boolean(),
  error: claudeAuthErrorSchema.nullable(),
});

export class ClaudeAuthSessionDto extends createZodDto(
  claudeAuthSessionSchema,
) {}

export type ClaudeAuthSession = z.infer<typeof claudeAuthSessionSchema>;

/**
 * The code the operator pastes back.
 *
 * Bounded rather than free — a code is a short opaque string, and accepting an
 * unbounded body on a route that writes it to a subprocess's stdin is a way to
 * hand an attacker a very long line. `trim()` because copying from a browser
 * routinely brings whitespace, and refusing a code for a trailing newline
 * would be the least helpful possible failure.
 *
 * Newlines are REJECTED rather than stripped. The value is written to a
 * terminal that treats a newline as "submit", so an embedded one would send a
 * partial code and then feed the remainder to whatever prompt came next.
 * Refusing is the honest answer; silently truncating is not.
 */
export const submitClaudeAuthCodeSchema = z.object({
  code: z
    .string()
    .trim()
    .min(1, 'Paste the code the browser gave you.')
    .max(512, 'That is too long to be an authorization code.')
    .refine((value) => !/[\r\n]/.test(value), {
      message: 'An authorization code is a single line with no line breaks.',
    }),
});

export class SubmitClaudeAuthCodeDto extends createZodDto(
  submitClaudeAuthCodeSchema,
) {}
