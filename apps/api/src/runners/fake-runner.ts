import { randomUUID } from 'node:crypto';

import { RUN_EVENT_SCHEMA_VERSION, type RunEventPayload } from '../run-events/run-event.types';
import type {
  RunHandle,
  Runner,
  RunnerCapabilities,
  RunPollResult,
  RunnerRunStatus,
  WorkOrderSpec,
} from './runner.types';

/**
 * A runner that runs nothing.
 *
 * #60's fourth acceptance criterion: *"a test double implementing the seam can
 * drive the whole dispatch path."* That is not a testing convenience, it is
 * the proof the seam is real — if dispatch cannot be driven end to end by
 * something with no vendor behind it at all, then dispatch depends on
 * something the seam does not express, and the abstraction is fictional.
 *
 * It lives in `src/` rather than `test/` deliberately: dispatch (#64), budget
 * enforcement (#65) and the run-summary comment (#67) all need something to
 * dispatch TO, and each writing its own stub would let four subtly different
 * ideas of the contract grow. There is also a real use for it later — a
 * dry-run mode that exercises the whole pipeline without spending money.
 *
 * It never touches git, never spawns a process, and never costs anything.
 */
export class FakeRunner implements Runner {
  private readonly runs = new Map<string, FakeRun>();

  constructor(private readonly config: FakeRunnerConfig = {}) {}

  /**
   * Idempotent on `identity`, exactly as a real runner must be.
   *
   * #18: *"re-running the same work order is idempotent — the runner checks
   * whether its branch already exists before doing anything."* Modelled here
   * so that a dispatch path which double-submits fails against the double
   * rather than against production.
   */
  async submit(workOrder: WorkOrderSpec): Promise<RunHandle> {
    if (this.config.failSubmit) {
      throw new Error(this.config.failSubmit);
    }

    const existing = this.runs.get(workOrder.identity);
    if (existing) return existing.handle;

    const handle: RunHandle = {
      runnerKey: this.key,
      externalId: `fake-${randomUUID()}`,
      workOrderIdentity: workOrder.identity,
    };

    const run: FakeRun = {
      handle,
      workOrder,
      status: 'running',
      // Queued rather than returned immediately: a runner reports that it
      // started through the event stream like everything else, and a dispatch
      // path that assumed otherwise would break on a real one.
      pending: [
        this.event(handle, workOrder, 'run.started', {
          summary: `Started ${workOrder.identity} from ${workOrder.baseCommit.slice(0, 7)}`,
        }),
      ],
      delivered: [],
    };

    this.runs.set(workOrder.identity, run);
    return handle;
  }

  /**
   * Drains whatever has been queued since the last poll.
   *
   * An unrecognised handle yields `unknown` rather than throwing — a runner
   * restarted between submit and poll has genuinely lost the run, and that is
   * a fact the watchdog must be able to observe. An exception would be
   * indistinguishable from the runner being down, and the two call for
   * different responses.
   */
  async poll(handle: RunHandle): Promise<RunPollResult> {
    const run = this.runs.get(handle.workOrderIdentity);
    if (!run) return { status: 'unknown', events: [] };

    const events = run.pending;
    run.pending = [];
    run.delivered.push(...events);

    return { status: run.status, events };
  }

  /** Idempotent, and silent about a run that is already over or was never here. */
  async cancel(handle: RunHandle): Promise<void> {
    const run = this.runs.get(handle.workOrderIdentity);
    if (!run || run.status !== 'running') return;

    run.status = 'failed';
    run.pending.push(
      this.event(run.handle, run.workOrder, 'run.failed', {
        summary: 'Cancelled by the control plane',
        failure: { reason: 'cancelled', retryable: true },
      }),
    );
  }

