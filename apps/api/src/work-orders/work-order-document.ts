import { WORK_ORDER_SCHEMA_VERSION } from '../contracts/generated';
import type { ModelTier } from '../runners/runner.types';
import type { GeneratedWorkOrder } from './work-order-generator';

/**
 * The version this serializer emits, from the schema rather than beside it.
 *
 * Re-exported instead of restated: since #35 the constant is generated from
 * `work-order.schema.json`'s `default`, so bumping the schema moves this
 * without anyone remembering to. The name is kept because call sites use it.
 */
export { WORK_ORDER_SCHEMA_VERSION } from '../contracts/generated';

/**
 * The work order as the document that goes into both records.
 *
 * ## One serialization, two destinations
 *
 * #63 requires the authorization record (an issue comment) and the execution
 * record (the branch's first commit) be *verifiably identical in content*.
 * That is only structural if one function produces the bytes and both writes
 * use them. Two call sites serializing independently would make byte-identity
 * a property somebody has to keep testing forever — JSON key order alone would
 * break it, and it would break silently, because both documents would still
 * look right.
 *
 * So `serializeWorkOrder` is the single source of the string, and the records
 * service never re-stringifies.
 */
export function toWorkOrderDocument(
  workOrder: GeneratedWorkOrder,
): WorkOrderDocument {
  return {
    schemaVersion: WORK_ORDER_SCHEMA_VERSION,
    identity: workOrder.identity,
    branch: workOrder.branch,
    repository: {
      owner: workOrder.repositoryOwner,
      name: workOrder.repositoryName,
    },
    baseCommit: workOrder.baseCommit,
    attempt: workOrder.attempt,
    issue: { number: workOrder.issueNumber, url: workOrder.issueUrl },
    ...(workOrder.decisionRefs.length > 0
      ? { decisionRefs: workOrder.decisionRefs }
      : {}),
    taskSpec: workOrder.taskSpec,
    acceptanceCriteria: workOrder.acceptanceCriteria,
    pathConstraints: workOrder.pathConstraints,
    budgetCeilingUsd: workOrder.budgetCeilingUsd,
    wallClockTimeoutMinutes: workOrder.wallClockTimeoutMinutes,
    needs: workOrder.needs,
    // Only when stated. An absent tier means the runner's default, and writing
    // it explicitly would turn "unspecified" into a decision nobody made.
    ...(workOrder.modelTier ? { modelTier: workOrder.modelTier } : {}),
  };
}

/**
 * Two-space indented, newline-terminated.
 *
 * The formatting is part of the contract rather than a preference: these bytes
 * are committed to a branch, where a reformatting would show as a diff, and
 * posted inside a fenced block a human reads. Compact JSON would satisfy the
 * schema and be unreadable in both places.
 */
export function serializeWorkOrder(workOrder: GeneratedWorkOrder): string {
  return `${JSON.stringify(toWorkOrderDocument(workOrder), null, 2)}\n`;
}

export interface WorkOrderDocument {
  schemaVersion: string;
  identity: string;
  branch: string;
  repository: { owner: string; name: string };
  baseCommit: string;
  attempt: number;
  issue: { number: number; url: string };
  decisionRefs?: string[];
  taskSpec: string;
  acceptanceCriteria: string[];
  pathConstraints: string[];
  budgetCeilingUsd: number | null;
  wallClockTimeoutMinutes: number | null;
  needs: string[];
  /**
   * The closed union, not `string` — unlike `needs` beside it, which stays
   * loose only because `RunnerNeed` predates the generated contract. Typed
   * narrowly so a consumer that renders the document (the cockpit's detail
   * DTO) cannot be handed a tier the schema does not allow.
   */
  modelTier?: ModelTier;
}

/**
 * The commit message for the execution record.
 *
 * Carries the full agent trailer block from `docs/PROVENANCE.md`. This commit
 * is written by the control plane rather than by a runner, and it is still
 * agent-authored in every sense the vocabulary cares about — by the time the
 * branch is created, routing has chosen a runner and the run row exists (#60),
 * so `Runner:` and `Run-Id:` both have real values rather than invented ones.
 */
export function executionRecordCommitMessage(input: {
  workOrder: GeneratedWorkOrder;
  runnerKey: string;
  runnerVersion: string;
  runId: string;
}): string {
  const { workOrder } = input;

  const trailers = [
    `Work-Order: ${workOrder.identity}`,
    `Issue: #${workOrder.issueNumber}`,
    ...workOrder.decisionRefs.map((ref) => `Decision: ${ref}`).slice(0, 1),
    `Runner: ${input.runnerKey}@${input.runnerVersion}`,
    `Run-Id: ${input.runId}`,
    `Attempt: ${workOrder.attempt}`,
  ];

  return [
    `chore(factory): authorize ${workOrder.identity}`,
    '',
    // The subject line names the identity; the body says what the commit IS,
    // because somebody reading `git log` on this branch in six months has no
    // other context for a commit that changes one JSON file.
    'Execution record: the work order this branch was created to carry out,',
    'as authorized on the issue. Written before any runner touched the branch,',
    'so it states what the runner was GIVEN rather than what it did.',
    '',
    ...trailers,
  ].join('\n');
}

/** The path the execution record lives at, per ADR-0005. */
export const EXECUTION_RECORD_PATH = '.opifex/work-order.json';
