import {
  RUNNER_SEAM_METHODS,
  type Runner,
  type RunnerCapabilities,
  type RunnerRunStatus,
  type RunHandle,
  type WorkOrderSpec,
} from '../../../src/runners/runner.types';
import type { RunEventPayload } from '../../../src/run-events/run-event.types';
import { explainErrors, validatorFor } from '../../schemas/contract-validators';

/**
 * The cross-runner conformance suite (#106, epic #23 phase 8).
 *
 * ## What this file is, and is not
 *
 * This is the reusable, config-driven engine. It registers no tests of its
 * own — `runRunnerConformanceSuite` does that, and only when a spec file
 * calls it. Following the precedent `apps/api/test/schemas/contract-validators.ts`
 * set for #36: a validator (or, here, a set of checks) exported from a spec
 * file cannot be imported without re-running every test inside it, which is
 * the opposite of reusable. So the checks live here, in a plain module, and
 * `apps/api/test/runners/runner-conformance.spec.ts` is the thin file that
 * actually calls `describe`/`it`.
 *
 * ## The seam this drives
 *
 * `apps/api/src/runners/runner.types.ts` — read it first. Every assertion
 * below traces to a sentence there:
 *
 * - "Exactly four functions; adding a fifth requires an ADR" (`Runner`,
 *   `RUNNER_SEAM_METHODS`) — `seam-shape`. The EXHAUSTIVE version of this
 *   check ("a fifth fails") is already asserted per-implementation in
 *   `runner.seam.spec.ts` (for `FakeRunner`) and
 *   `claude-code-local.runner.spec.ts` (for `ClaudeCodeLocalRunner`), each
 *   against that class's own internals list. Reproducing that generically
 *   here would mean threading an internals list through every config entry
 *   for a check the two implementation-specific specs already make a
 *   failing build — which is exactly the duplication the brief for #106
 *   says not to do ("do not duplicate it; absorb or reference it"). This
 *   suite's `seam-shape` check is the cross-runner FUNCTIONAL floor instead:
 *   all four methods present and callable on every configured runner.
 * - "Must be idempotent on `identity`" (`Runner.submit`) —
 *   `submit-idempotent-on-identity`.
 * - "Returns `status: 'unknown'` for a handle the runner does not
 *   recognise, rather than throwing" (`Runner.poll`) —
 *   `poll-unknown-handle-does-not-throw`.
 * - "Idempotent, and never throws for an already-stopped run"
 *   (`Runner.cancel`) — `cancel-idempotent-and-never-throws`.
 * - "`poll` returns normalized events... never a runner's native format"
 *   (`RunPollResult`) — `events-validate-against-schema-and-carry-run-id`.
 * - The full lifecycle, both branches — `full-lifecycle-submit-poll-complete`
 *   and `full-lifecycle-submit-cancel-mid-run`.
 * - The capability-gated tier (streaming fidelity, cost reporting, the
 *   rate-limit signal) traces to `RunnerCapabilities`'s own doc comments,
 *   gated by `appliesTo` so a runner honest about lacking a capability is
 *   never failed for it — see the module doc on `RUNNER_CONFORMANCE_CHECKS`.
 *
 * ## The seam for the overstatement trap (tier 3)
 *
 * `collectRunnerConformanceFindings` runs the exact same checks as
 * `runRunnerConformanceSuite`, but returns a plain array of
 * {@link ConformanceFinding} instead of calling `expect`. That is what lets
 * `runner-conformance-overstatement.spec.ts` assert "this configuration
 * produces a failure" as a value, rather than by making Jest fail on
 * purpose and asserting on ITS failure — which is not something a normal
 * spec can do without abusing the test runner. A suite that cannot
 * demonstrate its own failure mode is a suite nobody should trust; this is
 * the seam that lets it demonstrate it.
 */

// ---------------------------------------------------------------------------
// Public config shape — a third runner is one more of these, not new tests.
// ---------------------------------------------------------------------------

/** The three capability fields the capability-gated tier reads. */
export type ExpectedCapabilities = Pick<
  RunnerCapabilities,
  'streamingFidelity' | 'rateLimitSignal' | 'reportsCost'
>;

