import { randomUUID } from 'node:crypto';

import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
} from '@nestjs/common';

import {
  ChildProcessSupervisor,
  type SupervisedProcess,
} from '../../../runners/process/child-process-supervisor';
import { OperatorSettingsService } from '../operator-settings.service';
import {
  classifyFailure,
  describeFailure,
  extractAuthorizeUrl,
  extractOauthToken,
  redactTokens,
  type ClaudeAuthFailureReason,
} from './claude-cli-output';
import {
  isTerminal,
  type ClaudeAuthSession,
  type ClaudeAuthStatus,
} from './dto/claude-auth.dto';

/** The setting this whole flow exists to fill in. */
const TOKEN_KEY = 'runners.claudeCodeLocal.oauthToken' as const;

/**
 * Connect a Claude subscription from the Control Center (#386, epic #332).
 *
 * ## What this drives, and what it deliberately does not reimplement
 *
 * It runs the vendor's own `claude setup-token` and reads its screen. It does
 * not speak OAuth. The authorize URL embeds Claude Code's own `client_id` and
 * the token exchange endpoint is undocumented, so reconstructing the flow
 * would mean using another application's client credential against an endpoint
 * we have no contract with. The CLI is installed, supported, and is what "the
 * way Claude Code does it" actually means.
 *
 * ## The pty, which is the load-bearing detail
 *
 * `claude setup-token` refuses to run without a terminal — on a pipe it dies
 * with `the input device is not a TTY` before printing anything. Node has no
 * pty. So the CLI is started under `script(1)` from `util-linux`, which
 * allocates one:
 *
 *     script -qec "stty cols 400 …; claude setup-token" /dev/null
 *
 * `stty cols 400` is not cosmetic. At the default 80 columns the CLI wraps its
 * output, and while the URL survives that (Ink wraps each fragment in an OSC 8
 * hyperlink carrying the whole target, which `claude-cli-output.ts` reads),
 * the TOKEN does not — it is printed as plain text with nothing to reassemble
 * it from. Widening the pty is what keeps the success path parseable. Both
 * cases are in `claude-cli-output.fixtures.ts` as real captures.
 *
 * ## Why `ChildProcessSupervisor` rather than a bare `spawn`
 *
 * Three processes deep: `script` forks `sh`, which execs `claude`. Killing
 * only the leader would reparent the CLI to init, still holding a pty and a
 * half-finished OAuth flow, with nothing left that knows to stop it. The
 * supervisor already signals the process GROUP (`kill(-pgid)`, ADR-0006), and
 * that is exactly the property cancel, completion and timeout all need here.
 * It also applies the #334 environment allowlist on every spawn, so this child
 * cannot see `JWT_SECRET` or `POSTGRES_PASSWORD` any more than an agent can.
 *
 * ## One session at a time
 *
 * Enforced, not assumed. The flow is a human at a keyboard finishing a
 * browser round trip; two concurrent ones would mean two live `claude`
 * processes racing to write the same sealed row, and the loser's token would
 * be minted, charged against the account, and thrown away. A second `start`
 * while one is live answers 409 and names the session to cancel.
 *
 * ## The token never leaves this process
 *
 * It goes from the CLI's stdout into `OperatorSettingsService.set()` — the
 * same sealed path a manual entry takes, so `audit_events` records it as
 * `operator_settings:set` and the readiness step flips — and nowhere else.
 * No response carries it, no log line carries it, and everything derived from
 * CLI output is passed through {@link redactTokens} before it is logged.
 */
@Injectable()
export class ClaudeAuthService implements OnModuleDestroy {
  private readonly logger = new Logger(ClaudeAuthService.name);

  /** At most one, ever. See the class header. */
  private session: LiveSession | null = null;

  constructor(private readonly settings: OperatorSettingsService) {}

  // -------------------------------------------------------------------------
  // The four operations
  // -------------------------------------------------------------------------

