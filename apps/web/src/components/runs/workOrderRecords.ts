/**
 * Where a work order's two records live (#84).
 *
 * VISION §4 records a work order twice: as a fenced JSON comment on the issue
 * (the *authorization record*) and as the first commit on its branch (the
 * *execution record*). #63: keeping both is what makes *"the agent did
 * something I did not ask for"* a checkable claim rather than an argument.
 *
 * The authorization comment's URL comes from the API, because only the control
 * plane knows which comment it posted. The execution record's URL is DERIVED —
 * the path is a constant and the branch is on the document — so it needs no
 * round trip and cannot go stale relative to the branch the order names.
 */

import type { WorkOrderDocument } from '../../types/cockpit';

/** Must match `EXECUTION_RECORD_PATH` in the API's work-order-document.ts. */
export const EXECUTION_RECORD_PATH = '.opifex/work-order.json';

/**
 * A GitHub link to the execution record on the work order's own branch.
 *
 * Deliberately pinned to the BRANCH rather than to a commit sha: the execution
 * record is the branch's first commit, so the branch ref always resolves to it
 * unless somebody rewrote history — and if they did, that is exactly what the
 * reader needs to see.
 */
export function executionRecordUrl(document: WorkOrderDocument): string {
  const { owner, name } = document.repository;
  return `https://github.com/${owner}/${name}/blob/${document.branch}/${EXECUTION_RECORD_PATH}`;
}

/** The branch itself, for the reader who wants the whole attempt. */
export function branchUrl(document: WorkOrderDocument): string {
  const { owner, name } = document.repository;
  return `https://github.com/${owner}/${name}/tree/${document.branch}`;
}

/**
 * The identity, parsed back into its parts.
 *
 * `wo_{repo}_{issue}_{commit7}_a{attempt}` per VISION §4. Parsing rather than
 * reading the document's own fields is the point: if the identity and the
 * document ever disagreed, the identity is what every commit trailer, branch
 * name and log line carries, so the disagreement is worth surfacing.
 *
 * Returns null for anything that does not parse, which is itself a finding.
 */
export function parseIdentity(identity: string): {
  repository: string;
  issueNumber: number;
  baseCommit: string;
  attempt: number;
} | null {
  const match = /^wo_(.+)_(\d+)_([0-9a-f]{7})_a(\d+)$/.exec(identity);
  if (!match) return null;

  return {
    repository: match[1],
    issueNumber: Number(match[2]),
    baseCommit: match[3],
    attempt: Number(match[4]),
  };
}

/**
 * Whether the identity agrees with the document it is attached to.
 *
 * The one comparison this screen can make without a network call. #84 asks for
 * authorization and execution records to be compared and divergence flagged;
 * that needs both documents fetched from GitHub, which no endpoint offers yet.
 * This is the weaker check that is available: the identity is derived from the
 * same four facts the document carries, so a mismatch means one of them was
 * changed after the fact.
 */
export function identityMatchesDocument(document: WorkOrderDocument): {
  agrees: boolean;
  reason: string | null;
} {
  const parsed = parseIdentity(document.identity);
  if (!parsed) {
    return {
      agrees: false,
      reason: `The identity "${document.identity}" is not of the form wo_{repo}_{issue}_{commit7}_a{attempt}.`,
    };
  }

  const mismatches: string[] = [];
  if (parsed.issueNumber !== document.issue.number) {
    mismatches.push(
      `issue #${parsed.issueNumber} in the identity vs #${document.issue.number} in the document`,
    );
  }
  if (!document.baseCommit.startsWith(parsed.baseCommit)) {
    mismatches.push(
      `base commit ${parsed.baseCommit} in the identity vs ${document.baseCommit.slice(0, 7)} in the document`,
    );
  }
  if (parsed.attempt !== document.attempt) {
    mismatches.push(
      `attempt ${parsed.attempt} in the identity vs ${document.attempt} in the document`,
    );
  }

  return mismatches.length === 0
    ? { agrees: true, reason: null }
    : { agrees: false, reason: mismatches.join('; ') };
}
