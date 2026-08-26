import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A stand-in for `claude setup-token`, for the #386 specs.
 *
 * ## Why a real script under a real `script(1)` and not a mocked spawn
 *
 * The same argument `test/runners/conformance/claude-code-local-fixture.ts`
 * makes for the runner: every property worth asserting here belongs to the
 * operating system rather than to our code. That the CLI gets a TTY, that the
 * process GROUP dies on cancel, that a write to stdin minutes after spawn
 * still reaches the child — a mocked `spawn` would assert that we call it with
 * the arguments we believe are correct, which is the belief in question.
 *
 * So these specs run the real `script -qec … /dev/null`, the real
 * `ChildProcessSupervisor`, a real pty and a real process group. Only the
 * vendor binary is fake, because completing an OAuth flow needs a human's own
 * Claude account and is not ours to automate.
 *
 * ## The scripts assert their own preconditions
 *
 * Every variant starts by checking `[ -t 0 ]`. If the pty were not allocated
 * the fake would print the real CLI's own refusal — `the input device is not a
 * TTY` — and the spec would fail on the thing that actually matters, rather
 * than passing because a fake that does not care about terminals ran fine
 * without one.
 *
 * ## The escape sequences are copied from the real capture
 *
 * The URL is emitted inside an OSC 8 hyperlink and the prose is spaced with
 * cursor-column escapes, exactly as `claude` 2.1.246 does it (see
 * `src/settings/operator-settings/claude-auth/claude-cli-output.fixtures.ts`).
 * A fake that printed a clean URL followed by a clean sentence would let a
 * parser that cannot read the real thing pass.
 */

const ESC = '\x1b';
const BEL = '\x07';

/** The authorize URL the fakes print. Same shape as the vendor's. */
export const FAKE_AUTHORIZE_URL =
  'https://claude.com/cai/oauth/authorize?code=true&client_id=' +
  '9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=' +
  'https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=' +
  'user%3Ainference&code_challenge=fakeChallengefakeChallengefakeChalleng' +
  '&code_challenge_method=S256&state=fakeStatefakeStatefakeStatefakeState';

/**
 * The token the success fake prints. Not a credential; never was one.
 *
 * Kept short on purpose: long enough to clear the extractor's 24-character
 * floor, short enough that the repository's pre-commit secret scanner does not
 * see a 40-character `sk-` run in the diff and refuse the commit.
 */
export const FAKE_OAUTH_TOKEN = 'sk-ant-oat01-FaKeToKeNbOdY1234567';

/**
 * `printf '%s\n' '<literal>'`, never `printf '<literal>'`.
 *
 * The authorize URL is full of percent-encoding — `%3A%2F%2F` — and `printf`
 * reads `%2F` as a format specifier. Passing the text as an ARGUMENT rather
 * than as the format string is what keeps it intact, and the pty's own ONLCR
 * turns the `\n` into the `\r\n` a terminal actually carries.
 */
function line(text: string): string {
  return `printf '%s\\n' ${quote(text)}`;
}

/** POSIX single-quoting, for text going into a generated shell script. */
function quote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/** The banner every variant prints, escapes and all, before anything else. */
const BANNER = [
  line(`Welcome${ESC}[9Gto${ESC}[12GClaude${ESC}[19GCode${ESC}[24Gv2.1.246`),
  // The trap this suite exists to keep catching: the banner claims a
  // subscription is required on EVERY run, successful ones included.
  line(
    `This${ESC}[7Gwill${ESC}[12Gguide${ESC}[18Gyou${ESC}[22Gthrough${ESC}[30Glong-lived${ESC}[41G(1-year)${ESC}[50Gauth${ESC}[55Gtoken${ESC}[61Gsetup.${ESC}[68GClaude${ESC}[75Gsubscription${ESC}[88Grequired.`,
  ),
].join('\n');

/** The URL, inside an OSC 8 hyperlink, as Ink emits it. */
const PRINT_URL = line(
  `${ESC}]8;id=fake;${FAKE_AUTHORIZE_URL}${BEL}${FAKE_AUTHORIZE_URL}${ESC}]8;;${BEL}`,
);

/** The prompt the real CLI blocks on, spaced with cursor escapes. */
const PRINT_PROMPT = line(
  `Paste${ESC}[8Gcode${ESC}[13Ghere${ESC}[18Gif${ESC}[21Gprompted${ESC}[30G>`,
);

const REQUIRE_TTY = [
  '#!/bin/sh',
  '# The real CLI refuses without a terminal. So does this, so that a spec',
  '# cannot pass on a pipe.',
  'if [ ! -t 0 ]; then',
  '  echo "the input device is not a TTY"',
  '  exit 1',
  'fi',
].join('\n');

/** What the fake does once a code arrives. */
export type FakeClaudeBehaviour =
  /** Prints the success screen and the token, then lingers on it. */
  | 'success'
  /** The real CLI's rejected-code screen: an OAuth error, then a retry offer. */
  | 'invalid-code'
  /** Sign-in worked; the account cannot mint a token. */
  | 'account-on-hold'
  /** Reads the code and then says nothing at all, forever. */
  | 'hang-after-code'
  /**
   * Prints a failure-shaped line BEFORE the URL, recovers, then hangs.
   *
   * The CLI retries transient authorize failures, so an `OAuth error` line
   * that the run goes on to survive is a real shape. It is here to prove the
   * service classifies only what came after the code: without that, this
   * would be reported as a rejected code the operator never had a chance to
   * get wrong.
   */
  | 'noisy-startup'
  /** Never gets as far as printing a URL. */
  | 'die-at-startup';

const AFTER_CODE: Record<FakeClaudeBehaviour, string> = {
  success: [
    line(
      `Authentication${ESC}[15Gtoken${ESC}[21Gcreated${ESC}[29Gsuccessfully!`,
    ),
    line(
      `Your${ESC}[7GOAuth${ESC}[13Gtoken${ESC}[19G(valid${ESC}[26Gfor${ESC}[30G1${ESC}[32Gyear)`,
    ),
    line(FAKE_OAUTH_TOKEN),
    // Immediately after the token, as the real one does — the line that makes
    // a newline-stripping token extractor produce a corrupt credential.
    line(`Store${ESC}[8Gthis${ESC}[13Gtoken${ESC}[19Gsecurely.`),
    // And then it LINGERS on the success screen rather than exiting, which is
    // what makes the service's kill-on-completion load-bearing: with an
    // `exit 0` here every completion test would pass whether or not anything
    // reaped the child, and a stranded `claude` holding a pty is the leak
    // #386 names.
    'sleep 30',
  ].join('\n'),

  'invalid-code': [
    // Wording taken from the real capture, including the CLI's habit of
    // overwriting part of its own word with a cursor jump.
    line(
      `OAuth error: Requ${ESC}[20Gst${ESC}[23Gfailed with${ESC}[35Gstatus code 400`,
    ),
    line(' Press Enter to retry.'),
    // And then it KEEPS RUNNING, which is why the service cannot wait for an
    // exit code to decide a code was rejected.
    'sleep 30',
  ].join('\n'),

  'account-on-hold': [
    line('OAuth error: Request failed with status code 400'),
    line(
      "Your account is on hold and can't use Claude Code. View details or " +
        'appeal: https://claude.ai/restricted',
    ),
    'exit 1',
  ].join('\n'),

  'hang-after-code': 'sleep 120',

  'noisy-startup': 'sleep 120',

  'die-at-startup': '',
};

export interface FakeClaudeCli {
  /** Absolute path to hand to `runners.claudeCodeLocal.binary`. */
  readonly binary: string;
  /** Remove the scratch directory. */
  cleanup: () => Promise<void>;
}

/**
 * Write a fake `claude` to a temporary directory and return its path.
 *
 * A path rather than a PATH entry, because the setting under test
 * (`runners.claudeCodeLocal.binary`) is a command name or a path, and using an
 * absolute path means the spec does not depend on mutating the environment of
 * the process running it.
 */
export async function makeFakeClaudeCli(
  behaviour: FakeClaudeBehaviour,
): Promise<FakeClaudeCli> {
  const dir = await mkdtemp(join(tmpdir(), 'opifex-fake-claude-'));
  const binary = join(dir, `claude-${randomUUID()}`);

  const body =
    behaviour === 'die-at-startup'
      ? [REQUIRE_TTY, BANNER, line('Something went wrong.'), 'exit 1'].join(
          '\n',
        )
      : [
          REQUIRE_TTY,
          BANNER,
          ...(behaviour === 'noisy-startup'
            ? [
                line(
                  'OAuth error: Request failed with status code 400 (retrying)',
                ),
              ]
            : []),
          PRINT_URL,
          PRINT_PROMPT,
          // `read` from the terminal, which is what makes the write-to-stdin
          // path real: the service writes minutes after spawn, and this line
          // is what has to still be listening.
          'read pasted',
          AFTER_CODE[behaviour],
          '',
        ].join('\n');

  await writeFile(binary, body, { mode: 0o755 });

  return {
    binary,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