  /**
   * Start the CLI and return the URL it prints.
   *
   * Blocks until the URL appears, the child dies, or the startup deadline
   * passes, because a `start` that returned before the URL was known would
   * leave the UI polling for the one thing it needs to render anything at all.
   * The wait is bounded by {@link startupTimeoutMs}, which is well under any
   * sane HTTP timeout.
   */
  async start(userId: string | null): Promise<ClaudeAuthSession> {
    this.expireIfDue();

    if (this.session !== null && !isTerminal(this.session.status)) {
      throw new ConflictException(
        `A Claude sign-in is already in progress (session ` +
          `${this.session.id}). Finish it or cancel it before starting ` +
          `another — two concurrent sign-ins would each mint a token and one ` +
          `would be thrown away.`,
      );
    }

    const startedAt = this.now();
    const session: LiveSession = {
      id: randomUUID(),
      userId,
      startedAt,
      expiresAt: startedAt + this.sessionTtlMs,
      status: 'awaiting_code',
      url: null,
      error: null,
      output: '',
      codeOffset: null,
      process: null,
      expiryTimer: null,
    };
    this.session = session;

    session.process = this.spawnCli(session);

    session.expiryTimer = setTimeout(() => {
      this.finish(session, 'expired', 'timed_out');
    }, this.sessionTtlMs);
    // Never a reason to keep the process up. A shutdown mid-sign-in should
    // not wait ten minutes for a timer whose only job is to kill something
    // `onModuleDestroy` is about to kill anyway.
    session.expiryTimer.unref();

    await this.awaitStartup(session);

    return this.view(session);
  }

  /** Where a session is now. */
  get(sessionId: string): ClaudeAuthSession {
    this.expireIfDue();
    return this.view(this.require(sessionId));
  }

  /**
   * Hand the pasted code to the CLI and seal whatever comes back.
   *
   * Single-use: the session leaves `awaiting_code` the moment this is
   * entered, so a second submission — a double-clicked button, a retried
   * request — is refused rather than writing a second line into a terminal
   * that is no longer asking a question. A wrong code therefore ends the
   * session; the CLI itself would offer "Press Enter to retry", but reusing a
   * session whose PKCE challenge is already spent only produces a second
   * identical failure.
   */
  async submitCode(
    sessionId: string,
    code: string,
    userId: string | null,
  ): Promise<ClaudeAuthSession> {
    this.expireIfDue();
    const session = this.require(sessionId);

    if (session.status !== 'awaiting_code') {
      throw new ConflictException(
        `This sign-in is ${session.status} and is not waiting for a code. ` +
          `Each sign-in accepts exactly one code; start a new one.`,
      );
    }

    session.status = 'exchanging';
    // Everything from here on is what the classifier is allowed to read. The
    // CLI's banner says "Claude subscription required." on every run including
    // the successful ones, so classifying the whole transcript would report a
    // missing subscription for a perfectly good account, every time.
    session.codeOffset = session.output.length;

    const sent = await this.sendCode(session, code);

    if (!sent) {
      // The child died between the URL and the paste. Its own output is the
      // better explanation than "the write failed".
      return this.view(
        this.finish(
          session,
          'failed',
          classifyFailure(this.outputAfterCode(session)) ?? 'unknown',
        ),
      );
    }

    await this.awaitExchange(session, userId);

    return this.view(session);
  }

  /** Stop, and kill the child. */
  cancel(sessionId: string): ClaudeAuthSession {
    const session = this.require(sessionId);

    if (isTerminal(session.status)) return this.view(session);

    return this.view(this.finish(session, 'cancelled', 'cancelled'));
  }

  /**
   * A shutdown must not leave a `claude` behind holding a pty.
   *
   * The process group outlives this one otherwise — `detached` is what makes
   * group signalling possible and is also what stops the child dying with its
   * parent.
   */
  onModuleDestroy(): void {
    if (this.session !== null && !isTerminal(this.session.status)) {
      this.finish(this.session, 'cancelled', 'cancelled');
    }
  }

  // -------------------------------------------------------------------------
  // The child
  // -------------------------------------------------------------------------

