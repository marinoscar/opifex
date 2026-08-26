import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { RunEventPayload } from '../../../src/run-events/run-event.types';
import { ClaudeCodeLocalRunner } from '../../../src/runners/claude-code-local/claude-code-local.runner';
import { RunWorkspaceService } from '../../../src/runners/claude-code-local/run-workspace.service';
import {
  makeOperatorSettings,
  type FakeOperatorSettingsService,
} from '../../../src/settings/operator-settings/operator-settings.test-double';
import {
  INIT_LINE,
  RATE_LIMIT_BLOCKED_LINE,
  RESULT_SUCCESS_LINE,
  THINKING_LINE,
  TOOL_RESULT_LINE,
  TOOL_USE_LINE,
} from '../../../src/runners/claude-code-local/stream-json-fixtures';
import type {
  RunHandle,
  RunnerRunStatus,
  WorkOrderSpec,
} from '../../../src/runners/runner.types';
import type {
  RunnerConformanceConfig,
  RunnerConformanceInstance,
} from './runner-conformance-suite';

const exec = promisify(execFile);

/**
 * Drives the ONE real runner through the conformance suite (#106).
 *
 * ## Why there is only one entry here
 *
 * #106's first acceptance criterion is "both runners pass the same suite."
 * There is only one real runner. `claude-code-cloud` (#102/#103) is blocked
 * on the vendor: `claude -p --cloud <id> "..."` fails outright —
 * `Error: --cloud cannot be combined with --print. Cloud sessions are
 * interactive only.` — so there is no non-interactive surface to bind the
 * seam to. See `gh issue view 102 --comments` for the full finding; it is
 * not papered over here. `nearZeroFakeRunnerConfig` in
 * `fake-runner-fixtures.ts` stands in for the near-zero-streaming shape
 * `claude-code-cloud` would have had, which is what actually proves the
 * capability-gating requirement — a real runner that already declares
 * everything would not have exercised it.
 *
 * ## How this drives the REAL code path for free
 *
 * The operator settings registry declares the CLI binary as
 * `runners.claudeCodeLocal.binary` (`CLAUDE_CODE_BINARY`, default `claude`).
 * `ClaudeCodeLocalRunner`'s own spec
 * (`claude-code-local.runner.spec.ts`) already establishes the technique
 * this file reuses: replace the CLI with a small shell script that replays
 * canned `stream-json` lines (from `stream-json-fixtures.ts`, captured from a
 * real run) over a REAL pipe, against a REAL git remote. Everything else is
 * genuine: real process spawn (`ChildProcessSupervisor`), real supervision,
 * real stream mapping, real workspace provisioning, real cancel-by-signal.
 * That is a conformance run through the runner's actual code path, not a
 * mock of it, and — confirmed by running this file — it costs nothing and
 * needs no vendor credentials. If that had NOT worked (no git available, or
 * some other CI constraint) the honest fallback the #106 brief asks for
 * would have been Tier-1 manifest/shape checks only, gated behind an env
 * flag for the behavioural tier; that fallback was not needed.
 */

interface FixtureEnv {
  scratch: string;
  workspaceRoot: string;
  binDir: string;
  gitRemoteBaseUrl: string;
  baseCommit: string;
  repository: { owner: string; name: string };
}

