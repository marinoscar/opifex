import type { ModelTier, RunnerNeed } from '../runners/runner.types';
import {
  assessCriteria,
  describeProblems,
  type CriteriaProblem,
} from './acceptance-criteria';
import {
  workOrderBranch,
  workOrderIdentity,
  type WorkOrderCoordinates,
} from './work-order-identity';

/**
 * Generating a work order from an authorized issue.
 *
 * VISION §4 makes a work order a PROJECTION of a GitHub issue — the issue is
 * the source of truth and this is a derived view of it, pinned at a moment.
 * Pure and deterministic: everything that varies, including the base commit,
 * is passed in. The reconciler resolves those; this decides only whether they
 * add up to something worth running, and what it is called.
 */

export interface IssueProjection {
  repository: { owner: string; name: string };
  issueNumber: number;
  title: string;
  /** The prose describing what to do. */
  taskSpec: string;
  acceptanceCriteria: string[];
  /** Globs the run may write within. Empty means the whole repository. */
  pathConstraints: string[];
  /** ADRs and prior decisions this work rests on. */
  decisionRefs: string[];
  /** The issue's own URL. Provenance, and required — see below. */
  issueUrl: string;
  /**
   * What this work requires OF a runner (#60), matched against advertised
   * capabilities by routing (#64).
   *
   * Optional on the way in and always present on the way out: an issue that
   * declares nothing needs anything enabled, and an empty array says that
   * explicitly rather than leaving the field absent for a reader to interpret.
   */
  needs?: RunnerNeed[];

  /**
   * The model class this work wants (#205), or undefined for the runner's own
   * default. Absent is the normal case: a tier is stated when the work is
   * unusually small or unusually hard, not on every order.
   */
  modelTier?: ModelTier;
}

export interface GenerationInput {
  issue: IssueProjection;
  /**
   * The commit the work starts from, resolved NOW and pinned.
   *
   * #62: *"base commit is pinned at generation, never resolved later."* If it
   * were resolved at dispatch, a work order authorized on Monday and run on
   * Tuesday would silently start from a different tree than the one the
   * authorizer looked at — and the identity, which encodes the base, would
   * have been computed against a commit the run never used.
   */
  baseCommit: string;
  /** 1 unless the retry policy is deliberately re-running (#66). */
  attempt?: number;
  budgetCeilingUsd?: number | null;
  wallClockTimeoutMinutes?: number | null;
}

export interface GeneratedWorkOrder {
  identity: string;
  branch: string;
  coordinates: WorkOrderCoordinates;

  repositoryOwner: string;
  repositoryName: string;
  issueNumber: number;
  /**
   * Carried through rather than only validated.
   *
   * The generator already refuses an issue with no URL, but the work-order
   * DOCUMENT needs it too: `work-order.schema.json` requires `issue.url`, and
   * the authorization record is posted to the very issue it names. Validating
   * a field and then dropping it was a gap #63 surfaced.
   */
  issueUrl: string;
  issueTitle: string | null;
  baseCommit: string;
  attempt: number;

  taskSpec: string;
  acceptanceCriteria: string[];
  pathConstraints: string[];
  decisionRefs: string[];
  budgetCeilingUsd: number | null;
  wallClockTimeoutMinutes: number | null;
  needs: RunnerNeed[];
  modelTier?: ModelTier;
}

export type GenerationResult =
  | { ok: true; workOrder: GeneratedWorkOrder }
  | { ok: false; problems: CriteriaProblem[]; message: string };

/**
 * Turn an issue into a work order, or say precisely why it cannot be one.
 *
 * A discriminated union rather than a throw. The rejection is not an
 * exceptional condition — it is a normal outcome that the reconciler will hit
 * regularly, and the reason has to travel back to a GitHub comment intact so
 * the author can fix their issue. An exception message is a worse carrier for
 * that than a structured list.
 */
export function generateWorkOrder(input: GenerationInput): GenerationResult {
  const { issue, baseCommit } = input;
  const attempt = input.attempt ?? 1;

  const problems: CriteriaProblem[] = [];

  // Provenance first, because #62 makes it REQUIRED rather than optional and
  // VISION §5 is explicit that a hole in the chain is not detectable after the
  // fact. A work order that cannot say which issue authorized it is exactly
  // that hole.
  if (!issue.issueUrl.trim()) {
    problems.push({
      criterion: null,
      reason:
        'No link back to the issue. VISION §5 requires the Issue -> Work Order edge, and a ' +
        'missing one is undetectable once the work order exists.',
    });
  }

  if (!issue.taskSpec.trim()) {
    problems.push({
      criterion: null,
      reason: 'No task spec. There is nothing to tell a runner to do.',
    });
  }

  const verdict = assessCriteria(issue.acceptanceCriteria);
  problems.push(...verdict.problems);

  if (problems.length > 0) {
    return { ok: false, problems, message: describeProblems(problems) };
  }

  const coordinates: WorkOrderCoordinates = {
    repository: issue.repository.name,
    issueNumber: issue.issueNumber,
    baseCommit,
    attempt,
  };

  return {
    ok: true,
    workOrder: {
      identity: workOrderIdentity(coordinates),
      branch: workOrderBranch(coordinates),
      coordinates,

      repositoryOwner: issue.repository.owner,
      repositoryName: issue.repository.name,
      issueNumber: issue.issueNumber,
      baseCommit,
      attempt,

      issueUrl: issue.issueUrl.trim(),
      issueTitle: issue.title?.trim() || null,
      needs: issue.needs ?? [],
      ...(issue.modelTier ? { modelTier: issue.modelTier } : {}),

      taskSpec: issue.taskSpec.trim(),
      // Trimmed and de-blanked, so what is stored is what was assessed.
      acceptanceCriteria: issue.acceptanceCriteria
        .map((criterion) => criterion.trim())
        .filter(Boolean),
      pathConstraints: issue.pathConstraints,
      decisionRefs: issue.decisionRefs,
      budgetCeilingUsd: input.budgetCeilingUsd ?? null,
      wallClockTimeoutMinutes: input.wallClockTimeoutMinutes ?? null,
    },
  };
}
