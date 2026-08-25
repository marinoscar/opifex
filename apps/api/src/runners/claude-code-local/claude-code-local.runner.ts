import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';

import {
  RUN_EVENT_SCHEMA_VERSION,
  type RunEventPayload,
} from '../../run-events/run-event.types';
import {
  ChildProcessSupervisor,
  type SupervisedProcess,
} from '../process/child-process-supervisor';
import { runCommand } from '../process/run-command';
import type {
  RunHandle,
  Runner,
  RunnerCapabilities,
  RunnerQuotaObservation,
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
import { mapStreamLine, type StreamResult } from './stream-json-mapper';

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
 * Slice 3 added the limits, and the honest finding is that the two ceilings
 * are not equally enforceable. The wall clock is: time is observable from
 * outside the process, so {@link armDeadline} kills a run that overruns. A
 * dollar budget is NOT, because the CLI reports cost once at the end and the
 * per-message `usage` on assistant lines is a streaming snapshot that does not
 * sum to the total — so the ceiling can only be applied to the next attempt.
 * The manifest says which is which rather than implying both.
 *
 * Slice 3 also closed two things slice 1 got wrong: finished runs were never
 * dropped from the map (a leak measured in weeks on the single long-lived API
 * VISION §11 designs for), and a graceful shutdown left live agents running
 * with nothing left to supervise them.
 *
 * ## Why the process is the source of truth
 *
 * Status comes from the child's exit, not from anything the child says about
 * itself. VISION §8 puts the runner on the never-trustable list, and a run
 * that prints "done" and then exits non-zero is a run that failed. The
 * supervisor's outcome is the fact; the output stream is a report.
 */
@Injectable()
export class ClaudeCodeLocalRunner implements Runner, OnModuleDestroy {
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
    // Cheap, and on the one path that grows the map. A timer would be a second
    // thing to shut down cleanly for no benefit.
    this.reapFinishedRuns();

    const existing = this.runs.get(workOrder.identity);
    if (existing) {
      this.logger.log(
        `Re-submit of ${workOrder.identity} returned the running handle`,
      );
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
      pendingQuota: [],
      linesObserved: 0,
      lastOutputAt: null,
      settled: false,
      loggedDrops: new Set(),
      parseFailures: 0,
      finishedAt: null,
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
      killGraceMs: this.config.get<number>(
        'runners.claudeCodeLocal.killGraceMs',
      ),
      onLine: (line) => {
        run.linesObserved += 1;
        run.lastOutputAt = new Date();
        this.consumeLine(run, line);
      },
      onError: (error) =>
        this.logger.warn(`${workOrder.identity}: ${error.message}`),
    });

    this.runs.set(workOrder.identity, run);
    this.armDeadline(run);

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
    const quota = run.pendingQuota.splice(0);
    // Spread conditionally: absent means UNKNOWN on this seam, and a runner
    // that saw no window this tick has not observed that there is none.
    return {
      status: this.statusOf(run),
      events,
      ...(quota.length > 0 ? { quota } : {}),
    };
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
   * The version is read off the installed binary rather than hard-coded, and a
   * binary that cannot be probed reports `available: false` with the reason
   * attached. It used to report `maxConcurrency: 0` instead, which was the
   * wrong field: the runner still HAS the slots its operator configured and
   * will have them again the moment the CLI comes back, so declaring no
   * capacity described the wrong fact and — because the schema required at
   * least one slot — got the whole manifest rejected and the runner left
   * unregistered (#253, #262). Capacity is what it can do; availability is
   * whether it can do anything right now.
   */
  async capabilities(): Promise<RunnerCapabilities> {
    const version = await this.probeVersion();

    const capabilities: RunnerCapabilities = {
      key: this.key,
      displayName: 'Claude Code (local)',
      version: version ?? 'unavailable',

      // 1.3.0 rather than 1.0.0, because this runner publishes `available`,
      // which was added in 1.3.0 (#253). A document claiming conformance to a
      // version that did not have one of the fields it uses is exactly the
      // kind of misstatement the manifest exists to prevent — and a consumer
      // pinned at 1.2.0 would reject it, which is the honest outcome and the
      // one `speaksSchemaVersions` exists to let a producer avoid. This runner
      // ships with Opifex and moves with it, which ADR-0010 names as the case
      // where writing the schema's current version is correct.
      schemaVersion: '1.3.0',
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

      // `result` carries `total_cost_usd` and a token breakdown, so cost is
      // REPORTED accurately. It is deliberately not a claim about enforcing a
      // budget — the CLI emits cost once, at the end, and the per-message
      // `usage` on assistant lines is a streaming snapshot that does not sum
      // to the total. So a dollar ceiling can only be applied to the NEXT
      // attempt, and `armDeadline` explains why pretending otherwise would be
      // worse than admitting it. The wall clock is the ceiling this runner
      // actually enforces.
      reportsCost: true,

      // VISION §3.4 permits session resumption only as an optimization and
      // forbids it being load-bearing. The CLI has `--resume`; nothing here
      // uses it, and recovery stays abandon-and-re-run from the pinned base.
      resumable: false,

      // The real configured number, in every state. A binary that cannot be
      // probed does not shrink this runner's capacity — the slots are still
      // there and will be usable again the moment the CLI is — so reporting
      // zero here would have been a claim about the wrong thing.
      maxConcurrency: this.maxConcurrency,
      branchPatterns: ['factory/*'],

      // Availability, which is the fact a failed probe is actually about.
      // Spread conditionally so the key is ABSENT when the runner is fine:
      // absent means available, and a manifest that mentions its health only
      // when its health is worth mentioning is the one an operator can skim.
      ...(version === null
        ? {
            available: false,
            unavailableReason:
              `\`${this.binary} --version\` could not be probed, so the CLI is not ` +
              'reachable from this process. Install it or put it on this PATH; ' +
              'dispatch will queue rather than route here until it is.',
          }
        : {}),

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
   * Stop supervising, and stop what is being supervised.
   *
   * A graceful shutdown is the one moment where letting runs continue is
   * clearly wrong. VISION §8 makes the runner never-trustable and §9 makes the
   * watchdog the thing that notices when one goes bad — so an agent still
   * running after its supervisor has deliberately gone away is spending the
   * operator's quota with nothing left to escalate on its behalf. VISION
   * §3.4's recovery model makes the cost of stopping it small: the next
   * attempt starts from the pinned base regardless.
   *
   * A CRASH is different, and is deliberately not covered here — the detached
   * children survive it, and git-derived liveness (#52) is the second source
   * that covers exactly that window. This hook is for the ordered case.
   */
  async onModuleDestroy(): Promise<void> {
    const live = [...this.runs.values()].filter((run) => run.process.isAlive());
    if (live.length === 0) return;

    this.logger.warn(`Shutting down: cancelling ${live.length} live run(s)`);
    for (const run of live) {
      run.cancelRequested = true;
      run.process.kill();
    }
  }

  // -------------------------------------------------------------------------

  /**
   * The wall clock, which is the only ceiling this runner can actually enforce.
   *
   * ## Why not the budget
   *
   * The CLI reports cost **once, on its final `result` line**. The per-message
   * `usage` on `assistant` lines is a streaming SNAPSHOT, not a running total:
   * in the captured transcript those lines sum to 25 output tokens while the
   * result reports 362. Summing them would produce a number that is simply
   * wrong, and a wrong spend figure is worse than none — it would silently
   * license a run to keep going past a ceiling an operator believed was being
   * applied.
   *
   * So a dollar ceiling cannot be enforced mid-run by this runner, and the
   * manifest says so rather than implying otherwise. What it can do is report
   * the real figure on the terminal event, which is what lets policy (#65,
   * #66) refuse the NEXT attempt. Post-hoc enforcement is weaker than
   * mid-flight enforcement, and pretending otherwise is the failure mode
   * VISION §3.6 is about.
   *
   * The wall clock has none of that problem: time is observable from outside
   * the process, which is exactly why it is the ceiling worth having.
   */
  private armDeadline(run: LocalRun): void {
    const minutes =
      run.workOrder.wallClockTimeoutMinutes ?? this.defaultTimeoutMinutes;
    // A ceiling of null AND no configured default means genuinely unbounded,
    // which is a deliberate operator choice rather than an oversight.
    if (minutes === null || minutes <= 0) return;

    run.deadlineMinutes = minutes;
    run.deadlineTimer = setTimeout(() => {
      if (!run.process.isAlive()) return;
      this.logger.warn(
        `${run.workOrder.identity} exceeded its wall-clock ceiling of ${minutes} minute(s); killing`,
      );
      run.timedOut = true;
      run.process.kill();
    }, minutes * 60_000);

    // The deadline must not hold the process open. A shutdown should not have
    // to wait out the longest ceiling of anything still running.
    run.deadlineTimer.unref();
  }

  /**
   * Drop runs that ended long enough ago that nothing will poll them again.
   *
   * Without this the map grows for the life of the process — every run ever
   * submitted, with its events, its stderr tail and its workspace path. On the
   * single long-lived API VISION §11 designs for, that is a leak measured in
   * weeks.
   *
   * The retention window is not decoration: a finished run's terminal event
   * lives in `pending` until someone polls for it, and reaping on the tick it
   * exits would throw away the very event that says how it ended. Anything
   * still holding unpolled events is kept regardless of age, so the only runs
   * dropped are ones whose ending has already been collected.
   */
  private reapFinishedRuns(): void {
    const cutoff = Date.now() - FINISHED_RUN_RETENTION_MS;

    for (const [identity, run] of this.runs) {
      if (run.finishedAt === null) continue;
      if (run.pending.length > 0) continue;
      // Same reasoning one line up: an unpolled window sighting is the only
      // record of a reset instant nothing else observed.
      if (run.pendingQuota.length > 0) continue;
      if (run.finishedAt.getTime() > cutoff) continue;
      this.runs.delete(identity);
    }
  }

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
        // A `run.blocked` from a rate limit carries both facts at once: the
        // run is parked, and the window it is parked on rolls at a known time.
        if (mapping.quota) run.pendingQuota.push(mapping.quota);
        return;

      case 'quota':
        // A window sighting with no event — the CLI reporting rate-limit
        // status on a turn that was served. Recorded, not emitted: nothing
        // happened to the RUN.
        run.pendingQuota.push(mapping.quota);
        return;

      case 'result':
        // Recorded, not emitted. The exit code decides how the run ended; this
        // supplies the cost and the final text that ending carries.
        run.cliResult = mapping.result;
        return;

      case 'drop':
        if (!run.loggedDrops.has(mapping.reason)) {
          run.loggedDrops.add(mapping.reason);
          this.logger.debug(
            `${run.workOrder.identity}: dropped a line — ${mapping.reason}`,
          );
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
    return this.observedVersion
      ? `${this.key}@${this.observedVersion}`
      : this.key;
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
  private settle(
    run: LocalRun,
    outcome: NonNullable<ReturnType<SupervisedProcess['result']>>,
  ) {
    if (run.settled) return;
    run.settled = true;
    run.finishedAt = new Date();

    // The run is over; the deadline has nothing left to enforce. Left armed it
    // would hold a reference to the whole run for as long as the ceiling.
    if (run.deadlineTimer) {
      clearTimeout(run.deadlineTimer);
      run.deadlineTimer = undefined;
    }

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
          // policy (#66). A run something DECIDED to stop is the one case that
          // is definitely not worth repeating as-is; a run that merely ran out
          // of clock might well finish on a quieter machine, so a timeout stays
          // retryable even though the kill came from here.
          retryable:
            run.timedOut === true ||
            (!run.cancelRequested && outcome.kind !== 'spawn-failed'),
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
  private costOf(run: LocalRun): {
    cost?: { usd?: number; tokensInput?: number; tokensOutput?: number };
  } {
    const result = run.cliResult;
    if (!result) return {};

    const cost = {
      usd: result.costUsd,
      tokensInput: result.tokensInput,
      tokensOutput: result.tokensOutput,
    };

    return Object.values(cost).every((value) => value === undefined)
      ? {}
      : { cost };
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
    const parts = [
      `${run.workOrder.identity} exited cleanly after ${observed}`,
    ];

    const denials = run.cliResult?.permissionDenials ?? 0;
    if (denials > 0) parts.push(`${denials} permission denial(s)`);
    if (run.parseFailures > 0)
      parts.push(`${run.parseFailures} unparseable line(s)`);

    return parts.join(', ');
  }

  private failureReason(
    run: LocalRun,
    outcome: NonNullable<ReturnType<SupervisedProcess['result']>>,
  ): string {
    const stderr = run.process
      .stderr()
      .trim()
      .split('\n')
      .filter(Boolean)
      .pop();
    const detail = stderr ? `: ${stderr}` : '';

    switch (outcome.kind) {
      case 'spawn-failed':
        return `could not start ${this.binary}: ${outcome.error.message}`;
      case 'signalled':
        // A timeout and a cancel both arrive as a signal we sent, and #66
        // treats them differently: one is a run that was too slow, the other
        // is a run something decided to stop. Collapsing them would lose the
        // distinction at exactly the point a retry decision needs it.
        if (run.timedOut) {
          return `exceeded its wall-clock ceiling of ${run.deadlineMinutes} minute(s)`;
        }
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
        `Could not probe ${this.binary} --version; declaring ${this.key} unavailable`,
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
   * The ceiling applied to a work order that names none.
   *
   * A backstop rather than a policy. Most work orders should carry their own
   * (#62 writes it), but one that does not must not mean "run forever": VISION
   * §11 has these runs competing with a human for one quota, and the failure
   * this whole system exists to catch is *four hours dead* — which is what an
   * unbounded run looks like when it wedges.
   */
  private get defaultTimeoutMinutes(): number | null {
    const configured = this.config.get<number | null>(
      'runners.claudeCodeLocal.defaultTimeoutMinutes',
    );
    return configured ?? null;
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
    const configured = this.config.get<string>(
      'runners.claudeCodeLocal.permissionMode',
    );
    if (
      configured &&
      (PERMISSION_MODES as readonly string[]).includes(configured)
    ) {
      return configured as PermissionMode;
    }
    if (configured) {
      this.logger.warn(
        `Unknown permission mode "${configured}"; falling back to acceptEdits`,
      );
    }
    return 'acceptEdits';
  }
}

/**
 * How long a finished run is kept before reaping.
 *
 * Generous on purpose: it only has to outlast the gap between a run ending and
 * something polling for its terminal event, and a reap that raced that poll
 * would throw away the event saying how the run ended.
 */
export const FINISHED_RUN_RETENTION_MS = 15 * 60_000;

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
  /**
   * Quota windows seen since the last poll (#231).
   *
   * Drained like `pending` rather than accumulated: the control plane collapses
   * repeat sightings of one window into a single row with a count, so
   * re-delivering is harmless but pointless, and holding them would grow with
   * the run.
   */
  pendingQuota: RunnerQuotaObservation[];
  linesObserved: number;
  lastOutputAt: Date | null;
  settled: boolean;
  cancelRequested?: boolean;
  /** The CLI's own `result` line, folded into the terminal event on exit. */
  cliResult?: StreamResult;
  /** Line kinds already logged as unmappable — see `consumeLine`. */
  loggedDrops: Set<string>;
  parseFailures: number;
  /** Fires the wall-clock kill. Cleared the moment the process ends. */
  deadlineTimer?: NodeJS.Timeout;
  /** The ceiling actually applied, in minutes — the work order's or the default. */
  deadlineMinutes?: number;
  /** True when THIS runner stopped the run for exceeding its wall clock. */
  timedOut?: boolean;
  /** When the run ended, for reaping. Null while it is still going. */
  finishedAt: Date | null;
}