  private spawnCli(session: LiveSession): SupervisedProcess {
    const binary = this.settings.get('runners.claudeCodeLocal.binary');

    return this.supervisor.start({
      command: this.ptyCommand,
      // `-q` no start/stop banner, `-e` return the child's exit status,
      // `-c` the command to run, `/dev/null` the typescript file we do not
      // want. `-c` is handed to `sh -c`, which is why the binary is quoted:
      // it is operator-supplied, and a shell is the wrong place to discover
      // that a path had a space in it.
      args: ['-qec', this.ptyScript(binary), '/dev/null'],
      cwd: process.cwd(),
      keepStdinOpen: true,
      env: {
        // A terminal that supports colour and, more to the point, OSC 8
        // hyperlinks — which is where the unwrapped authorize URL lives.
        // `TERM=dumb` (what the runner and the probes use) would suppress
        // them and leave only the wrapped visible text.
        TERM: 'xterm-256color',
        COLUMNS: String(PTY_COLUMNS),
        LINES: String(PTY_ROWS),
        // Explicitly REMOVED, not merely absent. If the API process happens
        // to hold a token, the allowlist would pass it to this child (it is
        // on the #334 list, for the runner's benefit) and the CLI would open
        // on a notice about the credential already configured. This flow is
        // about minting a new one; what is already set is irrelevant to it.
        CLAUDE_CODE_OAUTH_TOKEN: undefined,
        ANTHROPIC_API_KEY: undefined,
      },
      onChunk: (chunk) => this.consume(session, chunk),
      onError: (error) =>
        this.logger.warn(
          `Claude sign-in ${session.id}: ${redactTokens(error.message)}`,
        ),
    });
  }

  /** `stty` first, so the CLI sees a wide terminal before it draws anything. */
  private ptyScript(binary: string): string {
    // `2>/dev/null` because `stty` failing is survivable — the URL is still
    // recoverable from its hyperlink — and a shell error on stderr would land
    // in the buffer the classifier reads.
    return (
      `stty cols ${PTY_COLUMNS} rows ${PTY_ROWS} 2>/dev/null; ` +
      `${shellQuote(binary)} setup-token`
    );
  }

  /**
   * Put the code at the prompt and then press Enter — two writes, never one.
   *
   * ## Why one write does not work
   *
   * The CLI's input layer treats a single chunk above roughly 63 bytes as
   * PASTED TEXT rather than as keystrokes, and a paste carries no Enter: a
   * trailing `\r` in the same chunk is absorbed into the pasted content and
   * the code sits at the prompt, echoed but unsubmitted, until the exchange
   * ceiling fires. Measured against the real `claude` 2.1.246 with a
   * deliberately invalid code, which answers `status code 400` within a
   * second when it is really submitted (#389):
   *
   * | code length      | `write(code + "\r")` submits? |
   * | ---------------- | ----------------------------- |
   * | 56, 60, 62       | yes                           |
   * | 64, 65, 80, 92   | NO                            |
   *
   * Real authorization codes are around 92 characters. That is the whole bug:
   * every test passed with a short code and every real sign-in hung.
   *
   * ## Why bracketed paste, and not just two plain writes
   *
   * `write(code)` then `write("\r")` was verified to work at 92 characters
   * too, so the split alone is sufficient. The code is wrapped in bracketed-
   * paste markers anyway because that is what a real terminal sends for a
   * paste and what this CLI explicitly asks for — `ESC[?2004h` appears in its
   * own output — and because it states the boundary in the bytes themselves
   * rather than relying on the two writes staying two chunks all the way down
   * (a Node pipe into `script(1)` into a pty is three buffers that may
   * coalesce). The intent is then legible at the call site: this is a paste,
   * and THEN a keypress.
   *
   * Do not simplify this back into one write.
   */
  private async sendCode(session: LiveSession, code: string): Promise<boolean> {
    const pasted =
      session.process?.write(`${PASTE_START}${code}${PASTE_END}`) ?? false;

    if (!pasted) return false;

    // The gap is what makes the Enter its own chunk rather than the tail of
    // the paste, and it is the arrangement the #389 probe verified against the
    // real CLI. It is a pause between two writes to a terminal, not a poll
    // interval: long enough that `script(1)` reads the paste before the Enter
    // arrives, short enough to be invisible next to the vendor round trip that
    // follows it.
    await this.sleep(this.enterKeyDelayMs);

    return session.process?.write(ENTER) ?? false;
  }

