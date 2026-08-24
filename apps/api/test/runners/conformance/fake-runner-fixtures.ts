import { randomUUID } from 'node:crypto';

import { FakeRunner } from '../../../src/runners/fake-runner';
import type {
  RunnerCapabilities,
  WorkOrderSpec,
} from '../../../src/runners/runner.types';
import type {
  ExpectedCapabilities,
  RunnerConformanceConfig,
  RunnerConformanceInstance,
} from './runner-conformance-suite';

/**
 * `FakeRunner`-backed conformance configs (#106).
 *
 * `FakeRunner` (`apps/api/src/runners/fake-runner.ts`) takes a
 * `FakeRunnerConfig.capabilities` override, which is the lever #106 asks for
 * — "this is your lever for constructing runners with any declared
 * capability profile." Two HONEST profiles live here (a high-capability one
 * and the near-zero-streaming one standing in for what `claude-code-cloud`
 * would have been — see `claude-code-local-fixture.ts`'s doc comment for why
 * that runner does not exist yet). Three LYING profiles also live here, each
 * declaring a capability its scenario deliberately does not deliver, for the
 * overstatement trap in `runner-conformance-overstatement.spec.ts` (tier 3).
 * They are NOT included in `runner-conformance.spec.ts`'s config array —
 * that suite is the one every real runner is expected to PASS.
 */

let sequence = 0;

function baseWorkOrder(overrides: Partial<WorkOrderSpec> = {}): WorkOrderSpec {
  sequence += 1;
  return {
    identity: `wo_conformance_fake_${Date.now()}_${sequence}`,
    runId: randomUUID(),
    repository: { owner: 'opifex', name: 'conformance-fixture' },
    baseCommit: 'a3f91c2000000000000000000000000000000000',
    branch: `factory/conformance-fake-${sequence}`,
    taskSpec: 'Cross-runner conformance probe (#106) — no real work is done.',
    acceptanceCriteria: ['n/a — conformance probe'],
    pathConstraints: [],
    budgetCeilingUsd: 5,
    wallClockTimeoutMinutes: 30,
    needs: [],
    ...overrides,
  };
}

interface FakeRunnerScenario {
  key: string;
  displayName: string;
  capabilities: ExpectedCapabilities;
  /** Whether `runToCompletion` emits a `run.progress` event with tool detail. */
  emitToolDetail: boolean;
  /** Whether `runToCompletion` attaches a cost figure to its terminal event. */
  emitCost: boolean;
  /**
   * How the scenario blocks, if at all. `'with-reset'` and `'without-reset'`
   * both emit a `run.blocked` event; only the first carries `resetAt`. This is
   * the knob the rate-limit overstatement config turns.
   */
  blockedMode: 'with-reset' | 'without-reset' | 'never';
  /** Required by the schema whenever `reportsCost` is false. */
  notesWhenNoCost?: string;
}

/**
 * Builds the manifest object `capabilities().manifest` returns, from the same
 * fields the typed `RunnerCapabilities` declares — the same "one set of
 * facts, not two hand-maintained copies" approach
 * `ClaudeCodeLocalRunner.capabilities()` uses, so the manifest can never say
 * something different from what routing actually reads.
 */
function manifestFor(scenario: FakeRunnerScenario): Record<string, unknown> {
  const manifest: Record<string, unknown> = {
    schemaVersion: '1.0.0',
    key: scenario.key,
    displayName: scenario.displayName,
    version: '0.0.0',
    invocationModel: 'process',
    executionLocus: 'own_infrastructure',
    streamingFidelity: scenario.capabilities.streamingFidelity,
    rateLimitSignal: scenario.capabilities.rateLimitSignal,
    stabilityTier: 'experimental',
    reportsCost: scenario.capabilities.reportsCost,
    resumable: false,
    maxConcurrency: 4,
    branchPatterns: ['factory/*'],
  };

  // runner-capability.schema.json requires `notes` whenever reportsCost is
  // false — a budget ceiling nobody can enforce is worse than an absent one,
  // because it looks like a control.
  if (!scenario.capabilities.reportsCost) {
    manifest.notes =
      scenario.notesWhenNoCost ??
      'This profile does not report cost; a budget ceiling would be decorative.';
  }

  return manifest;
}

function capabilitiesOverride(
  scenario: FakeRunnerScenario,
): Partial<RunnerCapabilities> {
  return {
    key: scenario.key,
    displayName: scenario.displayName,
    streamingFidelity: scenario.capabilities.streamingFidelity,
    rateLimitSignal: scenario.capabilities.rateLimitSignal,
    reportsCost: scenario.capabilities.reportsCost,
    manifest: manifestFor(scenario),
  };
}