  async capabilities(): Promise<RunnerCapabilities> {
    return {
      key: this.key,
      displayName: 'Fake runner (executes nothing)',
      version: '0.0.0',
      schemaVersion: '1.0.0',
      invocationModel: 'process',
      executionLocus: 'own_infrastructure',
      streamingFidelity: 'full',
      rateLimitSignal: 'structured',
      // Never `stable`. Routing that would hand real work to this thing should
      // have to opt in loudly.
      stabilityTier: 'experimental',
      reportsCost: true,
      resumable: false,
      maxConcurrency: 4,
      branchPatterns: ['factory/*'],
      manifest: {},
      ...this.config.capabilities,
    };
  }

  // -------------------------------------------------------------------------
  // Steering, for tests. Not part of the seam.
  // -------------------------------------------------------------------------

  /** Queue an arbitrary event for the next poll. */
  emit(identity: string, event: Partial<RunEventPayload> & { type: RunEventPayload['type'] }): void {
    const run = this.require(identity);
    run.pending.push(this.event(run.handle, run.workOrder, event.type, event));
  }

  /** Drive the run to a terminal state, with the event that says so. */
  finish(
    identity: string,
    outcome: 'succeeded' | 'failed',
    detail: Partial<RunEventPayload> = {},
  ): void {
    const run = this.require(identity);
    run.status = outcome;
    run.pending.push(
      this.event(
        run.handle,
        run.workOrder,
        outcome === 'succeeded' ? 'run.completed' : 'run.failed',
        detail,
      ),
    );
  }

  /** Park it, as a rate limit would. */
  block(identity: string, resetAt: string): void {
    const run = this.require(identity);
    run.status = 'blocked';
    run.pending.push(
      this.event(run.handle, run.workOrder, 'run.blocked', {
        summary: 'Rate limited',
        blocked: { reason: 'rate-limit', resetAt },
      }),
    );
  }

  /** Every event this runner has handed over, for assertions. */
  delivered(identity: string): RunEventPayload[] {
    return this.require(identity).delivered;
  }

  /** Whether a work order was ever submitted. */
  has(identity: string): boolean {
    return this.runs.has(identity);
  }

  private get key(): string {
    return this.config.capabilities?.key ?? 'fake-runner';
  }

  private require(identity: string): FakeRun {
    const run = this.runs.get(identity);
    if (!run) throw new Error(`FakeRunner has no run for ${identity} — submit it first`);
    return run;
  }

  /**
   * Every event is schema-shaped.
   *
   * The double's whole value is that code written against it works against a
   * real runner. An event here that the run-event schema would reject would
   * make the double a liar, so a spec validates these against the real schema
   * file rather than trusting this function.
   */
  private event(
    handle: RunHandle,
    workOrder: WorkOrderSpec,
    type: RunEventPayload['type'],
    extra: Partial<RunEventPayload> = {},
  ): RunEventPayload {
    const { type: _ignored, ...rest } = extra;

    return {
      schemaVersion: RUN_EVENT_SCHEMA_VERSION,
      eventId: `evt_${randomUUID()}`,
      // The CONTROL PLANE's run id, not `handle.externalId`. Ingestion
      // correlates on this, and the schema requires a UUID — a runner that
      // stamped its own native id here would have every event rejected.
      runId: workOrder.runId,
      workOrderId: workOrder.identity,
      type,
      // Always `runner-reported`. VISION §9 forbids a synthesized event
      // masquerading as a report, and a double that reported as the control
      // plane would train the code that consumes it to accept exactly that.
      source: 'runner-reported',
      occurredAt: this.config.now?.().toISOString() ?? new Date().toISOString(),
      runner: this.key,
      ...rest,
    };
  }
}

export interface FakeRunnerConfig {
  /** Override any part of the declared capabilities. */
  capabilities?: Partial<RunnerCapabilities>;
  /** Make `submit` throw with this message, to exercise the failure path. */
  failSubmit?: string;
  /** Injectable clock, so event ordering in tests is deterministic. */
  now?: () => Date;
}

interface FakeRun {
  handle: RunHandle;
  workOrder: WorkOrderSpec;
  status: RunnerRunStatus;
  pending: RunEventPayload[];
  delivered: RunEventPayload[];
}
