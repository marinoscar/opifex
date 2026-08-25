import { INPUT_LABELS } from '../../src/github/labels/factory-labels';
import type { NormalizedIssue } from '../../src/github/read/github-read.types';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { WorkOrderProjectionService } from '../../src/work-orders/work-order-projection.service';
import {
  rehydrateWorkOrder,
  type StoredWorkOrder,
} from '../../src/work-orders/work-order-rehydrate';
import {
  decideDispatch,
  type DispatchLimits,
  type RunnerPoolEntry,
} from '../../src/dispatch/dispatch-policy';
import type { RunnerCapabilities } from '../../src/runners/runner.types';

/**
 * The whole route a model tier travels, in one test (#273).
 *
 * ## Why this exists, next to five suites that already pass
 *
 * `issue-projection.spec.ts`, `work-order-generator.spec.ts`,
 * `work-order-projection.service.spec.ts`, `work-order-rehydrate.spec.ts` and
 * `dispatch-policy.spec.ts` each cover their own link in isolation, and every
 * one of them is green. #273 happened anyway: `WorkOrderSpec.modelTier` had
 * existed since #205 and had never carried a value through production, because
 * nothing tested the JOINS — only the links. A column can be silently dropped
 * between any two individually-tested functions and nothing above would
 * notice, which is exactly what `work_orders` having no `model_tier` column
 * at all looked like from inside every one of those five suites.
 *
 * So this is the one test that chains the real production functions in
 * their real order — label read, projection, persistence, rehydration,
 * routing — with only Prisma doubled, the same plain-stub convention
 * `work-order-projection.service.spec.ts` and
 * `test/integration/reconciler.integration.spec.ts` already use. Nothing
 * here reimplements a rule; it only refuses to let a wire between two
 * already-correct pieces go untested again.
 *
 * ## Placement
 *
 * Not colocated with any one of the five files above — it belongs to none of
 * them more than the others, and dropping it next to one would make it look
 * like that unit's test when what it checks is the seam. `test/governing/`
 * and `test/integration/` already hold whole-chain tests that import
 * production code directly from `src/` with Prisma stubbed by hand rather
 * than through `createTestApp`'s mocked database (that harness answers "does
 * the HTTP layer wire up correctly", not "does this value survive five
 * functions" — the wrong tool for a chain with no controller in it). This
 * follows that precedent as `test/work-orders/`, grouped with the area it
 * covers the way `test/auth/`, `test/rbac/` and `test/storage/` are.
 */
