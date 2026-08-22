import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';

import { RUN_EVENT_SCHEMA_VERSION, type RunEventPayload } from '../../run-events/run-event.types';
import {
  ChildProcessSupervisor,
  type SupervisedProcess,
} from '../process/child-process-supervisor';
import { runCommand } from '../process/run-command';
import type {
  RunHandle,
  Runner,
  RunnerCapabilities,
  RunnerRunStatus,
  RunPollResult,
  WorkOrderSpec,
} from '../runner.types';
import {
  buildInvocationArgs,
  buildInvocationEnv,
  buildPrompt,
  PERMISSION_MODES,
  type PermissionMode,
} from './claude-code-invocation';
import { RunWorkspaceService } from './run-workspace.service';
import {
  mapStreamLine,
  type StreamResult,
} from './stream-json-mapper';

/**
 * The v1 runner: Claude Code, as a child process, on our own hardware.
 *
 * ## What this slice does and does not do
 *
 * #61 asks to be delivered as more than one PR — *"seam wiring, then event
 * mapping, then cancellation and limits"*.
 *
 * Slice 1 spawned the CLI, supervised it, and turned its LIFECYCLE into
 * normalized events: `run.started` on spawn, `run.completed` or `run.failed`
 * on exit, decided by the exit code and nothing else.
 *
 * Slice 2 added the `stream-json` mapper, so the runner is no longer blind:
 * tool calls, prose, thinking, tool results, rate limits and permission
 * refusals all become normalized events, and {@link capabilities} now declares
 * `streamingFidelity: 'full'`, `rateLimitSignal: 'structured'` and
 * `reportsCost: true` — each one earned by a mapping that exists, not by what
 * the CLI is capable of.
 *
 * That order is the point, and it is why #32's manifest is graded rather than
 * boolean. Slice 1 shipped declaring `none`, which was true and made loop
 * detection (#55) report UNAVAILABLE rather than pass on an empty stream.
 * Declaring `full` a PR early would have been what #61 warns against —
 * *"overstating it produces a control plane that trusts signal it is not
 * actually receiving"* — and a boolean would have forced the choice between
 * lying for one release and shipping nothing.
 *
 * Still NOT here: budget and wall-clock enforcement. The manifest says
 * `stabilityTier: 'experimental'` for that reason, and #61's third slice is
 * where it changes.
 *
 * ## Why the process is the source of truth
 *
 * Status comes from the child's exit, not from anything the child says about
 * itself. VISION §8 puts the runner on the never-trustable list, and a run
 * that prints "done" and then exits non-zero is a run that failed. The
 * supervisor's outcome is the fact; the output stream is a report.
 */
@Injectable()
export class ClaudeCodeLocalRunner implements Runner {
  static readonly KEY = 'claude-code-local';

