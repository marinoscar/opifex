import { ConfigService } from '@nestjs/config';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  explainErrors,
  validatorFor,
} from '../../../test/schemas/contract-validators';
import { RUNNER_SEAM_METHODS, type RunHandle, type WorkOrderSpec } from '../runner.types';
import {
  ClaudeCodeLocalRunner,
  FINISHED_RUN_RETENTION_MS,
  RunnerAtCapacityError,
} from './claude-code-local.runner';
import { RunWorkspaceService } from './run-workspace.service';

const exec = promisify(execFile);

/**
 * A real process, a fake agent.
 *
 * The CLI is replaced by a shell script, and everything else is real: real
 * git, a real repository, a real spawn, a real process group, a real kill.
 * That split is deliberate — running the actual `claude` would cost money and
 * need credentials, but mocking the SPAWN would delete the only part of this
 * runner that can genuinely fail. ADR 0006 chose the subprocess boundary for
 * properties of the operating system, and a test that never crosses that
 * boundary asserts none of them.
 *
 * The fake records its argv, its stdin and its cwd, so the invocation itself
 * is checkable — a flag that does not reach the child is a flag that is not
 * doing anything.
 */
describe('ClaudeCodeLocalRunner', () => {
  let scratch: string;
  let workspaceRoot: string;
  let baseCommit: string;
  let binDir: string;

  async function git(cwd: string, ...args: string[]): Promise<string> {
    const { stdout } = await exec('git', args, { cwd });
    return stdout.trim();
  }

  /**
   * A stand-in for `claude`, scripted per test.
   *
   * Writes its argv, cwd and stdin next to itself so the invocation can be
   * asserted, then runs whatever body the test asked for.
   */
  async function fakeClaude(name: string, body: string, mode = 0o755): Promise<string> {
    const path = join(binDir, name);
    await writeFile(
      path,
      [
        '#!/bin/sh',
        `printf '%s\\n' "$@" > "${binDir}/${name}.argv"`,
        `pwd > "${binDir}/${name}.cwd"`,
        `cat > "${binDir}/${name}.stdin"`,
        body,
        '',
      ].join('\n'),
      { mode },
    );
    return path;
  }

  function build(overrides: Record<string, unknown> = {}): ClaudeCodeLocalRunner {
    const values: Record<string, unknown> = {
      'runners.claudeCodeLocal.workspaceRoot': workspaceRoot,
      'runners.claudeCodeLocal.gitBinary': 'git',
      'runners.claudeCodeLocal.gitRemoteBaseUrl': `file://${scratch}`,
      'runners.claudeCodeLocal.committerName': 'Opifex Factory',
      'runners.claudeCodeLocal.committerEmail': 'factory@opifex.local',
      'runners.claudeCodeLocal.maxConcurrency': 2,
      'runners.claudeCodeLocal.killGraceMs': 250,
      'runners.claudeCodeLocal.permissionMode': 'acceptEdits',
      'github.token': undefined,
      ...overrides,
    };
    const config = { get: (key: string) => values[key] } as unknown as ConfigService;
    return new ClaudeCodeLocalRunner(config, new RunWorkspaceService(config));
  }

  const workOrder = (overrides: Partial<WorkOrderSpec> = {}): WorkOrderSpec => ({
    identity: 'wo_acme-widgets_42_abc1234_a1',
    runId: '3f1d9d3e-6b1a-4f8e-9c2a-8b5a4f0c1d22',
    repository: { owner: 'acme', name: 'widgets' },
    baseCommit,
    branch: 'factory/42-abc1234-a1',
    taskSpec: 'Add a health endpoint that reports the build sha.',
    acceptanceCriteria: [
      'GET /health returns 200 with the build sha in the body',
      'A unit test covers the endpoint',
    ],
    pathConstraints: [],
    budgetCeilingUsd: null,
    wallClockTimeoutMinutes: null,
    needs: [],
    ...overrides,
  });

  /** Polls rather than sleeping: keeps the suite fast and deterministic. */
  async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error('timed out waiting for condition');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  /** Waits for a run to reach a terminal status and returns everything polled. */
  async function drainUntilTerminal(runner: ClaudeCodeLocalRunner, handle: RunHandle) {
    const events: Awaited<ReturnType<ClaudeCodeLocalRunner['poll']>>['events'] = [];
    let status = 'running';
    await until(async () => {
      const result = await runner.poll(handle);
      events.push(...result.events);
      status = result.status;
      return status !== 'running';
    });
    // One more poll: the terminal event is queued by the exit handler, which
    // can land after the status flips.
    await until(async () => {
      const result = await runner.poll(handle);
      events.push(...result.events);
      return events.some((event) => event.type === 'run.completed' || event.type === 'run.failed');
    });
    return { status, events };
  }

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'opifex-runner-'));
    workspaceRoot = join(scratch, 'workspaces');
    binDir = join(scratch, 'bin');
    await exec('mkdir', ['-p', binDir]);

    const origin = join(scratch, 'acme', 'widgets.git');
    await exec('git', ['init', '--bare', '--initial-branch=main', origin]);

    const seed = join(scratch, 'seed');
    await exec('git', ['clone', origin, seed]);
    await git(seed, 'config', 'user.email', 'seed@opifex.local');
    await git(seed, 'config', 'user.name', 'Seed');
    await writeFile(join(seed, 'README.md'), '# base\n');
    await git(seed, 'add', '.');
    await git(seed, 'commit', '-m', 'base commit');
    await git(seed, 'push', 'origin', 'main');
    baseCommit = await git(seed, 'rev-parse', 'HEAD');
  }, 60_000);

  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------

  describe('the seam', () => {
    it('implements exactly the four functions and nothing else', () => {
      // #60's first acceptance criterion — "exactly four functions; adding a
      // fifth requires an ADR" — is only enforceable if something checks.
      //
      // TypeScript's `private` is a compile-time fiction, so the helpers are
      // still on the prototype at runtime and have to be named here, as
      // `runner.seam.spec.ts` does for the double's steering methods. That
      // naming is the point: a fifth SEAM function fails this test until
      // someone deliberately adds it to one list or the other, which is a
      // reviewable act rather than an accident.
      const INTERNALS = [
        'armDeadline',
        'reapFinishedRuns',
        'consumeLine',
        'runnerTag',
        'statusOf',
        'settle',
        'costOf',
        'completionSummary',
        'failureReason',
        'event',
        'liveRunCount',
        'probeVersion',
      ];

      // Listed apart from the internals on purpose. `onModuleDestroy` is a
      // NestJS lifecycle hook, not a fifth seam function — nothing routes
      // through it and no caller of `Runner` can see it. Naming it separately
      // keeps that distinction visible rather than burying a public method in
      // a list called INTERNALS.
      const LIFECYCLE = ['onModuleDestroy'];

      const implemented = Object.getOwnPropertyNames(ClaudeCodeLocalRunner.prototype)
        .filter(
          (name) =>
            name !== 'constructor' &&
            typeof Object.getOwnPropertyDescriptor(ClaudeCodeLocalRunner.prototype, name)?.value ===
              'function',
        )
        .filter((name) => !INTERNALS.includes(name) && !LIFECYCLE.includes(name));

      expect(implemented.sort()).toEqual([...RUNNER_SEAM_METHODS].sort());
    });

    it('never names itself in the work order it accepts', () => {
      // VISION §6: "work orders never name a runner." A field appearing here
      // would let a work order pin its own executor, which is most of what
      // the seam is for.
      expect(Object.keys(workOrder())).not.toContain('runner');
      expect(Object.keys(workOrder())).not.toContain('runnerKey');
    });
  });

  describe('submit', () => {
    it('spawns the CLI in a workspace checked out at the base commit', async () => {
      const binary = await fakeClaude('happy', 'exit 0');
      const runner = build({ 'runners.claudeCodeLocal.binary': binary });

      const handle = await runner.submit(workOrder());
      await drainUntilTerminal(runner, handle);

      const cwd = (await readFile(`${binary}.cwd`, 'utf8')).trim();
      expect(cwd).toContain('wo_acme-widgets_42_abc1234_a1');
      expect(await git(cwd, 'rev-parse', 'HEAD')).toBe(baseCommit);
      expect(await git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('factory/42-abc1234-a1');
    }, 30_000);

    it('passes the flags that make the output stream exist at all', async () => {
      // --print for non-interactive, stream-json for line-delimited output,
      // --verbose for per-tool detail. Asserted against the child's real argv
      // rather than against the builder: a flag that does not reach the
      // process is a flag that is not doing anything.
      const binary = await fakeClaude('flags', 'exit 0');
      const runner = build({ 'runners.claudeCodeLocal.binary': binary });

      const order = workOrder();
      const handle = await runner.submit(order);
      await drainUntilTerminal(runner, handle);

      const argv = (await readFile(`${binary}.argv`, 'utf8')).trim().split('\n');
      expect(argv).toContain('--print');
      expect(argv).toContain('--verbose');
      expect(argv[argv.indexOf('--output-format') + 1]).toBe('stream-json');
      expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
      // The CLI's session id IS our run id, so an operator holding one can
      // find the other without a lookup table.
      expect(argv[argv.indexOf('--session-id') + 1]).toBe(order.runId);
    }, 30_000);

    it('sends the prompt on stdin, never in argv', async () => {
      // argv is world-readable through `ps`, and a task spec is unbounded
      // prose from an issue.
      const binary = await fakeClaude('prompt', 'exit 0');
      const runner = build({ 'runners.claudeCodeLocal.binary': binary });

      const handle = await runner.submit(workOrder());
      await drainUntilTerminal(runner, handle);

      const stdin = await readFile(`${binary}.stdin`, 'utf8');
      const argv = await readFile(`${binary}.argv`, 'utf8');

      expect(stdin).toContain('Add a health endpoint that reports the build sha.');
      expect(stdin).toContain('1. GET /health returns 200 with the build sha in the body');
      expect(stdin).toContain('factory/42-abc1234-a1');
      expect(argv).not.toContain('Add a health endpoint');
    }, 30_000);

    it('is idempotent on identity — a re-submit returns the running handle', async () => {
      // #18: two agents on one branch is not a slow path, it is a corrupted
      // one — they would race each other's commits.
      const binary = await fakeClaude('idem', 'sleep 5');
      const runner = build({ 'runners.claudeCodeLocal.binary': binary });

      const first = await runner.submit(workOrder());
      const second = await runner.submit(workOrder());

      expect(second).toEqual(first);
      await runner.cancel(first);
    }, 30_000);

    it('refuses to exceed its own declared concurrency ceiling', async () => {
      // VISION §11: automated runs compete with a human for one subscription
      // quota. A runner that quietly exceeded its stated ceiling would make
      // every dispatch decision above it wrong.
      const binary = await fakeClaude('busy', 'sleep 5');
      const runner = build({
        'runners.claudeCodeLocal.binary': binary,
        'runners.claudeCodeLocal.maxConcurrency': 1,
      });

      const first = await runner.submit(workOrder());
      await expect(
        runner.submit(workOrder({ identity: 'wo_acme-widgets_43_abc1234_a1' })),
      ).rejects.toThrow(RunnerAtCapacityError);

      await runner.cancel(first);
    }, 30_000);

    it('reports a started event before anything has been polled', async () => {
      const binary = await fakeClaude('started', 'exit 0');
      const runner = build({ 'runners.claudeCodeLocal.binary': binary });

      const handle = await runner.submit(workOrder());
      const first = await runner.poll(handle);

      expect(first.events).toHaveLength(1);
      expect(first.events[0]).toMatchObject({
        type: 'run.started',
        // VISION §9: a synthesized event must never masquerade as a report.
        source: 'runner-reported',
        runId: workOrder().runId,
        workOrderId: workOrder().identity,
        runner: 'claude-code-local',
      });
    }, 30_000);
  });

  describe('poll', () => {
    it('returns unknown for a handle it has never seen, rather than throwing', async () => {
      // An exception would be indistinguishable from the runner being down,
      // and the two call for different responses.
      const runner = build({ 'runners.claudeCodeLocal.binary': '/bin/true' });

      await expect(
        runner.poll({
          runnerKey: 'claude-code-local',
          externalId: 'nothing-like-this',
          workOrderIdentity: 'wo_gone_1_0000000_a1',
        }),
      ).resolves.toEqual({ status: 'unknown', events: [] });
    });

    it('returns unknown for a stale handle to an identity it has re-taken', async () => {
      const binary = await fakeClaude('stale', 'exit 0');
      const runner = build({ 'runners.claudeCodeLocal.binary': binary });
      const live = await runner.submit(workOrder());

      const stale: RunHandle = { ...live, externalId: `${live.externalId}-old` };
      await expect(runner.poll(stale)).resolves.toEqual({ status: 'unknown', events: [] });
      await drainUntilTerminal(runner, live);
    }, 30_000);

    it('drains events once — a second poll does not redeliver them', async () => {
      const binary = await fakeClaude('drain', 'exit 0');
      const runner = build({ 'runners.claudeCodeLocal.binary': binary });

      const handle = await runner.submit(workOrder());
      const first = await runner.poll(handle);
      const second = await runner.poll(handle);

      expect(first.events.length).toBeGreaterThan(0);
      expect(second.events).toHaveLength(0);
      await drainUntilTerminal(runner, handle);
    }, 30_000);

    it('reports succeeded and a completed event for a clean exit', async () => {
      const binary = await fakeClaude('clean', 'echo \'{"type":"assistant"}\'; exit 0');
      const runner = build({ 'runners.claudeCodeLocal.binary': binary });

      const handle = await runner.submit(workOrder());
      const { status, events } = await drainUntilTerminal(runner, handle);

      expect(status).toBe('succeeded');
      const completed = events.find((event) => event.type === 'run.completed');
      expect(completed).toBeDefined();
      expect(completed?.result?.branch).toBe('factory/42-abc1234-a1');
      expect(events.some((event) => event.type === 'run.failed')).toBe(false);
    }, 30_000);

    it('reports failed for a non-zero exit, with stderr as the reason', async () => {
      // An operator reading "exit 1: fatal: could not authenticate" can act;
      // one reading "exit 1" has to go and reproduce it.
      const binary = await fakeClaude(
        'boom',
        'echo "fatal: could not authenticate" >&2; exit 1',
      );
      const runner = build({ 'runners.claudeCodeLocal.binary': binary });

      const handle = await runner.submit(workOrder());
      const { status, events } = await drainUntilTerminal(runner, handle);

      expect(status).toBe('failed');
      const failed = events.find((event) => event.type === 'run.failed');
      expect(failed?.failure?.reason).toContain('exit 1');
      expect(failed?.failure?.reason).toContain('could not authenticate');
      expect(failed?.failure?.retryable).toBe(true);
    }, 30_000);

    it('trusts the exit code over anything the run said about itself', async () => {
      // VISION §8 puts the runner on the never-trustable list. A run that
      // prints "done" and then exits non-zero is a run that failed.
      const binary = await fakeClaude(
        'liar',
        'echo \'{"type":"result","subtype":"success"}\'; exit 2',
      );
      const runner = build({ 'runners.claudeCodeLocal.binary': binary });

      const handle = await runner.submit(workOrder());
      const { status, events } = await drainUntilTerminal(runner, handle);

      expect(status).toBe('failed');
      expect(events.some((event) => event.type === 'run.completed')).toBe(false);
    }, 30_000);

    it('fails the run when the binary does not exist', async () => {
      // The likeliest misconfiguration of this runner, and it must arrive as
      // a run.failed the control plane can act on rather than as an exception
      // out of submit.
      const runner = build({
        'runners.claudeCodeLocal.binary': join(binDir, 'not-installed'),
      });

      const handle = await runner.submit(workOrder());
      const { status, events } = await drainUntilTerminal(runner, handle);

      expect(status).toBe('failed');
      const failed = events.find((event) => event.type === 'run.failed');
      expect(failed?.failure?.reason).toContain('could not start');
      // Retrying a missing binary just fails again on the next tick.
      expect(failed?.failure?.retryable).toBe(false);
    }, 30_000);

    it('emits exactly one terminal event per run', async () => {
      // Two contradictory endings for one run is worse than a missing one:
      // ingestion would have to pick, and nothing tells it which is right.
      const binary = await fakeClaude('once', 'exit 0');
      const runner = build({ 'runners.claudeCodeLocal.binary': binary });

      const handle = await runner.submit(workOrder());
      const { events } = await drainUntilTerminal(runner, handle);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const extra = await runner.poll(handle);

      const terminal = [...events, ...extra.events].filter(
        (event) => event.type === 'run.completed' || event.type === 'run.failed',
      );
      expect(terminal).toHaveLength(1);
    }, 30_000);
  });

  describe('cancel', () => {
    it('terminates the run and everything it spawned', async () => {
      // #61: "cancellation actually terminates work, and does not leave
      // orphaned processes." The fake starts a grandchild, exactly as a real
      // agent's git or test runner would be.
      const binary = await fakeClaude(
        'spawner',
        `sleep 60 & echo $! > "${binDir}/grandchild.pid"; wait`,
      );
      const runner = build({ 'runners.claudeCodeLocal.binary': binary });

      const handle = await runner.submit(workOrder());
      await until(async () => {
        try {
          return (await readFile(`${binDir}/grandchild.pid`, 'utf8')).trim().length > 0;
        } catch {
          return false;
        }
      });
      const grandchild = Number((await readFile(`${binDir}/grandchild.pid`, 'utf8')).trim());

      await runner.cancel(handle);
      const { status, events } = await drainUntilTerminal(runner, handle);

      expect(status).toBe('failed');
      const failed = events.find((event) => event.type === 'run.failed');
      expect(failed?.failure?.reason).toContain('cancelled');
      // Something decided to stop this run; retrying it as-is is not the
      // answer, so the advisory flag says so.
      expect(failed?.failure?.retryable).toBe(false);

      await until(() => {
        try {
          process.kill(grandchild, 0);
          return false;
        } catch {
          return true;
        }
      });
    }, 30_000);

    it('does not throw for a handle it has never seen', async () => {
      const runner = build({ 'runners.claudeCodeLocal.binary': '/bin/true' });
      await expect(
        runner.cancel({
          runnerKey: 'claude-code-local',
          externalId: 'unknown',
          workOrderIdentity: 'wo_gone_1_0000000_a1',
        }),
      ).resolves.toBeUndefined();
    });

    it('is idempotent, including after the run has already ended', async () => {
      const binary = await fakeClaude('gone', 'exit 0');
      const runner = build({ 'runners.claudeCodeLocal.binary': binary });

      const handle = await runner.submit(workOrder());
      await drainUntilTerminal(runner, handle);

      await expect(runner.cancel(handle)).resolves.toBeUndefined();
      await expect(runner.cancel(handle)).resolves.toBeUndefined();
    }, 30_000);
  });

  describe('capabilities', () => {
    it('reports the version it observed, not one it was told', async () => {
      // #61: the manifest must be "verified against observed behaviour, not
      // aspirational". A hard-coded version is a claim about a binary nobody
      // looked at.
      const binary = await fakeClaude('versioned', 'echo "2.1.240 (Claude Code)"; exit 0');
      const runner = build({ 'runners.claudeCodeLocal.binary': binary });

      const capabilities = await runner.capabilities();

      expect(capabilities.version).toBe('2.1.240');
      expect(capabilities.key).toBe('claude-code-local');
      expect(capabilities.invocationModel).toBe('process');
      expect(capabilities.executionLocus).toBe('own_infrastructure');
    }, 30_000);

    it('declares zero capacity when the binary cannot be probed', async () => {
      // Zero headroom is already how the dispatch policy says "route nothing
      // here", so a missing CLI degrades into a queue with a reason rather
      // than into a run that fails after being authorized.
      const runner = build({
        'runners.claudeCodeLocal.binary': join(binDir, 'absent'),
      });

      const capabilities = await runner.capabilities();

      expect(capabilities.maxConcurrency).toBe(0);
      expect(capabilities.version).toBe('unavailable');
    }, 30_000);

    it('declares the fidelity the mapper actually delivers', async () => {
      // Each of these is earned by a mapping that exists in
      // stream-json-mapper.ts, not by what the CLI is capable of. Slice 1
      // shipped declaring 'none' for exactly that reason.
      const binary = await fakeClaude('honest', 'echo "2.1.240 (Claude Code)"; exit 0');
      const runner = build({ 'runners.claudeCodeLocal.binary': binary });

      const capabilities = await runner.capabilities();

      expect(capabilities.streamingFidelity).toBe('full');
      expect(capabilities.rateLimitSignal).toBe('structured');
      expect(capabilities.reportsCost).toBe(true);
    }, 30_000);

    it('stays experimental while its ceilings are declared but not enforced', async () => {
      // Budget and wall-clock enforcement is #65 and the third slice. A
      // runner whose limits are advertised and not applied is not stable, and
      // stabilityTier also gates the preview-runner rule in dispatch (#64).
      const binary = await fakeClaude('tier', 'echo "2.1.240 (Claude Code)"; exit 0');
      const runner = build({ 'runners.claudeCodeLocal.binary': binary });

      expect((await runner.capabilities()).stabilityTier).toBe('experimental');
    }, 30_000);

    it('keeps the JSON manifest and the typed capabilities in step', async () => {
      // Two hand-maintained copies would drift, and the drift would be
      // invisible: the typed one drives dispatch while the JSON one is what a
      // human reads to decide whether to trust it.
      const binary = await fakeClaude('mirror', 'echo "2.1.240 (Claude Code)"; exit 0');
      const runner = build({ 'runners.claudeCodeLocal.binary': binary });

      const { manifest, ...declared } = await runner.capabilities();
      expect(manifest).toEqual(declared);
    }, 30_000);

    it('only ever claims to create factory branches', async () => {
      const binary = await fakeClaude('branches', 'echo "2.1.240 (Claude Code)"; exit 0');
      const runner = build({ 'runners.claudeCodeLocal.binary': binary });

      expect((await runner.capabilities()).branchPatterns).toEqual(['factory/*']);
    }, 30_000);
  });

  describe('mapped output (#61 slice 2)', () => {
    /**
     * A fake agent that speaks real `stream-json`.
     *
     * The lines are the shapes captured from CLI 2.1.240 — a tool call, some
     * thinking, a tool result, and a result line with a cost — so this
     * exercises the same mapper against the same bytes the runner will see in
     * production, through a real pipe rather than a function call.
     */
    const STREAM = [
      '{"type":"system","subtype":"init","model":"claude-sonnet-5","uuid":"11111111-0000-4000-8000-000000000001"}',
      '{"type":"assistant","timestamp":"2026-08-22T22:02:44.597Z","uuid":"11111111-0000-4000-8000-000000000002",' +
        '"message":{"role":"assistant","content":[{"type":"thinking","thinking":"hmm","signature":"x"}]}}',
      '{"type":"assistant","timestamp":"2026-08-22T22:02:45.080Z","uuid":"11111111-0000-4000-8000-000000000003",' +
        '"message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"Bash",' +
        '"input":{"command":"npm test","description":"run tests"}}]}}',
      '{"type":"user","timestamp":"2026-08-22T22:02:45.859Z","uuid":"11111111-0000-4000-8000-000000000004",' +
        '"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","is_error":false}]}}',
      '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.2030522,' +
        '"usage":{"input_tokens":8,"output_tokens":362},"num_turns":4,"duration_ms":8855,' +
        '"permission_denials":[{"tool_name":"Read"}],"result":"done","uuid":"11111111-0000-4000-8000-000000000005"}',
    ];

    const emit = (lines: string[]) =>
      lines.map((line) => `printf '%s\\n' ${JSON.stringify(line)}`).join('\n');

    it('turns a tool call into progress with a name and a digest', async () => {
      // Through a real pipe, so line buffering and JSON parsing are both in
      // the path — not just the mapper's own unit test.
      const binary = await fakeClaude('streaming', `${emit(STREAM)}\nexit 0`);
      const runner = build({ 'runners.claudeCodeLocal.binary': binary });

      const handle = await runner.submit(workOrder());
      const { events } = await drainUntilTerminal(runner, handle);

      const tool = events.find((event) => event.tool?.name === 'Bash');
      expect(tool?.type).toBe('run.progress');
      expect(tool?.tool?.signature).toMatch(/^[0-9a-f]{32}$/);
      // The command line never leaves the child.
      expect(JSON.stringify(events)).not.toContain('npm test');
    }, 30_000);

    it('emits heartbeats for thinking and tool results', async () => {
      const binary = await fakeClaude('heartbeats', `${emit(STREAM)}\nexit 0`);
      const runner = build({ 'runners.claudeCodeLocal.binary': binary });

      const handle = await runner.submit(workOrder());
      const { events } = await drainUntilTerminal(runner, handle);

      expect(events.filter((event) => event.type === 'run.heartbeat').length).toBe(2);
    }, 30_000);

    it('puts the cost from the result line on the terminal event', async () => {
      const binary = await fakeClaude('costed', `${emit(STREAM)}\nexit 0`);
      const runner = build({ 'runners.claudeCodeLocal.binary': binary });

      const handle = await runner.submit(workOrder());
      const { events } = await drainUntilTerminal(runner, handle);

      const completed = events.find((event) => event.type === 'run.completed');
      expect(completed?.cost?.usd).toBeCloseTo(0.2030522);
      expect(completed?.cost?.tokensInput).toBe(8);
      expect(completed?.cost?.tokensOutput).toBe(362);
    }, 30_000);

    it('still reports cost when the run FAILED', async () => {
      // A run that failed still spent the money. A budget that only counted
      // successful runs would be no budget at all.
      const binary = await fakeClaude('costed-fail', `${emit(STREAM)}\nexit 4`);
      const runner = build({ 'runners.claudeCodeLocal.binary': binary });

      const handle = await runner.submit(workOrder());
      const { events } = await drainUntilTerminal(runner, handle);

      const failed = events.find((event) => event.type === 'run.failed');
      expect(failed?.cost?.usd).toBeCloseTo(0.2030522);
    }, 30_000);

    it('does not let the result line end the run', async () => {
      // The CLI says success; the process exits 4. VISION §8: the exit code
      // is the fact, the output is a report.
      const binary = await fakeClaude('liar-stream', `${emit(STREAM)}\nexit 4`);
      const runner = build({ 'runners.claudeCodeLocal.binary': binary });

      const handle = await runner.submit(workOrder());
      const { status, events } = await drainUntilTerminal(runner, handle);

      expect(status).toBe('failed');
      expect(events.filter((event) => event.type === 'run.completed')).toHaveLength(0);
      expect(events.filter((event) => event.type === 'run.failed')).toHaveLength(1);
    }, 30_000);

    it('surfaces permission denials in the completion summary', async () => {
      // Under the default narrow permission mode this is a real possibility,
      // and a run that finished having been refused half its tools is one
      // whose output should be read differently.
      const binary = await fakeClaude('denied', `${emit(STREAM)}\nexit 0`);
      const runner = build({ 'runners.claudeCodeLocal.binary': binary });

      const handle = await runner.submit(workOrder());
      const { events } = await drainUntilTerminal(runner, handle);

      const completed = events.find((event) => event.type === 'run.completed');
      expect(completed?.summary).toContain('1 permission denial(s)');
    }, 30_000);

    it('survives non-JSON on stdout without failing the run', async () => {
      // ADR 0006: "Never let a parse failure kill the run. A run producing
      // output nobody can read is still a run."
      const noise = [
        'printf \'%s\\n\' "warning: this is not JSON at all"',
        'printf \'%s\\n\' "{ broken json"',
        emit(STREAM),
      ].join('\n');
      const binary = await fakeClaude('noisy', `${noise}\nexit 0`);
      const runner = build({ 'runners.claudeCodeLocal.binary': binary });

      const handle = await runner.submit(workOrder());
      const { status, events } = await drainUntilTerminal(runner, handle);

      expect(status).toBe('succeeded');
      expect(events.some((event) => event.tool?.name === 'Bash')).toBe(true);
      const completed = events.find((event) => event.type === 'run.completed');
      expect(completed?.summary).toContain('2 unparseable line(s)');
    }, 30_000);

    it('leaves cost absent when the run died before its result line', async () => {
      // Not zero. A run killed mid-flight spent money nobody can account for,
      // and saying so beats reporting $0 — the schema keeps the two distinct.
      const binary = await fakeClaude('no-result', 'sleep 30');
      const runner = build({ 'runners.claudeCodeLocal.binary': binary });

      const handle = await runner.submit(workOrder());
      await runner.cancel(handle);
      const { events } = await drainUntilTerminal(runner, handle);

      const failed = events.find((event) => event.type === 'run.failed');
      expect(failed?.cost).toBeUndefined();
    }, 30_000);

    it('tags every event with the runner key AND its observed version', async () => {
      // The schema asks `runner` to be key@version, and #66's retry decisions
      // read it as fact — a constant there would make a bisect meaningless.
      const binary = await fakeClaude('tagged', `echo "2.1.240 (Claude Code)"\n${emit(STREAM)}\nexit 0`);
      const runner = build({ 'runners.claudeCodeLocal.binary': binary });

      // Probe first, so the version is known before the run starts.
      await runner.capabilities();

      const handle = await runner.submit(workOrder());
      const { events } = await drainUntilTerminal(runner, handle);

      expect(events.length).toBeGreaterThan(0);
      for (const event of events) expect(event.runner).toBe('claude-code-local@2.1.240');
    }, 30_000);
  });

  describe('limits (#61 slice 3)', () => {
    it('kills a run that overruns its wall clock', async () => {
      // The one ceiling this runner can actually enforce, because time is
      // observable from outside the process.
      const binary = await fakeClaude('overrun', 'sleep 30');
      const runner = build({
        'runners.claudeCodeLocal.binary': binary,
        'runners.claudeCodeLocal.killGraceMs': 200,
      });

      // 1/1200 of a minute ≈ 50ms — the enforcement path is the same at any
      // scale, and a test that waited a real minute would never be run.
      const handle = await runner.submit(workOrder({ wallClockTimeoutMinutes: 1 / 1200 }));
      const { status, events } = await drainUntilTerminal(runner, handle);

      expect(status).toBe('failed');
      const failed = events.find((event) => event.type === 'run.failed');
      expect(failed?.failure?.reason).toContain('wall-clock ceiling');
    }, 30_000);

    it('calls a timeout retryable, unlike a cancel', async () => {
      // #66 treats them differently and must: a run something DECIDED to stop
      // should not be repeated as-is, while one that merely ran out of clock
      // might well finish on a quieter machine.
      const binary = await fakeClaude('overrun-retry', 'sleep 30');
      const runner = build({
        'runners.claudeCodeLocal.binary': binary,
        'runners.claudeCodeLocal.killGraceMs': 200,
      });

      const handle = await runner.submit(workOrder({ wallClockTimeoutMinutes: 1 / 1200 }));
      const { events } = await drainUntilTerminal(runner, handle);

      const failed = events.find((event) => event.type === 'run.failed');
      expect(failed?.failure?.retryable).toBe(true);
      expect(failed?.failure?.reason).not.toContain('cancelled');
    }, 30_000);

    it('applies a default ceiling to a work order that names none', async () => {
      // VISION §1's origin story is four hours dead, which is what an
      // unbounded run looks like when it wedges. A missing ceiling must not
      // mean "run forever".
      const binary = await fakeClaude('defaulted', 'sleep 30');
      const runner = build({
        'runners.claudeCodeLocal.binary': binary,
        'runners.claudeCodeLocal.killGraceMs': 200,
        'runners.claudeCodeLocal.defaultTimeoutMinutes': 1 / 1200,
      });

      const handle = await runner.submit(workOrder({ wallClockTimeoutMinutes: null }));
      const { events } = await drainUntilTerminal(runner, handle);

      expect(events.find((event) => event.type === 'run.failed')?.failure?.reason).toContain(
        'wall-clock ceiling',
      );
    }, 30_000);

    it("lets the work order's own ceiling win over the default", async () => {
      const binary = await fakeClaude('own-ceiling', 'sleep 30');
      const runner = build({
        'runners.claudeCodeLocal.binary': binary,
        'runners.claudeCodeLocal.killGraceMs': 200,
        // A default far longer than the work order's, so a run stopped early
        // proves the work order's number was the one applied.
        'runners.claudeCodeLocal.defaultTimeoutMinutes': 600,
      });

      const handle = await runner.submit(workOrder({ wallClockTimeoutMinutes: 1 / 1200 }));
      const { events } = await drainUntilTerminal(runner, handle);

      expect(events.find((event) => event.type === 'run.failed')?.failure?.reason).toContain(
        'wall-clock ceiling',
      );
    }, 30_000);

    it('leaves a run unbounded when nothing sets a ceiling', async () => {
      // Genuinely unbounded is a deliberate operator choice, not an oversight,
      // so an unset default must not silently become one.
      const binary = await fakeClaude('unbounded', 'exit 0');
      const runner = build({
        'runners.claudeCodeLocal.binary': binary,
        'runners.claudeCodeLocal.defaultTimeoutMinutes': null,
      });

      const handle = await runner.submit(workOrder({ wallClockTimeoutMinutes: null }));
      const { status, events } = await drainUntilTerminal(runner, handle);

      expect(status).toBe('succeeded');
      expect(events.some((event) => event.type === 'run.failed')).toBe(false);
    }, 30_000);

    it('does not report a wall-clock overrun for an ordinary cancel', async () => {
      const binary = await fakeClaude('plain-cancel', 'sleep 30');
      const runner = build({
        'runners.claudeCodeLocal.binary': binary,
        'runners.claudeCodeLocal.killGraceMs': 200,
        'runners.claudeCodeLocal.defaultTimeoutMinutes': 600,
      });

      const handle = await runner.submit(workOrder());
      await runner.cancel(handle);
      const { events } = await drainUntilTerminal(runner, handle);

      const failed = events.find((event) => event.type === 'run.failed');
      expect(failed?.failure?.reason).toContain('cancelled');
      expect(failed?.failure?.reason).not.toContain('wall-clock');
      expect(failed?.failure?.retryable).toBe(false);
    }, 30_000);
  });

  describe('housekeeping (#61 slice 3)', () => {
    it('reaps finished runs so the map does not grow forever', async () => {
      // Slice 1 never dropped anything. On the single long-lived API VISION
      // §11 designs for, that is a leak measured in weeks — every run ever
      // submitted, with its events, stderr tail and workspace path.
      const binary = await fakeClaude('reapable', 'exit 0');
      const runner = build({ 'runners.claudeCodeLocal.binary': binary });

      const handle = await runner.submit(workOrder());
      await drainUntilTerminal(runner, handle);

      // Age it past the retention window, then trigger a reap.
      const runs = (runner as unknown as { runs: Map<string, { finishedAt: Date | null }> }).runs;
      runs.get(workOrder().identity)!.finishedAt = new Date(
        Date.now() - FINISHED_RUN_RETENTION_MS - 1_000,
      );
      await runner.submit(workOrder({ identity: 'wo_acme-widgets_99_abc1234_a1' }));

      expect(runs.has(workOrder().identity)).toBe(false);
    }, 30_000);

    it('never reaps a run whose ending nobody has collected', async () => {
      // The terminal event lives in `pending` until something polls for it.
      // Reaping on age alone would throw away the event that says how the run
      // ended — which is the one event nothing else can reconstruct.
      const binary = await fakeClaude('uncollected', 'exit 0');
      const runner = build({ 'runners.claudeCodeLocal.binary': binary });

      const handle = await runner.submit(workOrder());
      const runs = (runner as unknown as {
        runs: Map<string, { finishedAt: Date | null; pending: unknown[] }>;
      }).runs;

      // Wait for the process to end WITHOUT polling, so the events stay queued.
      await until(() => runs.get(workOrder().identity)!.finishedAt !== null);
      runs.get(workOrder().identity)!.finishedAt = new Date(
        Date.now() - FINISHED_RUN_RETENTION_MS - 1_000,
      );
      await runner.submit(workOrder({ identity: 'wo_acme-widgets_98_abc1234_a1' }));

      expect(runs.has(workOrder().identity)).toBe(true);
      expect((await runner.poll(handle)).events.length).toBeGreaterThan(0);
    }, 30_000);

    it('keeps a still-running run, however long it has been going', async () => {
      const binary = await fakeClaude('long-lived', 'sleep 10');
      const runner = build({ 'runners.claudeCodeLocal.binary': binary });

      const handle = await runner.submit(workOrder());
      await runner.poll(handle);
      await runner.submit(workOrder({ identity: 'wo_acme-widgets_97_abc1234_a1' }));

      expect((await runner.poll(handle)).status).toBe('running');
      await runner.cancel(handle);
    }, 30_000);

    it('cancels live runs on a graceful shutdown', async () => {
      // An agent still running after its supervisor has deliberately gone away
      // is spending the operator's quota with nothing left to escalate on its
      // behalf. A CRASH is different and deliberately not covered — the
      // detached children survive it, and git-derived liveness (#52) is the
      // second source that covers exactly that window.
      const binary = await fakeClaude('shutdown', 'sleep 30');
      const runner = build({
        'runners.claudeCodeLocal.binary': binary,
        'runners.claudeCodeLocal.killGraceMs': 200,
      });

      const handle = await runner.submit(workOrder());
      await runner.onModuleDestroy();

      const { status } = await drainUntilTerminal(runner, handle);
      expect(status).toBe('failed');
    }, 30_000);

    it('shuts down cleanly with nothing running', async () => {
      const runner = build({ 'runners.claudeCodeLocal.binary': '/bin/true' });
      await expect(runner.onModuleDestroy()).resolves.toBeUndefined();
    });
  });

  describe('conformance (#36)', () => {
    it('emits a manifest that validates against runner-capability.schema.json', async () => {
      // #61's last acceptance criterion: "passes the conformance suite from
      // #36". The schema requires `notes` whenever reportsCost is false —
      // a budget ceiling nobody can enforce is worse than an absent one,
      // because it looks like a control.
      const binary = await fakeClaude('conform-cap', 'echo "2.1.240 (Claude Code)"; exit 0');
      const runner = build({ 'runners.claudeCodeLocal.binary': binary });

      const validate = validatorFor('runner-capability');
      const capabilities = await runner.capabilities();

      expect(validate(capabilities.manifest)).toBe(true);
      expect(explainErrors(validate)).toBe('');
    }, 30_000);

    it('emits events that validate against run-event.schema.json', async () => {
      const binary = await fakeClaude('conform-ok', 'exit 0');
      const runner = build({ 'runners.claudeCodeLocal.binary': binary });

      const validate = validatorFor('run-event');
      const handle = await runner.submit(workOrder());
      const { events } = await drainUntilTerminal(runner, handle);

      expect(events.length).toBeGreaterThan(0);
      for (const event of events) {
        expect(validate(event)).toBe(true);
        expect(explainErrors(validate)).toBe('');
      }
    }, 30_000);

    it('emits a valid failure event too, not only the happy path', async () => {
      // Building only the happy path is what #36 says "guarantees
      // discovering, six months later, that the seam was fictional".
      const binary = await fakeClaude('conform-fail', 'echo bad >&2; exit 9');
      const runner = build({ 'runners.claudeCodeLocal.binary': binary });

      const validate = validatorFor('run-event');
      const handle = await runner.submit(workOrder());
      const { events } = await drainUntilTerminal(runner, handle);

      const failed = events.find((event) => event.type === 'run.failed');
      expect(failed).toBeDefined();
      expect(validate(failed)).toBe(true);
      expect(explainErrors(validate)).toBe('');
    }, 30_000);
  });
});