describe('a model tier, from a GitHub label to a dispatch refusal', () => {
  const REPOSITORY = {
    id: 'repo-uuid',
    owner: 'marinoscar',
    name: 'opifex',
    budgetCeilingUsd: null as number | null,
  };
  const BASE_COMMIT = 'a3f91c2000000000000000000000000000000000';

  const label = (name: string) => ({
    name,
    color: 'ededed',
    description: null,
  });

  const BODY = `## Problem statement

Searching for permits by address is not possible today.

## Proposed solution

Add a permit search prompt builder to the chat surface.

## Acceptance criteria

- [ ] Searching by a street address returns the matching permits
- [ ] An empty result set renders the documented empty state

## Affected component

\`apps/api/**\`

## Priority

P1
`;

  function issue(): NormalizedIssue {
    return {
      number: 312,
      title: 'Add a permit search prompt builder',
      body: BODY,
      state: 'open',
      author: 'marinoscar',
      // Link 1: the label a human actually applies on GitHub.
      labels: [label('feature'), label('tier:large')],
      inputLabels: [INPUT_LABELS.READY],
      unknownInputLabels: [],
    } as unknown as NormalizedIssue;
  }

  function capabilities(
    overrides: Partial<RunnerCapabilities> = {},
  ): RunnerCapabilities {
    return {
      key: 'small-only',
      displayName: 'Small-only runner',
      version: '1.0.0',
      schemaVersion: '1.0.0',
      invocationModel: 'process',
      executionLocus: 'own_infrastructure',
      streamingFidelity: 'full',
      rateLimitSignal: 'structured',
      stabilityTier: 'stable',
      reportsCost: true,
      resumable: false,
      maxConcurrency: 2,
      branchPatterns: ['factory/*'],
      manifest: {},
      // The pool entry the report chained against: a runner that serves
      // small only, asked to take a work order that asked for large.
      modelTiers: ['small'],
      ...overrides,
    } as RunnerCapabilities;
  }

  function pool(overrides: Partial<RunnerCapabilities> = {}): RunnerPoolEntry {
    return {
      capabilities: capabilities(overrides),
      enabled: true,
      liveRuns: 0,
    };
  }

  const NO_LIMIT: DispatchLimits = {
    globalMaxConcurrent: null,
    globalLiveRuns: 0,
  };

  /**
   * Runs all five links and returns what routing decided.
   *
   * Every step here is the real function. The only double is Prisma, stubbed
   * as a plain object the way `work-order-projection.service.spec.ts` and
   * `reconciler.integration.spec.ts` already do — `create` is a `jest.fn()`
   * whose call is read back out, not asserted against directly, because the
   * property under test is what happens to the value AFTER it is captured,
   * not that `create` was called.
   */
  async function runTheChain() {
    const create = jest.fn().mockResolvedValue({});
    const findUnique = jest.fn().mockResolvedValue(null);
    const service = new WorkOrderProjectionService({
      workOrder: { findUnique, create },
    } as unknown as PrismaService);

    // Links 1 + 2: `projectIssue` reads the `tier:large` label (link 1) and
    // `generateWorkOrder` folds it into a `GeneratedWorkOrder` (link 2) —
    // both run inside `project()`, exactly as production calls them.
    const result = await service.project({
      repository: REPOSITORY,
      issues: [issue()],
      existingWorkOrders: [],
      baseCommit: BASE_COMMIT,
    });

    expect(result.created).toHaveLength(1);
    expect(result.rejected).toEqual([]);

    // Link 3: persistence. The real payload `WorkOrder.create` was actually
    // given — not a hand-built stand-in for it.
    expect(create).toHaveBeenCalledTimes(1);
    const written = create.mock.calls[0][0].data as Record<string, unknown>;
    expect(written.modelTier).toBe('large');

    // That payload, rebuilt as the row a SELECT would hand back. Only the
    // reshaping `rehydrateWorkOrder` requires — a real row also carries
    // `repository` from a join and no `repositoryId` column on the type it
    // reads — nothing here re-derives or re-asserts a value link 3 produced.
    const row: StoredWorkOrder = {
      identity: written.identity as string,
      branch: written.branch as string,
      issueNumber: written.issueNumber as number,
      issueUrl: written.issueUrl as string,
      issueTitle: written.issueTitle as string | null,
      baseCommit: written.baseCommit as string,
      attempt: written.attempt as number,
      taskSpec: written.taskSpec as string,
      acceptanceCriteria: written.acceptanceCriteria as string[],
      pathConstraints: written.pathConstraints as string[],
      decisionRefs: written.decisionRefs as string[],
      needs: written.needs as string[],
      modelTier: written.modelTier as string | null,
      budgetCeilingUsd: written.budgetCeilingUsd as number | null,
      wallClockTimeoutMinutes: written.wallClockTimeoutMinutes as number | null,
      repository: { owner: REPOSITORY.owner, name: REPOSITORY.name },
    };

    // Link 4: rehydration. The row survives back into a dispatchable
    // `GeneratedWorkOrder`.
    const workOrder = rehydrateWorkOrder(row);
    expect(workOrder.modelTier).toBe('large');

    // Link 5: routing. A pool with exactly one runner, and it serves the
    // wrong tier.
    return decideDispatch(
      {
        needs: workOrder.needs,
        modelTier: workOrder.modelTier,
        identity: workOrder.identity,
      },
      [pool()],
      NO_LIMIT,
    );
  }

  it('is refused end to end: a small-only runner never takes a tier:large work order', async () => {
    const decision = await runTheChain();

    // The implementing agent's own report of this chain, reproduced exactly:
    // no runner key, and a reason naming the runner and both tiers by name.
    expect(decision.runnerKey).toBeNull();
    expect(decision.reason).toBe(
      'Queued: no runner can take this work order (needs no specific capabilities). ' +
        "small-only serves model tier(s) small and this work order asked for 'large'.",
    );
  });
});