  /**
   * Everything the CLI has printed, accumulated, with the URL picked out of it.
   *
   * Bounded: a CLI stuck in a repaint loop must not turn a stalled sign-in
   * into a memory leak in the control plane, which is the same argument
   * `ChildProcessSupervisor` makes for its stderr tail. The head is what is
   * kept rather than the tail — unusually — because `codeOffset` indexes into
   * this string and a truncating front would silently slide the boundary the
   * classifier depends on. In practice the whole transcript is a few
   * kilobytes.
   */
  private consume(session: LiveSession, chunk: string): void {
    if (session.output.length >= OUTPUT_LIMIT_BYTES) return;
    session.output += chunk;

    if (session.url === null) {
      session.url = extractAuthorizeUrl(session.output);
    }
  }

  // -------------------------------------------------------------------------
  // The two waits
  // -------------------------------------------------------------------------

  /** Resolve when the URL appears, the child dies, or we run out of patience. */
  private async awaitStartup(session: LiveSession): Promise<void> {
    const settled = await this.pollUntil(this.startupTimeoutMs, () => {
      if (session.url !== null) return 'ready';

      const outcome = session.process?.result() ?? null;
      if (outcome === null) return null;

      if (outcome.kind === 'spawn-failed') {
        // `script` itself is missing — the image was built without
        // `util-linux`. Nothing ran, so there is no output to classify, and
        // the remedy (rebuild the image) has nothing to do with the CLI.
        return 'pty_unavailable';
      }

      return classifyFailure(session.output) ?? 'unknown';
    });

    if (settled === 'ready') return;

    // `cli_no_url`, not `timed_out`: nobody has been asked for a code yet, so
    // nothing about this is an operator running out of time (#389).
    this.finish(session, 'failed', settled ?? 'cli_no_url');
  }

  /** Resolve when a token appears, a failure is recognisable, or time is up. */
  private async awaitExchange(
    session: LiveSession,
    userId: string | null,
  ): Promise<void> {
    const settled = await this.pollUntil(this.exchangeTimeoutMs, () => {
      const after = this.outputAfterCode(session);

      if (extractOauthToken(after) !== null) return 'ready';

      const failure = classifyFailure(after);
      if (failure !== null) return failure;

      const outcome = session.process?.result() ?? null;
      if (outcome === null) return null;

      // Exited without a token and without saying anything this code
      // recognises. `unknown` rather than a guess; the output is logged.
      return 'unknown';
    });

    if (settled !== 'ready') {
      // The ceiling here is the CLI failing to answer a code it accepted —
      // a fault in this flow — and NOT the session's ten minutes elapsing,
      // which is `expireIfDue`'s business and keeps `timed_out`. Reporting
      // both as an expiry is what hid #389 for as long as it was hidden.
      const reason = settled ?? 'cli_no_response';
      this.logFailure(session, reason);
      this.finish(session, 'failed', reason);
      return;
    }

    const token = extractOauthToken(this.outputAfterCode(session));

    /* istanbul ignore next -- `pollUntil` only answers 'ready' when this is
       non-null; the re-read exists so the value is not smuggled out of the
       predicate. */
    if (token === null) {
      this.finish(session, 'failed', 'unknown');
      return;
    }

    try {
      // The sealed path, and the reason this endpoint exists at all: the same
      // `set()` a manual entry goes through, so the ciphertext columns, the
      // revision bump and the audit row are all identical to a hand-typed
      // rotation. The token is not returned, echoed or logged anywhere.
      await this.settings.set(TOKEN_KEY, token, userId);
    } catch (error) {
      this.logger.error(
        `Claude sign-in ${session.id} produced a token but could not store ` +
          `it: ${redactTokens(messageOf(error))}`,
      );
      this.finish(session, 'failed', 'unknown');
      return;
    }

    this.logger.log(
      `Claude sign-in ${session.id} completed; ${TOKEN_KEY} is set.`,
    );
    this.finish(session, 'completed', null);
  }

