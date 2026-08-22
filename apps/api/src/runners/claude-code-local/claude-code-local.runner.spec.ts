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
        'statusOf',
        'settle',
        'failureReason',
        'event',
        'liveRunCount',
        'probeVersion',
      ];

      const implemented = Object.getOwnPropertyNames(ClaudeCodeLocalRunner.prototype)
        .filter(
          (name) =>
            name !== 'constructor' &&
            typeof Object.getOwnPropertyDescriptor(ClaudeCodeLocalRunner.prototype, name)?.value ===
              'function',
        )
        .filter((name) => !INTERNALS.includes(name));

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

    it('declares no streaming fidelity while the output is not parsed', async () => {
      // The honesty test for this slice. The CLI is capable of full
      // streaming; this runner is not yet reading it, and #61 is explicit
      // that overstating it "produces a control plane that trusts signal it
      // is not actually receiving".
      const binary = await fakeClaude('honest', 'echo "2.1.240 (Claude Code)"; exit 0');
      const runner = build({ 'runners.claudeCodeLocal.binary': binary });

      const capabilities = await runner.capabilities();

      expect(capabilities.streamingFidelity).toBe('none');
      expect(capabilities.rateLimitSignal).toBe('none');
      expect(capabilities.reportsCost).toBe(false);
      expect(capabilities.stabilityTier).toBe('experimental');
    }, 30_000);

    it('only ever claims to create factory branches', async () => {
      const binary = await fakeClaude('branches', 'echo "2.1.240 (Claude Code)"; exit 0');
      const runner = build({ 'runners.claudeCodeLocal.binary': binary });

      expect((await runner.capabilities()).branchPatterns).toEqual(['factory/*']);
    }, 30_000);
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
