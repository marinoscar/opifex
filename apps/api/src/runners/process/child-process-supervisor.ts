import { spawn, type ChildProcess } from 'node:child_process';

/**
 * ADR 0006, made concrete.
 *
 * The ADR decides that `claude-code-local` runs as a child process rather than
 * through the Agent SDK, and gives two reasons that are both properties of
 * THIS file rather than of the runner above it:
 *
 * > A crash in the runner must not take the supervisor with it. […] A
 * > supervisor that dies alongside the run it was supervising is worse than no
 * > supervisor, because nothing is left to escalate.
 *
 * > Cancellation must not be cooperative. `kill(-pgid, SIGTERM)` is
 * > unconditional and verifiable.
 *
 * So this class owns the two mechanisms that make those true — one process
 * group per run, and signals to the group — and knows nothing about Claude
 * Code, work orders or run events. It supervises A process. That is why it
 * sits in `runners/process/` rather than in `runners/claude-code-local/`: the
 * second CLI-shaped runner reuses it with different argv, which is the
 * portability the ADR claims for the subprocess boundary.
 */

/**
 * How much stderr is kept, in bytes.
 *
 * Bounded on purpose. Unbounded capture would make a runaway child a memory
 * leak in the supervisor, which is precisely the failure ADR 0006 chose the
 * subprocess boundary to avoid — being killed by the thing you are watching.
 * The tail is what matters anyway: a process that fails prints why last.
 */
export const STDERR_TAIL_BYTES = 8 * 1024;

/**
 * How long a `SIGTERM`ed group has before `SIGKILL`.
 *
 * Long enough for a CLI to flush its output and remove a lockfile, short
 * enough that the watchdog's decision to kill a run takes effect on the tick
 * it was made rather than the next one.
 */
export const DEFAULT_KILL_GRACE_MS = 10_000;

/**
 * How long after `SIGKILL` before checking the group is really gone.
 *
 * The kernel reaps asynchronously, so checking in the same tick would report a
 * process that is already on its way out.
 */
export const KILL_VERIFY_DELAY_MS = 500;

export interface SpawnRequest {
  command: string;
  args: readonly string[];
  cwd: string;
  /** Merged over `process.env`. A key set to `undefined` is removed. */
  env?: NodeJS.ProcessEnv;
  /** Written to the child's stdin, which is then closed. */
  stdin?: string;
  /**
   * Called once per complete line of stdout, with the newline stripped.
   *
   * Line-oriented because `--output-format=stream-json` is line-delimited
   * JSON, and because a handler that receives half a line has to reimplement
   * this buffering somewhere less well tested.
   *
   * A throw here is caught and reported through `onError` rather than being
   * allowed to escape into an event handler where it becomes an unhandled
   * rejection. The supervisor's whole point is that the supervised thing
   * cannot take it down.
   */
  onLine?: (line: string) => void;
  /** Called for anything the supervisor survived but wants recorded. */
  onError?: (error: Error) => void;
  killGraceMs?: number;
}

export type ProcessOutcome =
  /** Exited on its own with a code. */
  | { kind: 'exited'; exitCode: number; signal: null }
  /** Killed by a signal — ours, or the OS's. */
  | { kind: 'signalled'; exitCode: null; signal: NodeJS.Signals }
  /** Never started: binary missing, cwd gone, not executable. */
  | { kind: 'spawn-failed'; exitCode: null; signal: null; error: Error };

/**
 * One supervised child, from spawn to exit.
 *
 * Created only by {@link ChildProcessSupervisor.start}.
 */
export class SupervisedProcess {
  /** The child's pid, which on POSIX is also its process-group id. */
  readonly pid: number | undefined;
  readonly startedAt = new Date();

  private outcome: ProcessOutcome | null = null;
  private endedAtValue: Date | null = null;
  private stdoutBuffer = '';
  private stderrTail = '';
  private killTimer: NodeJS.Timeout | null = null;
  private killRequested = false;
  private readonly exited: Promise<ProcessOutcome>;