async function buildEnv(): Promise<FixtureEnv> {
  const scratch = await mkdtemp(join(tmpdir(), 'opifex-runner-conformance-'));
  const workspaceRoot = join(scratch, 'workspaces');
  const binDir = join(scratch, 'bin');
  await mkdir(binDir, { recursive: true });

  const repository = { owner: 'conformance', name: 'fixture' };
  const origin = join(scratch, repository.owner, `${repository.name}.git`);
  await exec('git', ['init', '--bare', '--initial-branch=main', origin]);

  const seed = join(scratch, 'seed');
  await exec('git', ['clone', origin, seed]);
  await exec('git', ['-C', seed, 'config', 'user.email', 'seed@opifex.local']);
  await exec('git', ['-C', seed, 'config', 'user.name', 'Seed']);
  await writeFile(join(seed, 'README.md'), '# runner-conformance fixture\n');
  await exec('git', ['-C', seed, 'add', '.']);
  await exec('git', ['-C', seed, 'commit', '-m', 'base commit']);
  await exec('git', ['-C', seed, 'push', 'origin', 'main']);
  const { stdout } = await exec('git', ['-C', seed, 'rev-parse', 'HEAD']);

  return {
    scratch,
    workspaceRoot,
    binDir,
    gitRemoteBaseUrl: `file://${scratch}`,
    baseCommit: stdout.trim(),
    repository,
  };
}

let envPromise: Promise<FixtureEnv> | null = null;

function getEnv(): Promise<FixtureEnv> {
  envPromise ??= buildEnv();
  return envPromise;
}

async function disposeEnv(): Promise<void> {
  if (!envPromise) return;
  const env = await envPromise;
  envPromise = null;
  await rm(env.scratch, { recursive: true, force: true });
}

/**
 * A stand-in for `claude`. Shell-quoted the same way `claude-code-local.
 * runner.spec.ts`'s own `fakeClaude` helper does, and — crucially — draining
 * stdin first exactly as that helper's `cat > "$name.stdin"` line does. The
 * real CLI always reads the prompt from stdin; a fixture that does not would
 * exit (and close its end of the pipe) before
 * `ChildProcessSupervisor`'s constructor finishes writing the prompt to it,
 * which raises an uncaught `EPIPE` on `child.stdin` — a real, if unlikely,
 * gap in that supervisor (no `error` listener on the stdin stream), left
 * unpatched here since `apps/api/src/` is out of scope for this suite and is
 * reported separately rather than fixed silently.
 */
async function writeFakeClaude(env: FixtureEnv, body: string): Promise<string> {
  const path = join(env.binDir, `claude-${randomUUID()}`);
  await writeFile(path, ['#!/bin/sh', 'cat >/dev/null', body, ''].join('\n'), {
    mode: 0o755,
  });
  return path;
}

/** Serializes each fixture line and shell-quotes it, matching the CLI's real stdout framing. */
function emitLines(objects: unknown[]): string {
  return objects
    .map((object) => `printf '%s\\n' ${JSON.stringify(JSON.stringify(object))}`)
    .join('\n');
}

/**
 * Init, a rate-limit block (with a reset time), thinking, a tool call, its
 * result, and a costed success — the shapes captured from CLI 2.1.240. One
 * scenario exercises every tier-2 assertion this runner's manifest claims.
 */
const HAPPY_PATH_LINES = [
  INIT_LINE,
  RATE_LIMIT_BLOCKED_LINE,
  THINKING_LINE,
  TOOL_USE_LINE,
  TOOL_RESULT_LINE,
  RESULT_SUCCESS_LINE,
];

function buildRunner(
  settings: FakeOperatorSettingsService,
): ClaudeCodeLocalRunner {
  return new ClaudeCodeLocalRunner(settings, new RunWorkspaceService(settings));
}

