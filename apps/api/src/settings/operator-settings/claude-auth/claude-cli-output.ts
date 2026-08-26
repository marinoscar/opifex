/**
 * Reading `claude setup-token`'s terminal output (#386).
 *
 * Pure functions over a string, with no knowledge of processes, sessions or
 * HTTP — so the part of this feature most likely to break when the vendor
 * reflows a screen is the part that can be tested against a real capture
 * without spawning anything. The captures live in
 * `claude-cli-output.fixtures.ts` and came out of the real CLI on a real pty.
 *
 * ## Why stripping escapes is not "delete the escapes"
 *
 * The CLI renders through Ink, which does not emit spaces between words. It
 * emits a cursor-column escape:
 *
 *     Welcome\x1b[9Gto\x1b[12GClaude\x1b[19GCode
 *
 * Deleting the escapes yields `WelcometoClaudeCode`, so every phrase this
 * module looks for — `Paste code here if prompted`, `OAuth error`, `account is
 * on hold` — silently stops matching. {@link stripAnsi} therefore replaces
 * positioning sequences with a SPACE and removes only the rest. That single
 * distinction is the whole reason this file has a test with a real sample
 * rather than a tidy one.
 *
 * ## Why the URL comes from the hyperlink and not the text
 *
 * On an 80-column pty the visible URL is torn into five pieces across five
 * lines, and there is no honest way to tell a soft wrap from a real newline
 * after the fact. Ink wraps each piece in an OSC 8 hyperlink whose target is
 * the WHOLE url, repeated per piece, so {@link extractAuthorizeUrl} reads the
 * target. The service also widens the pty, which makes the wrapping go away —
 * but the extractor does not depend on that having worked.
 */

/** Where the CLI sends the operator, and the only URL shape accepted. */
const AUTHORIZE_URL_PREFIX = 'https://claude.com/';

/**
 * OSC 8: `ESC ] 8 ; <params> ; <target> BEL` (or `ESC \` as the terminator).
 *
 * The closing half of the pair is `ESC ] 8 ; ; BEL`, with an empty target,
 * which is why the target group is allowed to be empty and filtered after.
 */
const OSC8_HYPERLINK = /\x1b\]8;[^;]*;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;

/**
 * An OAuth token as the CLI prints it on success.
 *
 * Deliberately broader than `sk-ant-oat01-`: the prefix is a vendor detail
 * that has changed before, and a token we fail to recognise is an operator
 * staring at a spinner that never resolves. The `[A-Za-z0-9_-]{24,}` tail is
 * what makes it safe to be broad — no ordinary sentence in this output has a
 * 24-character unbroken run after `sk-ant-`.
 */
const OAUTH_TOKEN = /sk-ant-[A-Za-z0-9_-]{24,}/;

/**
 * Terminal escape sequences, split by whether they MOVE the cursor.
 *
 * `G` (cursor horizontal absolute), `C` (cursor forward) and `H`/`f` (cursor
 * position) are how this CLI writes a space. Everything else — colours, erase,
 * mode switches, OSC strings — is presentation and goes away entirely.
 */
