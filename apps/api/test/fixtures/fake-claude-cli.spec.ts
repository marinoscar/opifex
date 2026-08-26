import {
  ChildProcessSupervisor,
  type SupervisedProcess,
} from '../../src/runners/process/child-process-supervisor';
import { shellQuote } from '../../src/settings/operator-settings/claude-auth/claude-auth.service';
import { stripAnsi } from '../../src/settings/operator-settings/claude-auth/claude-cli-output';
import {
  PASTE_CHUNK_THRESHOLD,
  REALISTIC_AUTHORIZATION_CODE,
  makeFakeClaudeCli,
} from './fake-claude-cli';

/**
 * The fake's own contract: it must be as hard to submit to as the real CLI.
 *
 * This spec exists because of #389. `ClaudeAuthService` sent the code and its
 * Enter in one write for as long as the feature existed, the whole suite was
 * green, and no real sign-in ever completed — because the fake read the code
 * with a shell `read`, which accepts a line of any length, while the vendor's
 * binary treats a chunk above ~63 bytes as PASTED TEXT and a paste carries no
 * Enter.
 *
 * `claude-auth.service.spec.ts` now submits a 92-character code and asserts it
 * completes. That assertion is only worth something if the fake would refuse
 * the old one-write form, and this is where THAT is pinned: raise the
 * fixture's threshold and these fail, rather than the regression test quietly
 * going vacuous.
 *
 * It drives the fake directly — real `script(1)`, real pty, real
 * `ChildProcessSupervisor.write()`, no service — because the claim is about
 * what a write of a given size does to a terminal, and the service is not
 * part of it.
 */

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/** Long enough to be a paste, and the length of the code that failed live. */
const LONG_CODE = REALISTIC_AUTHORIZATION_CODE;

/** Short enough that the real CLI accepted it as typing. 62 submitted. */
const SHORT_CODE = 'a'.repeat(40);

describe('the fake claude CLI reproduces the paste threshold (#389)', () => {
  jest.setTimeout(60_000);

  const cleanups: Array<() => Promise<void>> = [];
  let proc: SupervisedProcess | null = null;
  let output = '';

  afterEach(async () => {
    proc?.kill();
    proc = null;
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  /** Start the fake under a real pty and wait for its prompt. */
  async function start(): Promise<SupervisedProcess> {
    const cli = await makeFakeClaudeCli('success');
    cleanups.push(cli.cleanup);
    output = '';

    proc = new ChildProcessSupervisor().start({
      command: 'script',
      args: [
        '-qec',
        `stty cols 400 rows 200 2>/dev/null; ${shellQuote(cli.binary)} setup-token`,
        '/dev/null',
      ],
      cwd: process.cwd(),
      keepStdinOpen: true,
      env: { TERM: 'xterm-256color' },
      onChunk: (chunk) => {
        output += chunk;
      },
    });

    await waitFor(() => /Paste code here/i.test(stripAnsi(output)));

    return proc;
  }

  /** The success screen: the one thing that only appears after a submit. */
  function submitted(): boolean {
    return /Authentication token created/i.test(stripAnsi(output));
  }

  async function waitFor(
    predicate: () => boolean,
    timeoutMs = 15_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting; transcript:\n${stripAnsi(output)}`);
      }
      await sleep(25);
    }
  }

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

  it('leaves a real-length code sitting at the prompt when the Enter rides along', async () => {
    // Verbatim what `claude-auth.service.ts` used to do:
    // `write(`${code}\r`)`. The code arrives — it is echoed, exactly as the
    // 92 asterisks in the #389 transcript show — and nothing happens.
    const child = await start();
    expect(LONG_CODE.length).toBeGreaterThan(PASTE_CHUNK_THRESHOLD);

    child.write(`${LONG_CODE}\r`);
    await waitFor(() => stripAnsi(output).includes('*'.repeat(20)));
    await sleep(1_000);

    expect(submitted()).toBe(false);
  });

  it('accepts the same code once the Enter is a chunk of its own', async () => {
    // The plain form of the fix, and the one the #389 probe measured against
    // the real CLI at this exact length.
    const child = await start();

    child.write(LONG_CODE);
    await sleep(150);
    child.write('\r');

    await waitFor(submitted);
  });

  it('accepts it as a bracketed paste followed by an Enter', async () => {
    // What the service actually sends. The markers state where the paste
    // ends, so the Enter is a keypress even if the two writes are coalesced.
    const child = await start();

    child.write(`${PASTE_START}${LONG_CODE}${PASTE_END}`);
    await sleep(150);
    child.write('\r');

    await waitFor(submitted);
  });

  it('is a threshold and not a blanket refusal', async () => {
    // A short code in one chunk WITH its Enter still submits — that is why
    // every existing spec passed against a broken submit path, and why this
    // fixture models a boundary rather than simply never accepting anything.
    const child = await start();
    expect(SHORT_CODE.length).toBeLessThan(PASTE_CHUNK_THRESHOLD);

    child.write(`${SHORT_CODE}\r`);

    await waitFor(submitted);
  });
});