  /**
   * Poll a predicate until it answers, or the deadline passes.
   *
   * Polling rather than an event bus because there are only two watchers, both
   * short-lived, and the conditions are properties of an accumulated string
   * rather than of any single chunk — a token can complete across a chunk
   * boundary, and an edge-triggered handler would have to re-derive this
   * anyway.
   */
  private async pollUntil<T>(
    timeoutMs: number,
    check: () => T | null,
  ): Promise<T | null> {
    const deadline = this.now() + timeoutMs;

    for (;;) {
      const answer = check();
      if (answer !== null) return answer;
      if (this.now() >= deadline) return null;
      await this.sleep(this.pollIntervalMs);
    }
  }

  // -------------------------------------------------------------------------
  // State transitions
  // -------------------------------------------------------------------------

  /**
   * End a session: kill the child, stop the timer, record why.
   *
   * The single place a session becomes terminal, so "the child is killed on
   * cancel, completion AND timeout" is one line rather than three that have
   * to agree. Idempotent — cancel racing expiry is normal.
   */
  private finish(
    session: LiveSession,
    status: ClaudeAuthStatus,
    reason: ClaudeAuthFailureReason | null,
  ): LiveSession {
    if (isTerminal(session.status)) return session;

    session.status = status;
    session.error =
      reason === null ? null : { reason, message: describeFailure(reason) };
    // The URL is dropped rather than kept: it is single-use and now spent, and
    // showing a dead link invites a second doomed attempt.
    session.url = null;

    if (session.expiryTimer !== null) {
      clearTimeout(session.expiryTimer);
      session.expiryTimer = null;
    }

    // `kill()` signals the GROUP and is a no-op on an already-dead child, so
    // it is safe on the completion path as well as the cancel one.
    session.process?.kill();
    session.process = null;

    return session;
  }

  /** Expire a session whose deadline passed while nothing was watching. */
  private expireIfDue(): void {
    const session = this.session;
    if (session === null || isTerminal(session.status)) return;
    if (this.now() < session.expiresAt) return;

    this.finish(session, 'expired', 'timed_out');
  }

  private require(sessionId: string): LiveSession {
    if (this.session === null || this.session.id !== sessionId) {
      throw new NotFoundException(
        `No Claude sign-in with id ${sessionId}. Sign-ins are held in memory ` +
          `and only one exists at a time, so an API restart or a newer ` +
          `sign-in ends this one. Start again.`,
      );
    }

    return this.session;
  }

  /** Only what the CLI printed after the code went in. See {@link submitCode}. */
  private outputAfterCode(session: LiveSession): string {
    return session.codeOffset === null
      ? ''
      : session.output.slice(session.codeOffset);
  }

  private logFailure(
    session: LiveSession,
    reason: ClaudeAuthFailureReason,
  ): void {
    // Redacted, always. On this path there should be no token in the buffer —
    // failure and success are different branches — but "should be no" is the
    // assumption a vendor changing one screen invalidates, and a credential
    // in a log file is permanent.
    this.logger.warn(
      `Claude sign-in ${session.id} failed (${reason}). CLI output: ` +
        redactTokens(session.output.slice(-LOGGED_OUTPUT_BYTES)),
    );
  }

  private view(session: LiveSession): ClaudeAuthSession {
    return {
      sessionId: session.id,
      status: session.status,
      url: session.url,
      startedAt: new Date(session.startedAt).toISOString(),
      expiresAt: new Date(session.expiresAt).toISOString(),
      // Read from the resolver rather than remembered, so it reports what a
      // dispatch would actually find — including a token set by some other
      // route while this session was open.
      configured: this.settings.get(TOKEN_KEY) !== '',
      error: session.error,
    };
  }