  constructor(
    private readonly child: ChildProcess,
    private readonly request: SpawnRequest,
  ) {
    this.pid = child.pid;

    this.exited = new Promise<ProcessOutcome>((resolve) => {
      // `error` fires instead of `spawn` when the binary is missing. It is a
      // terminal outcome, not a warning: nothing was started, so nothing can
      // be polled or cancelled.
      child.once('error', (error: Error) => {
        this.settle(
          { kind: 'spawn-failed', exitCode: null, signal: null, error },
          resolve,
        );
      });

      // `close` rather than `exit`: `exit` can fire while stdout still has
      // buffered data, and a run whose last line is its result would lose it.
      child.once(
        'close',
        (code: number | null, signal: NodeJS.Signals | null) => {
          this.flushPartialLine();
          this.settle(
            signal
              ? { kind: 'signalled', exitCode: null, signal }
              : { kind: 'exited', exitCode: code ?? 0, signal: null },
            resolve,
          );
        },
      );
    });

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.consumeStdout(chunk));

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => this.consumeStderr(chunk));

    // A child whose stdin we never write to would otherwise sit waiting for
    // input that is never coming, which looks exactly like a stalled run.
    if (request.stdin !== undefined) child.stdin?.end(request.stdin);
    else child.stdin?.end();
  }

  /** True until the child has exited, failed to spawn, or been reaped. */
  isAlive(): boolean {
    return this.outcome === null;
  }

  /** The terminal outcome, or `null` while still running. */
  result(): ProcessOutcome | null {
    return this.outcome;
  }

  endedAt(): Date | null {
    return this.endedAtValue;
  }

  /** The last {@link STDERR_TAIL_BYTES} of stderr, for a failure reason. */
  stderr(): string {
    return this.stderrTail;
  }

  /** Resolves when the child has ended, however it ended. */
  waitForExit(): Promise<ProcessOutcome> {
    return this.exited;
  }

  /**
   * `SIGTERM` the process group, then `SIGKILL` it after the grace period.
   *
   * Signals the GROUP (`-pid`), not the process. #61 requires cancellation to
   * "not leave orphaned processes", and a coding agent spawns children of its
   * own — a git, a test runner, a language server. Signalling only the leader
   * reparents those to init, where nothing knows to stop them and they keep
   * spending the quota the cancel was meant to reclaim.
   *
   * Idempotent, and never throws. The seam requires that
   * (`Runner.cancel`: *"never throws for an already-stopped run"*), and so
   * does the situation: cancel is what the watchdog reaches for when a run has
   * gone wrong, so an already-dead process must be a no-op rather than an
   * error path at the worst possible moment.
   */
  kill(): void {
    if (!this.isAlive() || this.killRequested || this.pid === undefined) return;
    this.killRequested = true;

    this.signalGroup('SIGTERM');

    const grace = this.request.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    this.killTimer = setTimeout(() => {
      if (this.isAlive()) {
        this.signalGroup('SIGKILL');
        this.verifyGroupIsGone();
      }
    }, grace);
    // The escalation must not be a reason for the process to stay up. Without
    // this, a graceful shutdown waits out the grace period of every run it is
    // already killing.
    this.killTimer.unref();
  }

  /**
   * Did `SIGKILL` actually work?
   *
   * #61's criterion is that cancellation *"actually terminates work, and does
   * not leave orphaned processes"* — which is a claim that has to be checked,
   * not assumed. `SIGKILL` is uncatchable, so the only realistic way the group
   * survives is a process wedged in uninterruptible sleep (a hung NFS mount,
   * a stuck device) or a pid we no longer own.
   *
   * Rare, and worth surfacing precisely because it is rare: an operator
   * looking at a run the control plane believes is dead, while the process is
   * still holding a workspace and spending quota, has nothing else to go on.
   * Reported rather than retried — a second `SIGKILL` does nothing that the
   * first did not.
   */
  private verifyGroupIsGone(): void {
    if (this.pid === undefined) return;

    // A short delay: the kernel reaps asynchronously, and checking in the same
    // tick reports a process that is already on its way out.
    const check = setTimeout(() => {
      try {
        // Signal 0 tests existence without delivering anything.
        process.kill(-this.pid!, 0);
      } catch {
        return; // ESRCH — gone, which is what we wanted.
      }
      this.report(
        new Error(
          `Process group ${this.pid} survived SIGKILL — it may still be holding its ` +
            'workspace and spending quota',
        ),
      );
    }, KILL_VERIFY_DELAY_MS);
    check.unref();
  }

  private signalGroup(signal: NodeJS.Signals): void {
    if (this.pid === undefined) return;
    try {
      // Negative pid means "the group led by this pid". Requires the child to
      // have been spawned `detached`, which is what makes it a leader.
      //
      // Windows has no process groups and rejects a negative pid; there the
      // supervisor degrades to signalling the child alone. Opifex ships on
      // Linux (see infra/compose), so this is a developer-machine courtesy,
      // and it is called out because a silent degradation of exactly this
      // guarantee is how orphans appear.
      if (process.platform === 'win32') this.child.kill(signal);
      else process.kill(-this.pid, signal);
    } catch (error) {
      // ESRCH means it died between the check and the signal, which is the
      // outcome we wanted. Anything else is worth recording but is still not
      // worth throwing over.
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') this.report(error);
    }
  }

  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk;

    // A chunk boundary lands mid-line often enough that not handling it means
    // dropping or corrupting roughly one event per read under load. The
    // trailing fragment is kept until the rest of it arrives.
    let newline = this.stdoutBuffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, '');
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.length > 0) this.emitLine(line);
      newline = this.stdoutBuffer.indexOf('\n');
    }
  }

  /**
   * A final line with no trailing newline is still a line.
   *
   * A process that writes its result and exits immediately routinely leaves
   * one, and dropping it would lose the single most valuable event of the run.
   */
  private flushPartialLine(): void {
    const remainder = this.stdoutBuffer.trim();
    this.stdoutBuffer = '';
    if (remainder.length > 0) this.emitLine(remainder);
  }

  private emitLine(line: string): void {
    try {
      this.request.onLine?.(line);
    } catch (error) {
      this.report(error);
    }
  }

  private consumeStderr(chunk: string): void {
    this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
  }

  private settle(
    outcome: ProcessOutcome,
    resolve: (value: ProcessOutcome) => void,
  ): void {
    if (this.outcome !== null) return;
    this.outcome = outcome;
    this.endedAtValue = new Date();
    if (this.killTimer) {
      clearTimeout(this.killTimer);
      this.killTimer = null;
    }
    resolve(outcome);
  }

  private report(error: unknown): void {
    const wrapped = error instanceof Error ? error : new Error(String(error));
    try {
      this.request.onError?.(wrapped);
    } catch {
      // The error reporter itself failing is the end of the line. Swallowing
      // is the only option that keeps the supervisor alive, which is the
      // property everything else here exists to protect.
    }
  }
}

/**
 * Starts supervised children, one process group each.
 *
 * A class rather than a function so a test can substitute it, and so the
 * runner above never imports `node:child_process` directly — the runner's job
 * is the seam, not process mechanics.
 */
export class ChildProcessSupervisor {
  start(request: SpawnRequest): SupervisedProcess {
    const child = spawn(request.command, [...request.args], {
      cwd: request.cwd,
      env: { ...process.env, ...request.env },
      // The whole point. `detached` makes the child a process-group leader,
      // which is what gives `kill(-pid, …)` a group to signal. Without it,
      // cancellation reaches one process and orphans its children.
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      // Never `shell: true`. A work order's prose reaches this call, and a
      // shell would make quoting a security boundary. Arguments go to execve
      // as an array, where they cannot be reinterpreted.
      shell: false,
    });

    return new SupervisedProcess(child, request);
  }
}