  private readonly logger = new Logger(ClaudeCodeLocalRunner.name);
  private readonly supervisor = new ChildProcessSupervisor();
  /** Keyed by work-order identity — the thing submit is idempotent on. */
  private readonly runs = new Map<string, LocalRun>();
  private observedVersion: string | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly workspaces: RunWorkspaceService,
  ) {}

  get key(): string {
    return ClaudeCodeLocalRunner.KEY;
  }

  // -------------------------------------------------------------------------
  // submit
  // -------------------------------------------------------------------------

  /**
   * Provision a workspace, spawn the CLI, return a handle.
   *
   * Idempotent on `identity`, per #18: re-submitting an identity that is
   * already running returns the existing handle rather than starting a second
   * agent on the same branch. Two agents on one branch is not a slow path, it
   * is a corrupted one — they would race each other's commits.
   */
  async submit(workOrder: WorkOrderSpec): Promise<RunHandle> {
    const existing = this.runs.get(workOrder.identity);
    if (existing) {
      this.logger.log(`Re-submit of ${workOrder.identity} returned the running handle`);
      return existing.handle;
    }

    // The ceiling is enforced by dispatch (#64) against declared capabilities.
    // This is the backstop, and it is here because the declaration is only a
    // promise until something keeps it: VISION §11 has automated runs
    // competing with a human for one subscription quota, and a runner that
    // quietly exceeded its own stated ceiling would make every dispatch
    // decision above it wrong.
    const ceiling = this.maxConcurrency;
    if (this.liveRunCount() >= ceiling) {
      throw new RunnerAtCapacityError(
        `${this.key} is at its concurrency ceiling of ${ceiling}`,
      );
    }

    const workspace = await this.workspaces.provision({
      identity: workOrder.identity,
      repository: workOrder.repository,
      baseCommit: workOrder.baseCommit,
      branch: workOrder.branch,
    });

    const handle: RunHandle = {
      runnerKey: this.key,
      // The pid is not enough on its own — pids are reused, and a handle that
      // aliased a later unrelated process would let cancel kill a stranger.
      // The identity makes it unambiguous, and nothing outside this file may
      // parse it either way (`RunHandle.externalId` is opaque by contract).
      externalId: `${workOrder.identity}:${randomUUID()}`,
      workOrderIdentity: workOrder.identity,
    };

    const run: LocalRun = {
      handle,
      workOrder,
      workspaceDir: workspace.dir,
      process: null as unknown as SupervisedProcess,
      pending: [],
      linesObserved: 0,
      lastOutputAt: null,
      settled: false,
      loggedDrops: new Set(),
      parseFailures: 0,
    };

    run.process = this.supervisor.start({
      command: this.binary,
      args: buildInvocationArgs({
        permissionMode: this.permissionMode,
        sessionId: workOrder.runId,
      }),
      cwd: workspace.dir,
      env: buildInvocationEnv(workOrder),
      stdin: buildPrompt(workOrder),
      killGraceMs: this.config.get<number>('runners.claudeCodeLocal.killGraceMs'),
      onLine: (line) => {
        run.linesObserved += 1;
        run.lastOutputAt = new Date();
        this.consumeLine(run, line);
      },
      onError: (error) => this.logger.warn(`${workOrder.identity}: ${error.message}`),
    });

    this.runs.set(workOrder.identity, run);

    // Not awaited: `submit` returns as soon as the run has started, and the
    // terminal event is queued whenever the process ends. Awaiting here would
    // turn dispatch into a blocking call for the length of the run.
    void run.process.waitForExit().then((outcome) => this.settle(run, outcome));

    run.pending.push(
      this.event(run, 'run.started', {
        summary:
          `Started ${workOrder.identity} from ${workOrder.baseCommit.slice(0, 7)} ` +
          `on ${workOrder.branch}` +
          (workspace.reused ? ' (reusing an existing workspace)' : ''),
      }),
    );

    this.logger.log(
      `Dispatched ${workOrder.identity} to pid ${run.process.pid ?? 'unknown'} in ${workspace.dir}`,
    );

    return handle;
  }

  // -------------------------------------------------------------------------
  // poll
  // -------------------------------------------------------------------------

  /**
   * Drain what has happened since last time.
   *
   * An unrecognised handle yields `unknown` rather than throwing. The runner
   * holds its runs in memory, so an API restart genuinely loses them — and
   * that is a fact the watchdog must be able to observe. An exception would be
   * indistinguishable from the runner being down, and the two call for
   * different responses.
   *
   * Note the detached child SURVIVES that restart, which is deliberate: the
   * work continues, git-derived liveness (#52) still sees its commits, and
   * VISION §9's second liveness source is exactly what covers the window where
   * the runner-reported one has gone.
   */
  async poll(handle: RunHandle): Promise<RunPollResult> {
    const run = this.runs.get(handle.workOrderIdentity);
    if (!run || run.handle.externalId !== handle.externalId) {
      return { status: 'unknown', events: [] };
    }

    const events = run.pending.splice(0);
    return { status: this.statusOf(run), events };
  }

  // -------------------------------------------------------------------------
  // cancel
  // -------------------------------------------------------------------------

  /**
   * Kill the process group.
   *
   * Idempotent, and never throws — for a handle that was never known, for a
   * run that has already ended, for a process that died between the check and
   * the signal. Cancel is what the watchdog reaches for once a run has been
   * established to be misbehaving, and an error path there would turn recovery
   * into an incident.
   *
   * The kill reaches the GROUP, not the leader: an agent spawns a git, a test
   * runner, a language server, and reparenting those to init leaves them
   * spending the quota the cancel was meant to reclaim.
   */
  async cancel(handle: RunHandle): Promise<void> {
    const run = this.runs.get(handle.workOrderIdentity);
    if (!run || run.handle.externalId !== handle.externalId) return;

    run.cancelRequested = true;
    run.process.kill();
    this.logger.log(`Cancelled ${handle.workOrderIdentity}`);
  }

  // -------------------------------------------------------------------------
  // capabilities
  // -------------------------------------------------------------------------

  /**
   * What this runner can do — observed, not declared.
   *
   * The version is read off the installed binary rather than hard-coded, and
   * a binary that cannot be probed reports `maxConcurrency: 0`. That is not a
   * decorative failure: zero headroom is already how the dispatch policy (#64)
   * says "route nothing here", so a missing or broken CLI degrades into a
   * queue with a reason instead of into a run that fails after being
   * authorized. Nothing new had to be invented for it to be honest.
   */
  async capabilities(): Promise<RunnerCapabilities> {
    const version = await this.probeVersion();

    const capabilities: RunnerCapabilities = {
      key: this.key,
      displayName: 'Claude Code (local)',
      version: version ?? 'unavailable',
      schemaVersion: '1.0.0',
      invocationModel: 'process',
      executionLocus: 'own_infrastructure',

      // Earned by `stream-json-mapper.ts`, and only now. Every `tool_use` line
      // becomes a `run.progress` carrying a tool name and an argument digest,
      // which is exactly what loop detection (#55) compares — so `full` is a
      // statement about a mapping that exists rather than about what the CLI
      // is capable of.
      streamingFidelity: 'full',

      // The CLI emits `rate_limit_event` with a `resetsAt` in unix seconds.
      // That timestamp is the whole difference between #56 parking a run with
      // a dated resume and #57 escalating it, so it is `structured` rather
      // than `heuristic`.
      rateLimitSignal: 'structured',

      // Still experimental: budget and timeout enforcement is #65 and the
      // third slice of #61, and a runner whose ceilings are declared but not
      // enforced is not one to mark stable. `stabilityTier` also gates the
      // preview-runner rule in dispatch (#64), which is the behaviour we want
      // until this has actually run unattended.
      stabilityTier: 'experimental',

      // `result` carries `total_cost_usd` and a token breakdown. Note the
      // manifest makes no claim about ENFORCING a budget — only about being
      // able to report one, which is the distinction #65 needs.
      reportsCost: true,

      // VISION §3.4 permits session resumption only as an optimization and
      // forbids it being load-bearing. The CLI has `--resume`; nothing here
      // uses it, and recovery stays abandon-and-re-run from the pinned base.
      resumable: false,

      // A binary that could not be probed advertises no capacity. Zero
      // headroom is already how the dispatch policy (#64) says "route nothing
      // here", so a missing CLI degrades into a queue with a reason rather
      // than a run that fails after being authorized.
      maxConcurrency: version === null ? 0 : this.maxConcurrency,
      branchPatterns: ['factory/*'],

      manifest: {},
    };

    // The manifest is the same facts as JSON, built from the object above
    // rather than typed out beside it. Two hand-maintained copies would drift,
    // and the drift would be invisible: the typed one drives dispatch while
    // the JSON one is what a human reads to decide whether to trust it.
    const { manifest: _ignored, ...declared } = capabilities;
    capabilities.manifest = { ...declared };

    return capabilities;
  }

  // -------------------------------------------------------------------------

  /**
   * One line of `stream-json`, parsed and mapped.
   *
   * ## Nothing here may end the run
   *
   * ADR 0006: *"Never let a parse failure kill the run. A run producing output
   * nobody can read is still a run, and git-derived liveness (#52) still sees
   * its commits."* So every failure mode below degrades to a count and a log
   * line, and the process keeps going.
   *
   * Unmappable line kinds are logged ONCE per run. A new CLI event type is a
   * version skew, and a version skew that filled the log on every heartbeat
   * would bury the run that actually needed attention.
   */
  private consumeLine(run: LocalRun, line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      run.parseFailures += 1;
      if (run.parseFailures === 1) {
        // Once. A CLI that starts writing non-JSON to stdout would otherwise
        // produce a log line per line of output.
        this.logger.warn(
          `${run.workOrder.identity}: stdout line was not JSON; further parse failures ` +
            'will be counted but not logged',
        );
      }
      return;
    }

    const mapping = mapStreamLine(parsed, {
      runId: run.workOrder.runId,
      workOrderId: run.workOrder.identity,
      runnerKey: this.runnerTag(),
      receivedAt: new Date(),
    });

    switch (mapping.kind) {
      case 'event':
        run.pending.push(mapping.event);
        return;

      case 'result':
        // Recorded, not emitted. The exit code decides how the run ended; this
        // supplies the cost and the final text that ending carries.
        run.cliResult = mapping.result;
        return;

      case 'drop':
        if (!run.loggedDrops.has(mapping.reason)) {
          run.loggedDrops.add(mapping.reason);
          this.logger.debug(`${run.workOrder.identity}: dropped a line — ${mapping.reason}`);
        }
        return;
    }
  }

  /**
   * `key@version`, which is what the event schema asks `runner` to be.
   *
   * Falls back to the bare key before the version has been observed. A wrong
   * version on an event is worse than a missing one: #66's retry decisions and
   * any later bisect read it as fact.
   */
  private runnerTag(): string {
    return this.observedVersion ? `${this.key}@${this.observedVersion}` : this.key;
  }

  private statusOf(run: LocalRun): RunnerRunStatus {
    const outcome = run.process.result();
    if (outcome === null) return 'running';
    if (outcome.kind === 'exited' && outcome.exitCode === 0) return 'succeeded';
    return 'failed';
  }

  /**
   * Turn the process's ending into the run's terminal event.
   *
   * Exactly one is queued per run: `settled` guards against a second `close`
   * or a late `error`, and a duplicate terminal event would give ingestion
   * two contradictory endings for one run.
   */
  private settle(run: LocalRun, outcome: NonNullable<ReturnType<SupervisedProcess['result']>>) {
    if (run.settled) return;
    run.settled = true;

    const observed = `${run.linesObserved} output line(s)`;
    // Cost from the CLI's own result line, attached to whichever ending the
    // exit code produces. A run that failed still spent the money, and a
    // budget that only counted successful runs would be no budget at all.
    const cost = this.costOf(run);

    if (outcome.kind === 'exited' && outcome.exitCode === 0) {
      run.pending.push(
        this.event(run, 'run.completed', {
          summary: this.completionSummary(run, observed),
          result: { branch: run.workOrder.branch },
          ...cost,
        }),
      );
      return;
    }

    run.pending.push(
      this.event(run, 'run.failed', {
        summary: `${run.workOrder.identity} ended after ${observed}`,
        ...cost,
        failure: {
          reason: this.failureReason(run, outcome),
          // Advisory only — VISION §3.6 leaves the decision to deterministic
          // policy (#66). A cancelled run is the one case that is definitely
          // not worth retrying as-is, because something decided to stop it.
          retryable: !run.cancelRequested && outcome.kind !== 'spawn-failed',
        },
      }),
    );
  }

  /**
   * What the run cost, when the CLI said.
   *
   * Absent means NOT REPORTED, which the schema keeps distinct from zero —
   * a runner that could not report cost must not look like one that spent
   * nothing. Here that gap is real: a run killed before its `result` line
   * spent money nobody can account for, and saying so beats reporting $0.
   */
  private costOf(run: LocalRun): { cost?: { usd?: number; tokensInput?: number; tokensOutput?: number } } {
    const result = run.cliResult;
    if (!result) return {};

    const cost = {
      usd: result.costUsd,
      tokensInput: result.tokensInput,
      tokensOutput: result.tokensOutput,
    };

    return Object.values(cost).every((value) => value === undefined) ? {} : { cost };
  }

  /**
   * A completion line worth reading in a timeline.
   *
   * Surfaces permission denials, because a run that finished having been
   * refused half its tools is a run whose output should be read differently —
   * and under the default narrow permission mode that is a real possibility
   * rather than a hypothetical one.
   */
  private completionSummary(run: LocalRun, observed: string): string {
    const parts = [`${run.workOrder.identity} exited cleanly after ${observed}`];

    const denials = run.cliResult?.permissionDenials ?? 0;
    if (denials > 0) parts.push(`${denials} permission denial(s)`);
    if (run.parseFailures > 0) parts.push(`${run.parseFailures} unparseable line(s)`);

    return parts.join(', ');
  }

  private failureReason(
    run: LocalRun,
    outcome: NonNullable<ReturnType<SupervisedProcess['result']>>,
  ): string {
    const stderr = run.process.stderr().trim().split('\n').filter(Boolean).pop();
    const detail = stderr ? `: ${stderr}` : '';

    switch (outcome.kind) {
      case 'spawn-failed':
        return `could not start ${this.binary}: ${outcome.error.message}`;
      case 'signalled':
        return run.cancelRequested
          ? `cancelled (${outcome.signal})${detail}`
          : `killed by ${outcome.signal}${detail}`;
      case 'exited':
        return `exit ${outcome.exitCode}${detail}`;
    }
  }

  private event(
    run: LocalRun,
    type: RunEventPayload['type'],
    rest: Partial<RunEventPayload>,
  ): RunEventPayload {
    return {
      schemaVersion: RUN_EVENT_SCHEMA_VERSION,
      // Sender-chosen, which is what makes ingestion idempotent on
      // `(runId, eventId)` — a redelivery is recognised, not stored twice.
      eventId: randomUUID(),
      runId: run.workOrder.runId,
      workOrderId: run.workOrder.identity,
      type,
      // Never anything else from here. VISION §9: a synthesized event must
      // never masquerade as a report, and everything this file emits is
      // something the runner itself observed.
      source: 'runner-reported',
      occurredAt: new Date().toISOString(),
      // `key@version`, as the event schema asks for — and the version is the
      // one probed off the binary, so a bisect across CLI releases has real
      // data to work with rather than a constant.
      runner: this.runnerTag(),
      ...rest,
    };
  }

  private liveRunCount(): number {
    let live = 0;
    for (const run of this.runs.values()) if (run.process.isAlive()) live += 1;
    return live;
  }

  /**
   * `claude --version`, once, cached.
   *
   * Cached because `capabilities()` is called on the dispatch path and #60
   * requires it be "cheap enough to call on a tick" — a process spawn per
   * routing decision is not. Cached only on SUCCESS, so an install that
   * appears after the API booted is picked up rather than being remembered as
   * missing forever.
   */
  private async probeVersion(): Promise<string | null> {
    if (this.observedVersion) return this.observedVersion;

    const result = await runCommand(this.supervisor, {
      command: this.binary,
      args: ['--version'],
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });

    if (!result.ok) {
      this.logger.warn(
        `Could not probe ${this.binary} --version; declaring zero capacity for ${this.key}`,
      );
      return null;
    }

    // "2.1.240 (Claude Code)" — the leading semver is the part anything else
    // can compare, and keeping the parenthetical would make every version
    // comparison a string match on a marketing name.
    const match = /(\d+\.\d+\.\d+[^\s]*)/.exec(result.stdout);
    this.observedVersion = match ? match[1] : result.stdout.trim();
    return this.observedVersion;
  }

  private get binary(): string {
    return this.config.get<string>('runners.claudeCodeLocal.binary')!;
  }

  private get maxConcurrency(): number {
    return this.config.get<number>('runners.claudeCodeLocal.maxConcurrency')!;
  }

  /**
   * The permission mode the CLI runs under.
   *
   * Defaults to the narrow end. A mode broad enough to never ask is coupled to
   * a sandbox that makes never asking safe, and sandboxing is #113 — so until
   * then a run that needs a permission it does not have goes silent and is
   * caught by the watchdog (#54), which is the failure this system is built to
   * notice. Widening it is a deliberate act by an operator who has read that.
   */
  private get permissionMode(): PermissionMode {
    const configured = this.config.get<string>('runners.claudeCodeLocal.permissionMode');
    if (configured && (PERMISSION_MODES as readonly string[]).includes(configured)) {
      return configured as PermissionMode;
    }
    if (configured) {
      this.logger.warn(`Unknown permission mode "${configured}"; falling back to acceptEdits`);
    }
    return 'acceptEdits';
  }
}

export class RunnerAtCapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunnerAtCapacityError';
  }
}

interface LocalRun {
  handle: RunHandle;
  workOrder: WorkOrderSpec;
  workspaceDir: string;
  process: SupervisedProcess;
  pending: RunEventPayload[];
  linesObserved: number;
  lastOutputAt: Date | null;
  settled: boolean;
  cancelRequested?: boolean;
  /** The CLI's own `result` line, folded into the terminal event on exit. */
  cliResult?: StreamResult;
  /** Line kinds already logged as unmappable — see `consumeLine`. */
  loggedDrops: Set<string>;
  parseFailures: number;
}