function createFakeRunnerInstance(
  scenario: FakeRunnerScenario,
): RunnerConformanceInstance {
  const runner = new FakeRunner({
    capabilities: capabilitiesOverride(scenario),
  });

  const applyBlock = (identity: string): void => {
    if (scenario.blockedMode === 'never') return;
    if (scenario.blockedMode === 'with-reset') {
      runner.block(identity, new Date(Date.now() + 3_600_000).toISOString());
      return;
    }
    // 'without-reset': FakeRunner.block() always sets a resetAt, so the
    // no-reset case is driven through the lower-level `emit`, which is the
    // shape a runner overstating a structured rate-limit signal would
    // actually produce — a run.blocked event with a reason and nothing else.
    runner.emit(identity, {
      type: 'run.blocked',
      blocked: { reason: 'rate-limit' },
    });
  };

  return {
    runner,
    workOrder: (overrides = {}) => baseWorkOrder(overrides),
    async runToCompletion(workOrder) {
      const handle = await runner.submit(workOrder);
      applyBlock(workOrder.identity);

      if (scenario.emitToolDetail) {
        runner.emit(workOrder.identity, {
          type: 'run.progress',
          tool: { name: 'Bash', signature: 'sha256:deadbeefcafe' },
        });
      } else {
        runner.emit(workOrder.identity, {
          type: 'run.heartbeat',
          summary: 'still working',
        });
      }

      runner.finish(
        workOrder.identity,
        'succeeded',
        scenario.emitCost
          ? {
              result: { branch: workOrder.branch },
              cost: { usd: 0.05, tokensInput: 100, tokensOutput: 50 },
            }
          : { result: { branch: workOrder.branch } },
      );

      const result = await runner.poll(handle);
      return { handle, status: result.status, events: result.events };
    },
    async cancelMidRun(workOrder) {
      const handle = await runner.submit(workOrder);
      await runner.cancel(handle);
      const result = await runner.poll(handle);
      return { handle, status: result.status, events: result.events };
    },
    async dispose() {
      // FakeRunner touches no process, no filesystem — nothing to release.
    },
  };
}

function fakeRunnerConfig(
  scenario: FakeRunnerScenario,
): RunnerConformanceConfig {
  return {
    label: `FakeRunner — ${scenario.displayName}`,
    expectedCapabilities: scenario.capabilities,
    createInstance: async () => createFakeRunnerInstance(scenario),
  };
}

// ---------------------------------------------------------------------------
// The two honest profiles — both go in `runner-conformance.spec.ts`.
// ---------------------------------------------------------------------------

/**
 * The high-capability profile: full streaming, structured rate limits, cost
 * reporting. Every tier-2 check applies and every one is delivered.
 */
export function capableFakeRunnerConfig(): RunnerConformanceConfig {
  return fakeRunnerConfig({
    key: 'fake-runner-capable',
    displayName: 'high-capability profile (full / structured / cost-reporting)',
    capabilities: {
      streamingFidelity: 'full',
      rateLimitSignal: 'structured',
      reportsCost: true,
    },
    emitToolDetail: true,
    emitCost: true,
    blockedMode: 'with-reset',
  });
}

/**
 * The near-zero-streaming profile — standing in for what `claude-code-cloud`
 * would have been (#102 is blocked on the vendor CLI's `--cloud`/`--print`
 * conflict; see `claude-code-local-fixture.ts`). No tier-2 check applies to
 * this config at all: that is the point. #106: "requiring tool-loop detection
 * from a near-zero-streaming runner would fail it for being honest about what
 * it cannot do."
 */
export function nearZeroFakeRunnerConfig(): RunnerConformanceConfig {
  return fakeRunnerConfig({
    key: 'fake-runner-near-zero',
    displayName:
      'near-zero-streaming profile (none / none / no cost reporting)',
    capabilities: {
      streamingFidelity: 'none',
      rateLimitSignal: 'none',
      reportsCost: false,
    },
    emitToolDetail: false,
    emitCost: false,
    blockedMode: 'never',
    notesWhenNoCost:
      'Stand-in for claude-code-cloud (#102): no event stream, no structured rate-limit signal, no machine-readable cost — see the vendor-blocker comment on that issue.',
  });
}

// ---------------------------------------------------------------------------
// The three lying profiles — tier 3 only. Never passed to
// `runRunnerConformanceSuite` in the main suite; only ever driven through
// `collectRunnerConformanceFindings` from the overstatement spec.
// ---------------------------------------------------------------------------

/** Declares `streamingFidelity: 'full'`, delivers no tool detail. */
export function lyingStreamingFullConfig(): RunnerConformanceConfig {
  return fakeRunnerConfig({
    key: 'fake-runner-lying-streaming',
    displayName: 'LYING profile — claims full streaming, delivers none',
    capabilities: {
      streamingFidelity: 'full',
      rateLimitSignal: 'structured',
      reportsCost: true,
    },
    emitToolDetail: false,
    emitCost: true,
    blockedMode: 'with-reset',
  });
}

/** Declares `reportsCost: true`, never reports a cost. */
export function lyingReportsCostConfig(): RunnerConformanceConfig {
  return fakeRunnerConfig({
    key: 'fake-runner-lying-cost',
    displayName: 'LYING profile — claims cost reporting, never reports one',
    capabilities: {
      streamingFidelity: 'full',
      rateLimitSignal: 'structured',
      reportsCost: true,
    },
    emitToolDetail: true,
    emitCost: false,
    blockedMode: 'with-reset',
  });
}

/** Declares `rateLimitSignal: 'structured'`, blocks without a reset time. */
export function lyingRateLimitStructuredConfig(): RunnerConformanceConfig {
  return fakeRunnerConfig({
    key: 'fake-runner-lying-rate-limit',
    displayName:
      'LYING profile — claims structured rate limits, blocks with no reset time',
    capabilities: {
      streamingFidelity: 'full',
      rateLimitSignal: 'structured',
      reportsCost: true,
    },
    emitToolDetail: true,
    emitCost: true,
    blockedMode: 'without-reset',
  });
}