const CURSOR_MOVE = /\x1b\[[0-9;]*[GCHf]/g;
const OSC_STRING = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const CSI_OTHER = /\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g;
const ESC_TWO_CHAR = /\x1b[()#][0-9A-Za-z]|\x1b[0-9A-Za-z=><\\\]^_]/g;
const ESC_STRAY = /\x1b/g;
const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/**
 * The CLI's output as readable text: escapes gone, words separated, lines kept.
 *
 * Lines are KEPT rather than flattened because a flattened blob would let a
 * phrase match across a boundary it never actually crossed — and because the
 * caller wants to be able to say "this appeared after the code was submitted",
 * which needs the text to still be a sequence.
 */
export function stripAnsi(raw: string): string {
  return (
    raw
      // OSC first: its payload can contain `[`-looking bytes that the CSI
      // patterns below would otherwise chew into.
      .replace(OSC_STRING, '')
      .replace(CURSOR_MOVE, ' ')
      .replace(CSI_OTHER, '')
      .replace(ESC_TWO_CHAR, '')
      .replace(ESC_STRAY, '')
      // `script` writes `\r\r\n` for every newline. Normalise before the
      // control-character sweep so the line structure survives it.
      .replace(/\r+\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(CONTROL_CHARS, '')
      // Ink pads with runs of positioning escapes, which the rule above turned
      // into runs of spaces. Collapse them so a phrase match is about words.
      .replace(/[^\S\n]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .trim()
  );
}

/**
 * The authorize URL, or `null` if the CLI has not printed it yet.
 *
 * Prefers the OSC 8 target (whole, never wrapped); falls back to the visible
 * text for a terminal that suppressed hyperlinks. The fallback is the weaker
 * of the two — on a narrow pty it returns a truncated URL — so it runs second
 * and only when there is no hyperlink at all.
 */
export function extractAuthorizeUrl(raw: string): string | null {
  for (const match of raw.matchAll(OSC8_HYPERLINK)) {
    const target = match[1]?.trim() ?? '';
    if (target.startsWith(AUTHORIZE_URL_PREFIX)) return target;
  }

  const visible = stripAnsi(raw).replace(/\n/g, '');
  const plain = /https:\/\/claude\.com\/[^\s"'<>]+/.exec(visible);

  return plain === null ? null : plain[0];
}

/** True once the CLI is blocked on `Paste code here if prompted >`. */
export function isAwaitingCode(raw: string): boolean {
  return /Paste\s+code\s+here/i.test(stripAnsi(raw));
}

/**
 * The token the CLI printed on success, or `null`.
 *
 * ## Why there is no de-wrapping fallback here, unlike for the URL
 *
 * A wrapped token has no OSC 8 hyperlink to recover it from — it is printed
 * as plain text — so the obvious rescue is to strip the newlines and match
 * again. That was written, tested, and deleted, because it is wrong in a way
 * that is worse than failing.
 *
 * The success screen prints the token and then, on the NEXT line, *"Store
 * this token securely."*. Joining lines makes the candidate
 * `sk-ant-oat01-…Y5z6Store`, which is longer than the real token, still
 * matches, and is a credential that will never authenticate. Nothing
 * downstream can tell it from a good one: it seals cleanly, History records
 * it as `set`, the readiness step flips green, and every dispatch from then
 * on fails at auth for a reason no one can see. There is no width-independent
 * rule that separates a soft wrap from a real newline after the fact.
 *
 * So the token is read from line-preserved text only. If it ever does wrap,
 * this returns `null`, the session fails as `unknown`, and the CLI's own
 * output is in the log — a visible failure instead of a silent bad
 * credential. `claude-auth.service.ts` widens the pty to 400 columns before
 * starting the CLI so that this stays hypothetical; `SETUP_TOKEN_URL_WIDE`
 * is the capture proving the widening works.
 */
export function extractOauthToken(raw: string): string | null {
  const match = OAUTH_TOKEN.exec(stripAnsi(raw));

  return match === null ? null : match[0];
}

/**
 * Why the flow did not produce a token.
 *
 * These are not severities of one failure; they are four different situations
 * with four different remedies, and #386 makes telling them apart an
 * acceptance criterion. An operator reading "authentication failed" learns
 * nothing about whether to re-copy a code, install a package, or go and buy a
 * subscription.
 */
export type ClaudeAuthFailureReason =
  /** The code was wrong, already used, or expired before it was pasted. */
  | 'invalid_code'
  /** The account cannot mint a subscription token: no plan, or on hold. */
  | 'no_subscription'
  /** `claude` is not on the API's PATH. Nothing was ever started. */
  | 'cli_missing'
  /** `script(1)` is not installed, so no pty could be allocated. */
  | 'pty_unavailable'
  /** Nobody pasted a code before the session expired. */
  | 'timed_out'
  /** An operator pressed Cancel. */
  | 'cancelled'
  /** The CLI failed in a way this code does not recognise. */
  | 'unknown';

export const CLAUDE_AUTH_FAILURE_REASONS: readonly ClaudeAuthFailureReason[] = [
  'invalid_code',
  'no_subscription',
  'cli_missing',
  'pty_unavailable',
  'timed_out',
  'cancelled',
  'unknown',
];

/**
 * Phrases the real CLI prints when the ACCOUNT is the problem.
 *
 * Every one of these was read out of the shipped `claude` 2.1.246 binary
 * rather than guessed, which is the only reason a list of vendor strings is
 * defensible at all. They are checked BEFORE the invalid-code phrases because
 * an on-hold account also produces an OAuth error, and "your subscription is
 * the problem" is the more specific and more actionable of the two.
 */
const NO_SUBSCRIPTION_PHRASES: readonly RegExp[] = [
  /account is on hold/i,
  /didn'?t grant inference access/i,
  /disabled Claude subscription access/i,
  /this policy does not permit/i,
  /requires? (?:a )?Claude subscription/i,
];

/**
 * Phrases that mean the code itself was rejected.
 *
 * `status code 400` is what the vendor's authorize endpoint answers for a
 * mistyped, reused or expired code — confirmed by pasting a deliberately
 * invalid one and capturing the result (`SETUP_TOKEN_INVALID_CODE`).
 */
const INVALID_CODE_PHRASES: readonly RegExp[] = [
  /OAuth error/i,
  /status code 400/i,
  /Invalid state parameter/i,
  /authorization code not found/i,
  /No authorization code received/i,
  /authorization was denied or failed/i,
];

/** The CLI never started: `sh` could not find it. */
const CLI_MISSING_PHRASES: readonly RegExp[] = [
  /: not found/i,
  /command not found/i,
  /No such file or directory/i,
];

/**
 * Classify a failure from the output the CLI produced AFTER the code was sent.
 *
 * The "after" is load-bearing and is the caller's responsibility to honour.
 * The CLI's own banner reads *"Claude subscription required."* on every single
 * run, including the ones that go on to succeed — classifying against the
 * whole transcript would report `no_subscription` for a perfectly good
 * account, every time. `claude-auth.service.ts` slices the buffer at the
 * offset where the code was written for exactly this reason.
 *
 * Returns `null` when nothing recognisable has appeared yet, which is how the
 * caller distinguishes "still working" from "failed in a way I can name".
 */
export function classifyFailure(
  outputAfterCode: string,
): ClaudeAuthFailureReason | null {
  const text = stripAnsi(outputAfterCode);

  if (NO_SUBSCRIPTION_PHRASES.some((phrase) => phrase.test(text))) {
    return 'no_subscription';
  }

  if (CLI_MISSING_PHRASES.some((phrase) => phrase.test(text))) {
    return 'cli_missing';
  }

  if (INVALID_CODE_PHRASES.some((phrase) => phrase.test(text))) {
    return 'invalid_code';
  }

  return null;
}

/**
 * The sentence an operator reads. One per reason, and each names a next step.
 *
 * Written here rather than at the throw site so that every path that can fail
 * — the HTTP response, the poll, the log line — says the same thing about the
 * same situation.
 */
export function describeFailure(reason: ClaudeAuthFailureReason): string {
  switch (reason) {
    case 'invalid_code':
      return (
        'The code was rejected. Authorization codes are single-use and expire ' +
        'within a few minutes, so this usually means it was already used, it ' +
        'sat too long before being pasted, or part of it was missed when ' +
        'copying. Start again and paste the whole code straight away.'
      );
    case 'no_subscription':
      return (
        'The Claude account signed in cannot issue a subscription token. ' +
        '`claude setup-token` needs an active Claude Pro, Max, Team or ' +
        'Enterprise plan — an account with no plan, one that is on hold, or ' +
        'an organisation that has turned off Claude Code access will all fail ' +
        'here after a successful sign-in. Check the plan on the account you ' +
        'authorised with, or configure an Anthropic API key instead.'
      );
    case 'cli_missing':
      return (
        'The Claude Code CLI could not be run. Check the binary named by ' +
        '`runners.claudeCodeLocal.binary` — Test CLI on this page answers the ' +
        'same question — and confirm it is installed in the API container.'
      );
    case 'pty_unavailable':
      return (
        'No pseudo-terminal could be allocated, so the CLI could not be ' +
        'started: `claude setup-token` refuses to run without one. This ' +
        'deployment is missing `script(1)` from the `util-linux` package, ' +
        'which the API image installs. Rebuild the API image.'
      );
    case 'timed_out':
      return (
        'This sign-in expired before a code was pasted. Nothing was changed. ' +
        'Start again — the authorization code the browser gives you is only ' +
        'valid for a few minutes, so keep the tab and this page side by side.'
      );
    case 'cancelled':
      return 'This sign-in was cancelled. Nothing was changed.';
    case 'unknown':
      return (
        'The Claude Code CLI ended without producing a token and without ' +
        'saying why in a way this page recognises. The API log holds the ' +
        "CLI's own output for this attempt."
      );
  }
}

/**
 * Remove anything token-shaped from text that is about to leave the process.
 *
 * The only place a token can appear is the success screen, and success does
 * not go down a failure path — so in principle this never fires. It is applied
 * anyway to every string derived from CLI output, because "in principle never"
 * is exactly the assumption that a vendor changing one screen invalidates, and
 * the cost of being wrong is a permanent credential in a log file.
 */
export function redactTokens(text: string): string {
  return text.replace(new RegExp(OAUTH_TOKEN.source, 'g'), 'sk-ant-[redacted]');
}