export interface RunnerConformanceRunResult {
  handle: RunHandle;
  status: RunnerRunStatus;
  events: RunEventPayload[];
}

/**
 * One exercisable instance of a runner, fresh for a single check.
 *
 * `runToCompletion` and `cancelMidRun` are the two scenarios #106 asks for —
 * "submit → poll to completion" and, separately, "submit → cancel mid-run" —
 * and are the ONLY place a config has to know how to make ITS runner
 * actually produce tool calls, cost and a rate-limit block. Everything else
 * in this module is runner-agnostic.
 */
export interface RunnerConformanceInstance {
  runner: Runner;
  /** A fresh, valid work order. Give the same object back to `submit` twice to test idempotency. */
  workOrder: (overrides?: Partial<WorkOrderSpec>) => WorkOrderSpec;
  /**
   * Submit the work order and drive it to a terminal status, arranging along
   * the way for whatever this runner is capable of: a tool call (for
   * `streamingFidelity: full`), a cost figure (for `reportsCost: true`) and a
   * rate-limit block carrying a reset time (for `rateLimitSignal:
   * structured`). A config that does not actually produce one of those is
   * how the overstatement trap (tier 3) is built.
   */
  runToCompletion: (
    workOrder: WorkOrderSpec,
  ) => Promise<RunnerConformanceRunResult>;
  /** Submit, then cancel before the run would otherwise finish on its own. */
  cancelMidRun: (
    workOrder: WorkOrderSpec,
  ) => Promise<RunnerConformanceRunResult>;
  /** Release anything this one instance holds (a process, a workspace). */
  dispose: () => Promise<void>;
}

