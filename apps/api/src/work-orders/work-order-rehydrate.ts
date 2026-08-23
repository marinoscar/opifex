import {
  workOrderBranch,
  workOrderIdentity,
  type WorkOrderCoordinates,
} from './work-order-identity';
import type { GeneratedWorkOrder } from './work-order-generator';
import type { RunnerNeed } from '../runners/runner.types';

/**
 * A stored work order, back as the thing that was authorized.
 *
 * ## Why this has to exist
 *
 * Everything that acts on a work order — dispatch (#64), the executor (#151),
 * the records writer (#63) — takes a `GeneratedWorkOrder`. Until now the only
 * code that ever held one was the code that had just built it from a live
 * GitHub issue, so a work order survived a restart as a row nothing could use.
 *
 * ## Why not re-project from the issue instead
 *
 * The reconciler recomputes desired state every tick, so re-deriving the work
 * order from GitHub would fit the pattern (VISION §4). It is still wrong here.
 *
 * The authorization record (#63) was posted for ONE specific document. If the
 * issue has since been edited, or the base commit has moved, a re-projection
 * is a *different* work order wearing the same issue number — and #63 exists
 * so that *"the agent did something I did not ask for"* is a checkable claim
 * rather than an argument. Dispatching a re-derivation would quietly break
 * exactly that.
 *
 * So: **the authorized thing is the stored thing.** This function is the proof
 * that the row can still produce it, and `work-order-rehydrate.spec.ts` pins
 * it by serializing both and comparing bytes.
 */

/** The columns this needs. A structural type, so Prisma stays out of here. */
export interface StoredWorkOrder {
  identity: string;
  branch: string;
  issueNumber: number;
  issueUrl: string;
  issueTitle: string | null;
  baseCommit: string;
  attempt: number;
  taskSpec: string;
  acceptanceCriteria: string[];
  pathConstraints: string[];
  decisionRefs: string[];
  needs: string[];
  /** Prisma hands back a Decimal; the document wants a number or null. */
  budgetCeilingUsd: { toNumber(): number } | number | null;
  wallClockTimeoutMinutes: number | null;
  repository: { owner: string; name: string };
}

export class RehydrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RehydrationError';
  }
}

/**
 * Every need this build understands.
 *
 * Kept as a runtime list rather than only a type, because the column stores
 * free strings: Postgres cannot express the union, and widening it later must
 * not require a migration on a table that holds authorization records.
 */
export const KNOWN_NEEDS: readonly RunnerNeed[] = [
  'full-streaming',
  'cost-reporting',
  'structured-rate-limits',
  'own-infrastructure',
];

export function rehydrateWorkOrder(row: StoredWorkOrder): GeneratedWorkOrder {
  const coordinates: WorkOrderCoordinates = {
    // The repository NAME, not `owner/name`. That is what the generator uses,
    // and the identity is built from it — so composing this differently here
    // would derive a different identity from the same row while every other
    // field looked correct. The check below is what catches that.
    repository: row.repository.name,
    issueNumber: row.issueNumber,
    baseCommit: row.baseCommit,
    attempt: row.attempt,
  };

  // Both derived and both checked, and the IDENTITY is the one that matters:
  // it is the idempotency key, and it encodes the repository while the branch
  // does not. Checking only the branch would accept coordinates that rebuild
  // the wrong identity — which is how this function was wrong when it was
  // first written, and what this check caught.
  const derivedIdentity = workOrderIdentity(coordinates);
  if (derivedIdentity !== row.identity) {
    throw new RehydrationError(
      `Work order ${row.identity} does not match the identity its own coordinates derive ` +
        `("${derivedIdentity}"); refusing to dispatch a row that disagrees with itself`,
    );
  }

  const derivedBranch = workOrderBranch(coordinates);
  if (derivedBranch !== row.branch) {
    throw new RehydrationError(
      `Work order ${row.identity} stores branch "${row.branch}" but its coordinates derive ` +
        `"${derivedBranch}"; refusing to dispatch a row whose branch and identity disagree`,
    );
  }

  if (!row.issueUrl) {
    // `work-order.schema.json` requires `issue.url`. Failing here names the
    // row; failing at serialization names a schema keyword and a JSON path.
    throw new RehydrationError(
      `Work order ${row.identity} has no issue URL, which the work-order schema requires`,
    );
  }

  return {
    identity: row.identity,
    branch: row.branch,
    coordinates,

    repositoryOwner: row.repository.owner,
    repositoryName: row.repository.name,
    issueNumber: row.issueNumber,
    issueUrl: row.issueUrl,
    issueTitle: row.issueTitle,
    baseCommit: row.baseCommit,
    attempt: row.attempt,

    taskSpec: row.taskSpec,
    acceptanceCriteria: row.acceptanceCriteria,
    pathConstraints: row.pathConstraints,
    decisionRefs: row.decisionRefs,
    budgetCeilingUsd: toNumberOrNull(row.budgetCeilingUsd),
    wallClockTimeoutMinutes: row.wallClockTimeoutMinutes,
    needs: readNeeds(row),
  };
}

/**
 * Needs the current build understands, and a refusal for one it does not.
 *
 * An unknown need is NOT dropped. Silently discarding it would route the work
 * order as though it had never asked — a work order that required
 * `own-infrastructure` could then be sent to a vendor cloud, which is the one
 * class of routing error the needs mechanism exists to prevent. Better to
 * refuse the row and say which value is unrecognised.
 */
function readNeeds(row: StoredWorkOrder): RunnerNeed[] {
  const unknown = row.needs.filter(
    (need) => !(KNOWN_NEEDS as readonly string[]).includes(need),
  );

  if (unknown.length > 0) {
    throw new RehydrationError(
      `Work order ${row.identity} declares need(s) this build does not understand: ` +
        `${unknown.join(', ')}. Refusing to route it as though it had not asked.`,
    );
  }

  return row.needs as RunnerNeed[];
}

function toNumberOrNull(
  value: StoredWorkOrder['budgetCeilingUsd'],
): number | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'number' ? value : value.toNumber();
}
