import {
  ChildProcessSupervisor,
  type SpawnRequest,
  type ProcessOutcome,
} from './child-process-supervisor';

/**
 * A short command, run to completion.
 *
 * The supervisor is built for the long-lived, cancellable, streaming case —
 * the agent itself. Git plumbing and a `--version` probe are neither, but they
 * go through the same spawn path anyway, deliberately: `shell: false` and the
 * argv-array contract are security properties, and a second `spawn` call
 * somewhere else is how a codebase ends up with one of them audited and the
 * other not.
 */
export interface CommandResult {
  outcome: ProcessOutcome;
  stdout: string;
  stderr: string;
  /** True only for a clean exit 0. */
  ok: boolean;
}

export interface CommandRequest extends Omit<SpawnRequest, 'onLine' | 'onError'> {
  /**
   * Kills the process group after this long.
   *
   * Present because these commands are awaited inline: a `git fetch` against
   * an unreachable host hangs for the TCP timeout, and without a bound that
   * hang becomes a dispatch path that never returns. A run stalling is
   * something the watchdog can see; the control plane stalling is not.
   */
  timeoutMs?: number;
}

/** Two minutes: long enough to clone a real repository, short enough to notice. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;

export async function runCommand(
  supervisor: ChildProcessSupervisor,
  request: CommandRequest,
): Promise<CommandResult> {
  const { timeoutMs, ...spawnRequest } = request;

  const stdout: string[] = [];
  const proc = supervisor.start({
    ...spawnRequest,
    onLine: (line) => stdout.push(line),
  });

  const timer = setTimeout(() => proc.kill(), timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);
  timer.unref();

  try {
    const outcome = await proc.waitForExit();
    return {
      outcome,
      stdout: stdout.join('\n'),
      stderr: proc.stderr(),
      ok: outcome.kind === 'exited' && outcome.exitCode === 0,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Why a command failed, in one line fit for a log or a `run.failed` reason.
 *
 * Prefers stderr's last line over the exit code: an operator reading
 * "fatal: couldn't find remote ref" can act, and one reading "exit 128"
 * has to go and reproduce it.
 */
export function describeFailure(result: CommandResult): string {
  const detail = result.stderr.trim().split('\n').filter(Boolean).pop();

  switch (result.outcome.kind) {
    case 'spawn-failed':
      return `could not start: ${result.outcome.error.message}`;
    case 'signalled':
      return `killed by ${result.outcome.signal}${detail ? `: ${detail}` : ''}`;
    case 'exited':
      return `exit ${result.outcome.exitCode}${detail ? `: ${detail}` : ''}`;
  }
}