export interface RunnerConformanceConfig {
  /** Shown as the `describe` label and in every finding. */
  label: string;
  /**
   * What this runner's manifest is expected to declare. Used at Jest
   * REGISTRATION time to decide which tier-2 `it()`s exist at all — Jest
   * cannot register tests from an awaited value, since `describe` callbacks
   * run synchronously, so this has to be supplied rather than derived from
   * `capabilities()`. `capabilities-match-declared-expectation` (tier 1)
   * then calls the runner for real and asserts it actually reports this, so
   * a config that lied about ITS OWN expectation here is caught rather than
   * silently gating the wrong tests in.
   */
  expectedCapabilities: ExpectedCapabilities;
  /** Build one fresh, isolated instance to exercise. Called once per check. */
  createInstance: () => Promise<RunnerConformanceInstance>;
  /** Called once after every applicable check has run — for shared, expensive setup (a git origin, a scratch directory). */
  disposeAll?: () => Promise<void>;
  /** Per-check Jest timeout. Longer for configs that spawn a real process. */
  testTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Findings — the seam that lets tier 3 assert a failure as a value.
// ---------------------------------------------------------------------------

export interface ConformanceFinding {
  id: string;
  tier: 1 | 2;
  description: string;
  passed: boolean;
  detail: string;
}

type CheckOutcome = { passed: boolean; detail: string };

interface RunnerConformanceCheck {
  id: string;
  tier: 1 | 2;
  description: string;
  /** Absent means tier 1: always applicable. Present means tier 2: gated on the manifest actually claiming it. */
  appliesTo?: (expected: ExpectedCapabilities) => boolean;
  run: (
    instance: RunnerConformanceInstance,
    expected: ExpectedCapabilities,
  ) => Promise<CheckOutcome>;
}

const ok = (detail = 'ok'): CheckOutcome => ({ passed: true, detail });
const fail = (detail: string): CheckOutcome => ({ passed: false, detail });

// ---------------------------------------------------------------------------
// Tier 1 — the common floor, asserted for every runner.
// ---------------------------------------------------------------------------

const TIER_1_CHECKS: RunnerConformanceCheck[] = [
  {
    id: 'seam-shape',
    tier: 1,
    description:
      'implements the four seam methods, each callable (exhaustive "no fifth method" shape lives in runner.seam.spec.ts / claude-code-local.runner.spec.ts)',
    run: async (instance) => {
      const runnerAsRecord = instance.runner as unknown as Record<
        string,
        unknown
      >;
      const missing = RUNNER_SEAM_METHODS.filter(
        (name) => typeof runnerAsRecord[name] !== 'function',
      );
      if (missing.length > 0) {
        return fail(`missing seam method(s): ${missing.join(', ')}`);
      }
      return ok();
    },
  },
  {
    id: 'capabilities-validate-against-schema',
    tier: 1,
    description:
      'capabilities() returns a manifest that validates against runner-capability.schema.json',
    run: async (instance) => {
      const capabilities = await instance.runner.capabilities();
      const validate = validatorFor('runner-capability');
      if (!validate(capabilities.manifest)) {
        return fail(
          `manifest failed schema validation: ${explainErrors(validate)}`,
        );
      }
      return ok();
    },
  },
  {
    id: 'capabilities-match-declared-expectation',
    tier: 1,
    description:
      'capabilities() actually reports what this config declared — keeping tier-2 gating honest',
    run: async (instance, expected) => {
      const capabilities = await instance.runner.capabilities();
      const mismatches: string[] = [];
      if (capabilities.streamingFidelity !== expected.streamingFidelity) {
        mismatches.push(
          `streamingFidelity: expected '${expected.streamingFidelity}', got '${capabilities.streamingFidelity}'`,
        );
      }
      if (capabilities.rateLimitSignal !== expected.rateLimitSignal) {
        mismatches.push(
          `rateLimitSignal: expected '${expected.rateLimitSignal}', got '${capabilities.rateLimitSignal}'`,
        );
      }
      if (capabilities.reportsCost !== expected.reportsCost) {
        mismatches.push(
          `reportsCost: expected ${expected.reportsCost}, got ${capabilities.reportsCost}`,
        );
      }
      if (mismatches.length > 0) return fail(mismatches.join('; '));
      return ok();
    },
  },
  {
    id: 'submit-idempotent-on-identity',
    tier: 1,
    description:
      're-submitting the same work-order identity returns the existing handle, not a second run',
    run: async (instance) => {
      const workOrder = instance.workOrder();
      const first = await instance.runner.submit(workOrder);
      const second = await instance.runner.submit(workOrder);
      if (JSON.stringify(first) !== JSON.stringify(second)) {
        return fail(
          `re-submitting ${workOrder.identity} produced a different handle: ` +
            `${JSON.stringify(first)} vs ${JSON.stringify(second)}`,
        );
      }
      return ok();
    },
  },
  {
    id: 'poll-unknown-handle-does-not-throw',
    tier: 1,
    description:
      'poll on a handle the runner never issued returns status "unknown" rather than throwing',
    run: async (instance) => {
      let result;
      try {
        result = await instance.runner.poll({
          runnerKey: 'runner-conformance',
          externalId: 'never-issued',
          workOrderIdentity: 'wo_conformance_never_submitted_poll',
        });
      } catch (error) {
        return fail(
          `poll on an unrecognised handle threw instead of returning 'unknown': ${describeError(error)}`,
        );
      }
      if (result.status !== 'unknown') {
        return fail(`expected status 'unknown', got '${result.status}'`);
      }
      if (result.events.length !== 0) {
        return fail(
          `expected no events for an unrecognised handle, got ${result.events.length}`,
        );
      }
      return ok();
    },
  },
  {
    id: 'cancel-idempotent-and-never-throws',
    tier: 1,
    description:
      'cancel is idempotent and never throws — for an already-stopped run, a second cancel, or a handle never submitted',
    run: async (instance) => {
      const workOrder = instance.workOrder();
      const { handle } = await instance.runToCompletion(workOrder);

      try {
        await instance.runner.cancel(handle);
      } catch (error) {
        return fail(
          `cancel on an already-finished run threw: ${describeError(error)}`,
        );
      }
      try {
        await instance.runner.cancel(handle);
      } catch (error) {
        return fail(`a second cancel threw: ${describeError(error)}`);
      }
      try {
        await instance.runner.cancel({
          runnerKey: 'runner-conformance',
          externalId: 'never-issued',
          workOrderIdentity: 'wo_conformance_never_submitted_cancel',
        });
      } catch (error) {
        return fail(
          `cancel on a handle never submitted threw: ${describeError(error)}`,
        );
      }
      return ok();
    },
  },
  {
    id: 'events-validate-against-schema-and-carry-run-id',
    tier: 1,
    description:
      'every event poll returns validates against run-event.schema.json and carries the submitted runId',
    run: async (instance) => {
      const workOrder = instance.workOrder();
      const { events } = await instance.runToCompletion(workOrder);
      if (events.length === 0) return fail('no events were observed at all');

      const validate = validatorFor('run-event');
      for (const event of events) {
        // Stored rather than tested inline: `validate` is typed as a type
        // predicate over `unknown`, and testing it directly in the `if`
        // would narrow `event` to `never` in the failing branch — the
        // predicate is genuinely true for anything, so its NEGATION carries
        // no information about `event`'s own (already-known) shape.
        const eventIsSchemaValid: boolean = validate(event);
        if (!eventIsSchemaValid) {
          return fail(
            `event ${event.type} (${event.eventId}) failed schema validation: ${explainErrors(validate)}`,
          );
        }
        if (event.runId !== workOrder.runId) {
          return fail(
            `event ${event.eventId} carried runId '${event.runId}', expected the submitted runId '${workOrder.runId}' — a runner leaking its native id would fail ingestion, which correlates on this field`,
          );
        }
      }
      return ok();
    },
  },
  {
    id: 'full-lifecycle-submit-poll-complete',
    tier: 1,
    description:
      'a full lifecycle — submit, poll to a terminal status, with at least one terminal event',
    run: async (instance) => {
      const workOrder = instance.workOrder();
      const { status, events } = await instance.runToCompletion(workOrder);
      if (status === 'running' || status === 'unknown') {
        return fail(
          `run never reached a terminal status; last saw '${status}'`,
        );
      }
      if (
        !events.some(
          (event) =>
            event.type === 'run.completed' || event.type === 'run.failed',
        )
      ) {
        return fail(
          'no terminal event (run.completed or run.failed) was ever observed',
        );
      }
      return ok();
    },
  },
  {
    id: 'full-lifecycle-submit-cancel-mid-run',
    tier: 1,
    description:
      'a full lifecycle — submit, cancel mid-run, and the run ends rather than hanging',
    run: async (instance) => {
      const workOrder = instance.workOrder();
      const { status, events } = await instance.cancelMidRun(workOrder);
      if (status === 'running') {
        return fail('the run was still reported running after cancel');
      }
      if (!events.some((event) => event.type === 'run.failed')) {
        return fail('cancelling mid-run produced no run.failed event');
      }
      return ok();
    },
  },
];

// ---------------------------------------------------------------------------
// Tier 2 — capability-gated, run only where the manifest claims it.
//
// `streamingFidelity: 'none'` gets NO entry here at all, deliberately —
// #106: "no event-stream assertion at all. Not a weakened one. Zero." A
// runner honest about having nothing to show is not asked to show it.
// ---------------------------------------------------------------------------

const TIER_2_CHECKS: RunnerConformanceCheck[] = [
  {
    id: 'streaming-full-carries-tool-detail',
    tier: 2,
    description:
      'streamingFidelity: full — the event stream carries per-tool-call detail (name + argument signature), which is what loop-detection.ts consumes',
    appliesTo: (expected) => expected.streamingFidelity === 'full',
    run: async (instance) => {
      const { events } = await instance.runToCompletion(instance.workOrder());
      const withToolDetail = events.find(
        (event) => Boolean(event.tool?.name) && Boolean(event.tool?.signature),
      );
      if (!withToolDetail) {
        return fail(
          'declared streamingFidelity "full" but no event carried a tool name and argument signature',
        );
      }
      return ok();
    },
  },
  {
    id: 'streaming-partial-carries-coarse-progress',
    tier: 2,
    description:
      'streamingFidelity: partial — coarse progress arrives, even though per-tool-call detail is not required',
    appliesTo: (expected) => expected.streamingFidelity === 'partial',
    run: async (instance) => {
      const { events } = await instance.runToCompletion(instance.workOrder());
      const coarseProgress = events.filter(
        (event) => event.type !== 'run.started',
      );
      if (coarseProgress.length === 0) {
        return fail(
          'declared streamingFidelity "partial" but no progress of any kind arrived after run.started',
        );
      }
      return ok();
    },
  },
  {
    id: 'reports-cost-appears-on-some-event',
    tier: 2,
    description: 'reportsCost: true — a cost actually appears on some event',
    appliesTo: (expected) => expected.reportsCost === true,
    run: async (instance) => {
      const { events } = await instance.runToCompletion(instance.workOrder());
      const withCost = events.find(
        (event) => typeof event.cost?.usd === 'number',
      );
      if (!withCost) {
        return fail(
          'declared reportsCost: true but no event carried a usd cost',
        );
      }
      return ok();
    },
  },
  {
    id: 'rate-limit-structured-blocked-event-has-reset-time',
    tier: 2,
    description:
      'rateLimitSignal: structured — a blocked event carries a machine-readable reset time',
    appliesTo: (expected) => expected.rateLimitSignal === 'structured',
    run: async (instance) => {
      const { events } = await instance.runToCompletion(instance.workOrder());
      const blocked = events.find((event) => event.type === 'run.blocked');
      if (!blocked) {
        return fail(
          'declared rateLimitSignal "structured" but the scenario produced no run.blocked event',
        );
      }
      if (!blocked.blocked?.resetAt) {
        return fail(
          'declared rateLimitSignal "structured" but the run.blocked event carried no resetAt',
        );
      }
      return ok();
    },
  },
];

export const RUNNER_CONFORMANCE_CHECKS: readonly RunnerConformanceCheck[] = [
  ...TIER_1_CHECKS,
  ...TIER_2_CHECKS,
];

function applicableChecks(
  expected: ExpectedCapabilities,
): RunnerConformanceCheck[] {
  return RUNNER_CONFORMANCE_CHECKS.filter(
    (check) => !check.appliesTo || check.appliesTo(expected),
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// The two public entry points.
// ---------------------------------------------------------------------------

/**
 * Runs every applicable check and returns what happened, as data.
 *
 * No `expect`, no `describe`/`it` — this is the seam tier 3 needs: a meta-test
 * can call this against a `FakeRunner` config whose manifest lies, and assert
 * on the resulting {@link ConformanceFinding}s directly, rather than needing
 * Jest itself to fail on purpose. A check that throws unexpectedly (a process
 * that could not spawn, for instance) is folded into a failed finding rather
 * than propagating, so a caller never has to wrap this in its own try/catch.
 */
export async function collectRunnerConformanceFindings(
  config: RunnerConformanceConfig,
): Promise<ConformanceFinding[]> {
  const findings: ConformanceFinding[] = [];

  for (const check of applicableChecks(config.expectedCapabilities)) {
    const instance = await config.createInstance();
    try {
      const outcome = await check.run(instance, config.expectedCapabilities);
      findings.push({
        id: check.id,
        tier: check.tier,
        description: check.description,
        ...outcome,
      });
    } catch (error) {
      findings.push({
        id: check.id,
        tier: check.tier,
        description: check.description,
        passed: false,
        detail: `threw instead of completing: ${describeError(error)}`,
      });
    } finally {
      await instance.dispose();
    }
  }

  await config.disposeAll?.();
  return findings;
}

/**
 * Registers one applicable Jest `it()` per check, inside a `describe` named
 * after the config. This is the whole contract a third runner has to meet:
 * add a {@link RunnerConformanceConfig} to the array a spec file passes
 * through this function, and it is in the suite — no new test code.
 */
export function runRunnerConformanceSuite(
  config: RunnerConformanceConfig,
): void {
  describe(config.label, () => {
    const timeoutMs = config.testTimeoutMs ?? 10_000;

    afterAll(async () => {
      await config.disposeAll?.();
    });

    for (const check of applicableChecks(config.expectedCapabilities)) {
      it(
        `[tier ${check.tier}] ${check.description}`,
        async () => {
          const instance = await config.createInstance();
          try {
            const outcome = await check.run(
              instance,
              config.expectedCapabilities,
            );
            if (!outcome.passed) {
              throw new Error(`${check.id}: ${outcome.detail}`);
            }
          } finally {
            await instance.dispose();
          }
        },
        timeoutMs,
      );
    }
  });
}