async function until(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) {
      throw new Error('runner-conformance: timed out waiting for a condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function drainUntilTerminal(
  runner: ClaudeCodeLocalRunner,
  handle: RunHandle,
): Promise<{ status: RunnerRunStatus; events: RunEventPayload[] }> {
  const events: RunEventPayload[] = [];
  let status: RunnerRunStatus = 'running';

  await until(async () => {
    const result = await runner.poll(handle);
    events.push(...result.events);
    status = result.status;
    return status !== 'running';
  });
  // The terminal event is queued by the exit handler, which can land after
  // the status itself has already flipped — one more drain catches it.
  await until(async () => {
    const result = await runner.poll(handle);
    events.push(...result.events);
    return events.some(
      (event) => event.type === 'run.completed' || event.type === 'run.failed',
    );
  });

  return { status, events };
}

async function createRealRunnerInstance(): Promise<RunnerConformanceInstance> {
  const env = await getEnv();

  // A default binary that answers `--version` (so `capabilities()` — which
  // probes it — reports a non-empty version) and otherwise just exits. Used
  // by any check that calls `submit` or `capabilities` directly, without
  // going through `runToCompletion`/`cancelMidRun` below, which each swap in
  // a scenario-specific binary before submitting.
  const defaultBinary = await writeFakeClaude(
    env,
    [
      'if [ "$1" = "--version" ]; then',
      '  echo "0.0.0-conformance-fixture"',
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n'),
  );

  const settings = makeOperatorSettings({
    overrides: {
      'runners.claudeCodeLocal.binary': defaultBinary,
      'runners.claudeCodeLocal.workspaceRoot': env.workspaceRoot,
      'runners.claudeCodeLocal.gitBinary': 'git',
      'runners.claudeCodeLocal.gitRemoteBaseUrl': env.gitRemoteBaseUrl,
      'runners.claudeCodeLocal.committerName': 'Opifex Factory',
      'runners.claudeCodeLocal.committerEmail': 'factory@opifex.local',
      'runners.claudeCodeLocal.maxConcurrency': 8,
      'runners.claudeCodeLocal.killGraceMs': 250,
      'runners.claudeCodeLocal.permissionMode': 'acceptEdits',
      // Empty, not absent: empty IS the registry's default, and it is how
      // "no credential" reaches the git layer.
      'github.token': '',
    },
  });
  const runner = buildRunner(settings);

  const workOrder = (
    overrides: Partial<WorkOrderSpec> = {},
  ): WorkOrderSpec => ({
    identity: `wo_conformance_real_${randomUUID().replace(/-/g, '')}_a1`,
    runId: randomUUID(),
    repository: env.repository,
    baseCommit: env.baseCommit,
    branch: `factory/conformance-${randomUUID().slice(0, 8)}`,
    taskSpec: 'Cross-runner conformance probe (#106) — no real work is done.',
    acceptanceCriteria: ['n/a — conformance probe'],
    pathConstraints: [],
    budgetCeilingUsd: null,
    wallClockTimeoutMinutes: null,
    needs: [],
    ...overrides,
  });

  return {
    runner,
    workOrder,
    async runToCompletion(order) {
      settings.setOverride(
        'runners.claudeCodeLocal.binary',
        await writeFakeClaude(env, `${emitLines(HAPPY_PATH_LINES)}\nexit 0`),
      );
      const handle = await runner.submit(order);
      const { status, events } = await drainUntilTerminal(runner, handle);
      return { handle, status, events };
    },
    async cancelMidRun(order) {
      settings.setOverride(
        'runners.claudeCodeLocal.binary',
        await writeFakeClaude(env, 'sleep 30'),
      );
      const handle = await runner.submit(order);
      await runner.cancel(handle);
      const { status, events } = await drainUntilTerminal(runner, handle);
      return { handle, status, events };
    },
    async dispose() {
      await runner.onModuleDestroy();
    },
  };
}

/**
 * The real runner, driven through its actual seam.
 *
 * `expectedCapabilities` mirrors what `ClaudeCodeLocalRunner.capabilities()`
 * hard-codes today (`streamingFidelity: 'full'`, `rateLimitSignal:
 * 'structured'`, `reportsCost: true`) — `capabilities-match-declared-
 * expectation` (tier 1) is what catches the two drifting apart.
 */
export function realClaudeCodeLocalRunnerConfig(): RunnerConformanceConfig {
  return {
    label:
      'ClaudeCodeLocalRunner (real process spawn, real git, fixture stream-json binary)',
    expectedCapabilities: {
      streamingFidelity: 'full',
      rateLimitSignal: 'structured',
      reportsCost: true,
    },
    testTimeoutMs: 30_000,
    createInstance: createRealRunnerInstance,
    disposeAll: disposeEnv,
  };
}
