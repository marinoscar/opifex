import { runCommand, describeFailure } from './run-command';
import type { ChildProcessSupervisor } from './child-process-supervisor';

/**
 * `<binary> --version`, as a fact rather than an exception (#338).
 *
 * ## Why this is its own module
 *
 * `ClaudeCodeLocalRunner.probeVersion()` already did exactly this, privately,
 * to decide whether to declare itself available. The Control Center's Test
 * buttons need the identical thing for `claude` and for `git`, and a second
 * implementation would be a second answer to "is the binary there and what
 * version is it" — the failure ADR-0011 and ADR-0013 both argue against, where
 * the fix is never "keep both in sync" but "only one of them exists". So the
 * runner keeps its caching and its availability decision and delegates the
 * spawn, the timeout and the version extraction here.
 *
 * ## Why it reports instead of throwing
 *
 * Both callers want the failure as data. The runner turns it into
 * `available: false` with a reason attached to its capability manifest; the
 * probes endpoint turns it into `{ ok: false, detail }`. Neither wants a
 * rejected promise, and a `--version` that cannot run is an ordinary fact
 * about a deployment rather than an exceptional condition.
 */

/** Long enough for a cold Node start, short enough not to hang a request. */
export const VERSION_PROBE_TIMEOUT_MS = 10_000;

export interface VersionProbeResult {
  /** True only for a clean exit 0 that produced some output. */
  readonly ok: boolean;
  /** The extracted version, present exactly when `ok`. */
  readonly version: string | null;
  /** One line fit for a log or an API response. Never contains an argv. */
  readonly detail: string;
}

export interface VersionProbeOptions {
  /** Extra environment for the child, merged over the inherited allowlist. */
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly cwd?: string;
}

/**
 * Run `<binary> --version` and report what happened.
 *
 * `binary` reaches `spawn` as `command`, with `shell: false` and an argv array
 * — see `ChildProcessSupervisor.start`. A binary path an operator typed is
 * therefore never interpreted by a shell, which is why this can take one.
 */
export async function probeBinaryVersion(
  supervisor: ChildProcessSupervisor,
  binary: string,
  options: VersionProbeOptions = {},
): Promise<VersionProbeResult> {
  if (binary.trim() === '') {
    return { ok: false, version: null, detail: 'No binary is configured.' };
  }

  const result = await runCommand(supervisor, {
    command: binary,
    args: ['--version'],
    cwd: options.cwd ?? process.cwd(),
    timeoutMs: options.timeoutMs ?? VERSION_PROBE_TIMEOUT_MS,
    ...(options.env ? { env: options.env } : {}),
  });

  if (!result.ok) {
    return {
      ok: false,
      version: null,
      detail: `${binary} --version failed: ${describeFailure(result)}`,
    };
  }

  const version = extractVersion(result.stdout);

  if (version === null) {
    // Exit 0 with nothing to read. Reported as a failure rather than as a
    // version of `''`, because a caller that stored the empty string would
    // then report a runner as available at version "" — which is worse than
    // reporting it unavailable, since it looks like a working answer.
    return {
      ok: false,
      version: null,
      detail: `${binary} --version exited 0 but printed nothing.`,
    };
  }

  return { ok: true, version, detail: `${binary} ${version}` };
}

/**
 * The leading semver out of a `--version` line, or the whole trimmed line.
 *
 * "2.1.240 (Claude Code)" — the leading semver is the part anything else can
 * compare, and keeping the parenthetical would make every version comparison a
 * string match on a marketing name. `git version 2.43.0` has its number in the
 * middle, which is why this searches rather than anchors.
 */
export function extractVersion(stdout: string): string | null {
  const match = /(\d+\.\d+\.\d+[^\s]*)/.exec(stdout);
  if (match) return match[1];

  const trimmed = stdout.trim();
  return trimmed === '' ? null : trimmed;
}
