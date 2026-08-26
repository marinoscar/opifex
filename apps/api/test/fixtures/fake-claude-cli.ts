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
 *
 * ## The input side is modelled too, and that is #389's whole lesson
 *
 * This fake used to read the code with `read pasted`, which accepts anything
 * ending in a newline of any length. That is why the suite was green for
 * months while the feature could not complete a single real sign-in: the real
 * CLI treats a chunk above roughly 63 bytes as PASTED TEXT rather than as
 * keystrokes, a paste carries no Enter, and so `write(code + "\r")` left a
 * 92-character code echoed at the prompt and never submitted.
 *
 * So the paste is now read by {@link pasteReader}, which reproduces that
 * rule: raw mode, chunk boundaries preserved, an unbracketed chunk longer
 * than {@link PASTE_CHUNK_THRESHOLD} is text, bracketed-paste content is
 * text whatever its length, and ONLY a carriage return arriving as a key
 * submits. Measured against `claude` 2.1.246 (#389): 56, 60 and 62
 * characters submitted; 64, 65, 80 and 92 did not.
 *
 * The one thing here that is a model rather than a measurement is the
 * handling of bracketed-paste markers — that a CLI which enabled bracketed
 * paste ends the paste at `ESC[201~` and reads what follows as keys. What WAS
 * measured is that the two-write form submits at 92 characters and the
 * one-write form does not, and that is what the regression test turns on.
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
const URL_LINE = `${ESC}]8;id=fake;${FAKE_AUTHORIZE_URL}${BEL}${FAKE_AUTHORIZE_URL}${ESC}]8;;${BEL}`;

/** The prompt the real CLI blocks on, spaced with cursor escapes. */
const PROMPT_LINE = `Paste${ESC}[8Gcode${ESC}[13Ghere${ESC}[18Gif${ESC}[21Gprompted${ESC}[30G>`;

/**
 * Above this many bytes in one chunk, input is a PASTE and not typing.
 *
 * The real boundary sits between 62 and 64 bytes, bisected against `claude`
 * 2.1.246 with a deliberately invalid code — one that is really submitted
 * answers `status code 400` within a second, so submission is observable
 * without a credential. 56, 60 and 62 submitted; 64, 65, 80 and 92 did not
 * (#389).
 */
export const PASTE_CHUNK_THRESHOLD = 63;

/**
 * A code the length of a real one: 92 characters, as the failed session had.
 *
 * The point of the number is that it is over {@link PASTE_CHUNK_THRESHOLD}.
 * Every spec that submitted `'code'` passed against a broken submit path, so
 * a spec that means to exercise the paste has to say so with its length.
 */
export const REALISTIC_AUTHORIZATION_CODE = `ac_${'A1b2C3d4E5f6G7h8'.repeat(
  6,
)}`.slice(0, 92);

/**
 * The input half of the fake: the real CLI's paste handling, in ~40 lines.
 *
 * It is a separate Node program rather than more shell because the rule it
 * models is about READ BOUNDARIES, and no `read`-based shell script can see
 * one. It puts the terminal in raw mode (as Ink does), so a chunk written by
 * `ChildProcessSupervisor.write()` arrives as a chunk instead of being
 * reassembled by the line discipline, and then:
 *
 * - bracketed-paste content (`ESC[200~ … ESC[201~`) is TEXT, any length;
 * - an unbracketed run longer than the threshold is TEXT — that is a paste;
 * - only a carriage return arriving as a key submits.
 *
 * It also prints the URL and the prompt, rather than the shell doing it,
 * which is what removes a race the spec would otherwise lose sometimes: the
 * service starts pasting the moment the URL appears, and if that were printed
 * before raw mode was on, the paste could sit in the canonical line buffer
 * and be delivered later, merged with the Enter — the exact chunking this
 * fixture exists to be honest about.
 */
function pasteReader(): string {
  return `'use strict';
// Generated by apps/api/test/fixtures/fake-claude-cli.ts. See #389.
const ESC = String.fromCharCode(27);
const PASTE_START = ESC + '[200~';
const PASTE_END = ESC + '[201~';
const THRESHOLD = ${PASTE_CHUNK_THRESHOLD};

if (!process.stdin.isTTY) {
  process.stdout.write('the input device is not a TTY\\n');
  process.exit(1);
}

process.stdin.setRawMode(true);
process.stdin.resume();

// Raw mode first, THEN the prompt: nothing may be pasted before the terminal
// is in the mode that preserves chunk boundaries.
process.stdout.write(${JSON.stringify(URL_LINE)} + '\\n');
process.stdout.write(${JSON.stringify(PROMPT_LINE)} + '\\n');

let inPaste = false;

function echo(text) {
  // What the real CLI does with a code: masks it. The failed session in #389
  // shows exactly 92 asterisks, which is how we knew it had arrived.
  if (text.length > 0) process.stdout.write('*'.repeat(text.length));
}

function submit() {
  process.stdout.write('\\n');
  process.exit(0);
}

function consume(chunk) {
  let rest = chunk;

  while (rest.length > 0) {
    if (inPaste) {
      const end = rest.indexOf(PASTE_END);
      if (end === -1) {
        echo(rest);
        return;
      }
      echo(rest.slice(0, end));
      rest = rest.slice(end + PASTE_END.length);
      inPaste = false;
      continue;
    }

    const start = rest.indexOf(PASTE_START);
    const keys = start === -1 ? rest : rest.slice(0, start);
    rest = start === -1 ? '' : rest.slice(start + PASTE_START.length);
    if (start !== -1) inPaste = true;

    // Too much at once to be typing. It is text, and text carries no Enter —
    // which is the whole of the bug this models.
    if (keys.length > THRESHOLD) {
      echo(keys);
      continue;
    }

    for (const key of keys) {
      if (key === '\\r' || key === '\\n') {
        submit();
        return;
      }
      echo(key);
    }
  }
}

process.stdin.on('data', (buffer) => consume(buffer.toString('utf8')));
`;
}

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
  | 'die-at-startup'
  /**
   * Runs, prints the banner, and never gets to a URL — but does not die.
   *
   * The startup ceiling's own case, and the one that proves it is reported as
   * `cli_no_url` rather than as an expiry: nobody has been asked for a code
   * here, so an operator's clock has nothing to do with it (#389).
   */
  | 'hang-at-startup';

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

  'hang-at-startup': '',

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
  const reader = join(dir, 'paste-reader.js');

  const body =
    behaviour === 'die-at-startup'
      ? [REQUIRE_TTY, BANNER, line('Something went wrong.'), 'exit 1'].join(
          '\n',
        )
      : behaviour === 'hang-at-startup'
        ? [REQUIRE_TTY, BANNER, 'sleep 120'].join('\n')
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
            // Prints the URL and the prompt, then reads the paste from the
            // terminal the way the real CLI reads it. This is what makes the
            // write-to-stdin path real — the service writes minutes after
            // spawn, and this is what has to still be listening — and, since
            // #389, what makes the LENGTH of the write matter, as it does
            // against the vendor's own binary. `node` by absolute path: the
            // fake runs under `sh -c` inside `script(1)`, where the PATH is
            // whatever the API container has.
            `${quote(process.execPath)} ${quote(reader)}`,
            AFTER_CODE[behaviour],
            '',
          ].join('\n');

  await writeFile(reader, pasteReader(), { mode: 0o644 });
  await writeFile(binary, body, { mode: 0o755 });

  return {
    binary,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
