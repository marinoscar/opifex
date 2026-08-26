/**
 * How a sign-in's failures and its deadline are presented (#386, epic #332).
 *
 * Two claims worth pinning here rather than through a render: that the nine
 * reasons stay nine distinct things, and that the countdown says nothing it
 * cannot support.
 */

import { describe, expect, it } from 'vitest';

import {
  CLAUDE_OAUTH_TOKEN_KEY,
  claudeAuthExpiry,
  claudeAuthFailurePresentation,
  supportsGuidedSignIn,
} from '../../config/claudeAuth';
import { CLAUDE_AUTH_FAILURE_REASONS } from '../../types/claudeAuth';

describe('supportsGuidedSignIn', () => {
  it('is offered for the Claude token and for nothing else', () => {
    expect(supportsGuidedSignIn(CLAUDE_OAUTH_TOKEN_KEY)).toBe(true);
    // A GitHub token has no CLI that can mint one; offering the flow there
    // would be an offer this app cannot keep.
    expect(supportsGuidedSignIn('github.token')).toBe(false);
    expect(supportsGuidedSignIn('supervisor.model.apiKey')).toBe(false);
  });
});

describe('claudeAuthFailurePresentation', () => {
  it('gives every reason its own heading', () => {
    const titles = CLAUDE_AUTH_FAILURE_REASONS.map(
      (reason) => claudeAuthFailurePresentation(reason).title,
    );

    // The API distinguished these at real cost — vendor strings read out of a
    // shipped binary. Two reasons sharing a heading throws that away on the
    // last hop.
    expect(new Set(titles).size).toBe(titles.length);
  });

  it('refuses a retry for the two faults a retry cannot fix', () => {
    expect(claudeAuthFailurePresentation('cli_missing').retryable).toBe(false);
    expect(claudeAuthFailurePresentation('pty_unavailable').retryable).toBe(
      false,
    );
    // Everything else could genuinely end differently next time: a fresh code,
    // a different account, a slower operator.
    expect(claudeAuthFailurePresentation('invalid_code').retryable).toBe(true);
    expect(claudeAuthFailurePresentation('timed_out').retryable).toBe(true);
  });

  it('does not present a stalled CLI as an expiry', () => {
    // #389. Both of these used to arrive as `timed_out`, whose heading reads
    // "This sign-in expired before a code arrived" — untrue for either, and
    // an invitation to retry the thing that had just failed identically. The
    // one that matters most is `cli_no_response`: the code DID reach the CLI,
    // so telling the operator to re-copy it sends them somewhere there is
    // nothing to find.
    const expiry = claudeAuthFailurePresentation('timed_out');

    for (const reason of ['cli_no_url', 'cli_no_response'] as const) {
      const stalled = claudeAuthFailurePresentation(reason);

      expect(stalled.title).not.toMatch(/expired/i);
      expect(stalled.title).not.toBe(expiry.title);
      expect(stalled.nextStep).toMatch(/nothing was changed/i);
    }

    expect(claudeAuthFailurePresentation('cli_no_response').nextStep).toMatch(
      /not an expiry/i,
    );
  });

  it('names the fix for a deployment fault rather than the operator', () => {
    expect(claudeAuthFailurePresentation('cli_missing').nextStep).toMatch(
      /deployment fault/i,
    );
    expect(claudeAuthFailurePresentation('pty_unavailable').nextStep).toMatch(
      /util-linux/,
    );
  });

  it('falls back to unknown for a reason this build has never heard of', () => {
    // The API can be newer than the tab reading it, and "no alert at all" is
    // the worst possible answer to a failure.
    const invented = 'quota_exhausted' as never;
    expect(claudeAuthFailurePresentation(invented)).toEqual(
      claudeAuthFailurePresentation('unknown'),
    );
  });
});

describe('claudeAuthExpiry', () => {
  const start = Date.parse('2026-08-23T10:00:00.000Z');
  const deadline = '2026-08-23T10:10:00.000Z';

  it('counts down in minutes and seconds', () => {
    const expiry = claudeAuthExpiry(deadline, start + 30_000);

    expect(expiry.expired).toBe(false);
    expect(expiry.countdown).toBe('9:30');
    expect(expiry.label).toContain('Expires in 9:30');
  });

  it('pads the seconds, so 9:05 never reads as 9:5', () => {
    expect(claudeAuthExpiry(deadline, start + 55_000).countdown).toBe('9:05');
  });

  it('says a passed deadline is passed, and why that matters', () => {
    const expiry = claudeAuthExpiry(deadline, start + 11 * 60_000);

    expect(expiry.expired).toBe(true);
    expect(expiry.remainingMs).toBe(0);
    expect(expiry.label).toMatch(/would be refused/i);
  });

  it('claims neither live nor expired when the deadline is unreadable', () => {
    // Guessing "expired" hides a live session behind a dead screen; guessing
    // "fine" invites a paste into one that is gone. Neither claim is supported
    // by a date that will not parse.
    const expiry = claudeAuthExpiry('not-a-date', start);

    expect(expiry.expired).toBe(false);
    expect(expiry.countdown).toBeNull();
    expect(expiry.label).toMatch(/no countdown/i);
  });
});