  // -------------------------------------------------------------------------
  // Seams
  // -------------------------------------------------------------------------
  //
  // `protected` for the same reason `OperatorProbesService`'s are: a spec
  // should be a variation on this service rather than a reimplementation of
  // it. The timeouts in particular are minutes long, and a suite that waited
  // them out would be a suite nobody runs.

  protected readonly supervisor = new ChildProcessSupervisor();

  /** The pty allocator. `script(1)`, from `util-linux`. */
  protected readonly ptyCommand: string = 'script';

  /**
   * How long `start` waits for the authorize URL.
   *
   * Generous against a cold CLI start (a 240 MB binary, an npm-global
   * install), short enough to be under any reverse proxy's read timeout.
   */
  protected readonly startupTimeoutMs: number = 45_000;

  /**
   * How long the session accepts a code.
   *
   * The operator has to switch to a browser, sign in, possibly do 2FA, and
   * come back. Ten minutes covers that without leaving a `claude` process
   * parked for an afternoon.
   */
  protected readonly sessionTtlMs: number = 10 * 60_000;

  /** How long the vendor exchange gets after the code goes in. */
  protected readonly exchangeTimeoutMs: number = 90_000;

  /**
   * The pause between pasting the code and pressing Enter. See {@link sendCode}.
   *
   * 150 ms because that is what the #389 probe used against the real CLI, not
   * because anything measured a floor. It is a seam so that a spec can shorten
   * it, and so that the number has one home rather than being inlined at the
   * one place it is used.
   */
  protected readonly enterKeyDelayMs: number = 150;

  protected readonly pollIntervalMs: number = 100;

  protected now(): number {
    return Date.now();
  }

  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Wide enough that nothing the CLI prints wraps.
 *
 * 400 was chosen against the longest thing on any of its screens — the
 * authorize URL, at roughly 320 characters — with room for the token and for
 * Ink's own padding. See the class header for why wrapping is not cosmetic.
 */
const PTY_COLUMNS = 400;
const PTY_ROWS = 200;

/**
 * Bracketed paste, `ESC[200~ … ESC[201~`, and the Enter that follows it.
 *
 * Written as escapes rather than literal bytes so the source stays greppable,
 * for the same reason `claude-cli-output.ts` writes its patterns that way.
 */
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
/** Carriage return, which is what a terminal sends for the Enter key. */
const ENTER = '\r';

/** Ceiling on the accumulated transcript. A repaint loop is not a leak. */
const OUTPUT_LIMIT_BYTES = 256 * 1024;

/** How much of it a failure log carries. */
const LOGGED_OUTPUT_BYTES = 4 * 1024;

/** One session's whole state, including the parts no response ever shows. */
interface LiveSession {
  readonly id: string;
  readonly userId: string | null;
  readonly startedAt: number;
  readonly expiresAt: number;
  status: ClaudeAuthStatus;
  url: string | null;
  error: { reason: ClaudeAuthFailureReason; message: string } | null;
  /** Everything the CLI has printed, raw, escapes included. */
  output: string;
  /** Where in `output` the submitted code went in. See {@link ClaudeAuthService.submitCode}. */
  codeOffset: number | null;
  process: SupervisedProcess | null;
  expiryTimer: NodeJS.Timeout | null;
}

/**
 * POSIX single-quoting, for the one string that reaches a shell.
 *
 * `script -c` runs its argument through `sh -c`, so the configured binary path
 * is interpreted rather than exec'd directly. That is the one place in this
 * feature where quoting matters, and it is handled here rather than trusted:
 * the value is operator-supplied, and `ChildProcessSupervisor`'s own rule —
 * never `shell: true`, because quoting must not become a security boundary —
 * cannot apply to an argument that is by construction a shell command.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
