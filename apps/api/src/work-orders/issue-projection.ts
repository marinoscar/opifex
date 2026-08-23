import { INPUT_LABELS } from '../github/labels/factory-labels';
import type { NormalizedIssue } from '../github/read/github-read.types';
import { ISSUE_TEMPLATES, type IssueTemplate } from '../github/write/issue-templates';
import { parseSections } from '../github/write/issue-conformance';
import type { RunnerNeed } from '../runners/runner.types';
import { generateWorkOrder, type GeneratedWorkOrder } from './work-order-generator';
import type { CriteriaProblem } from './acceptance-criteria';

/**
 * An issue, as the thing a runner can be asked to build.
 *
 * ## The join this is
 *
 * #62 built `generateWorkOrder` and nothing called it. It takes a task spec,
 * acceptance criteria, path constraints and needs — already parsed — and
 * nothing produced them, so the `work_orders` table stayed empty by
 * construction and every downstream piece (#63, #64, #151, #153) had no input
 * at all.
 *
 * This is the missing step: the issue body has the material, the templates
 * (#108) already say where each part lives, and `parseSections` already reads
 * it. All that was absent was the mapping.
 *
 * ## No I/O, on purpose
 *
 * Same rule the desired-state projection follows (#46): the tick assembles the
 * observation, the projection is a pure function of it. That is what makes it
 * deterministic, testable against fixtures, and safe to run during the
 * observation week when nothing may have side effects.
 *
 * ## Rejection is an outcome, not an error
 *
 * VISION §10 makes spec quality the throughput ceiling — *the factory cannot
 * be better than what it is told to build.* An issue whose acceptance criteria
 * are placeholder or subjective is the normal case this has to handle well,
 * not an exception. So the result is a discriminated union carrying the
 * problems back intact, because they are destined for a comment the author
 * reads, and an exception message is a worse carrier for that than a list.
 */

/** Which section of the body carries the prose handed to the runner. */
export const TASK_SPEC_SECTION = 'Proposed solution';

/** Where per-issue path constraints may be declared. Optional. */
export const PATH_CONSTRAINTS_SECTION = 'Affected component';

export type IssueProjectionResult =
  | { eligible: true; workOrder: GeneratedWorkOrder }
  /** The issue is not a candidate at all. Silent — not a complaint. */
  | { eligible: false; reason: SkipReason }
  /** It is a candidate and its spec is not good enough. The author is told. */
  | { eligible: false; reason: 'rejected'; problems: CriteriaProblem[]; message: string };

/**
 * Why an issue produced nothing, silently.
 *
 * Distinct values because they call for completely different responses: a
 * closed issue is nothing, a held one is a human's decision, and a missing
 * section is something the author can fix.
 *
 * `rejected` is deliberately NOT one of these. It is the other arm of the
 * union, because it carries problems and a message that a skip does not — and
 * including it here would stop `reason` discriminating the union at all, so a
 * caller reaching for `problems` would not compile. That is exactly what
 * happened when this type was first written.
 */
export type SkipReason =
  | 'not-open'
  | 'not-marked-ready'
  | 'held'
  | 'no-body'
  | 'missing-task-spec'
  | 'missing-acceptance-criteria';

export interface ProjectIssueInput {
  issue: NormalizedIssue;
  repository: { owner: string; name: string };
  /**
   * The commit the work starts from, resolved by the caller and pinned here.
   *
   * #62: *"base commit is pinned at generation, never resolved later."* Passed
   * in rather than read, because reading it would be I/O and this function has
   * none — and because the tick has already resolved it once for every issue
   * in the repository rather than once per issue.
   */
  baseCommit: string;
  /** 1 unless #66's retry policy is deliberately re-running. */
  attempt?: number;
  /** Repository defaults, copied in so a later change cannot rewrite history. */
  budgetCeilingUsd?: number | null;
  wallClockTimeoutMinutes?: number | null;
}

export function projectIssue(input: ProjectIssueInput): IssueProjectionResult {
  const { issue } = input;

  if (issue.state !== 'open') return skip('not-open');

  // `factory:ready` is the whole eligibility signal, and it is deliberately
  // opt-IN. VISION §3.5 gates on reversibility and a run spends money, so an
  // issue must be marked before the factory touches it — the alternative,
  // treating every open issue as work, turns a backlog into a bill.
  if (!issue.inputLabels.includes(INPUT_LABELS.READY)) return skip('not-marked-ready');

  // A human's decision, and it outranks `ready`. #49 already reads this label;
  // honouring it here means a hold applied between ticks stops the work order
  // being created at all rather than being created and then suppressed.
  if (issue.inputLabels.includes(INPUT_LABELS.HOLD)) return skip('held');

  if (!issue.body || issue.body.trim().length === 0) return skip('no-body');

  const sections = parseSections(issue.body);
  const template = ISSUE_TEMPLATES.feature;

  const taskSpec = sections.get(TASK_SPEC_SECTION.toLowerCase())?.trim();
  if (!taskSpec) return skip('missing-task-spec');

  const criteria = readAcceptanceCriteria(sections, template);
  if (criteria.length === 0) return skip('missing-acceptance-criteria');

  // The generator owns the judgement about whether these criteria are good
  // enough (#62, #108), and it must stay the only place that decides — a
  // second opinion here would let an issue pass one gate and fail the other.
  const generated = generateWorkOrder({
    issue: {
      repository: input.repository,
      issueNumber: issue.number,
      title: issue.title,
      issueUrl: issueUrl(input.repository, issue.number),
      taskSpec,
      acceptanceCriteria: criteria,
      pathConstraints: readPathConstraints(sections),
      decisionRefs: readDecisionRefs(issue.body),
      needs: readNeeds(issue),
    },
    baseCommit: input.baseCommit,
    attempt: input.attempt ?? 1,
    budgetCeilingUsd: input.budgetCeilingUsd ?? null,
    wallClockTimeoutMinutes: input.wallClockTimeoutMinutes ?? null,
  });

  if (!generated.ok) {
    return {
      eligible: false,
      reason: 'rejected',
      problems: generated.problems,
      message: generated.message,
    };
  }

  return { eligible: true, workOrder: generated.workOrder };
}

// ---------------------------------------------------------------------------

/**
 * Checklist items, as criteria.
 *
 * The same shape `checkConformance` looks for, and deliberately the same
 * regex-shaped idea: a template that passed #108's gate has testable criteria
 * as a checklist, so reading anything else here would accept issues that gate
 * rejected, or reject ones it accepted.
 *
 * Checkbox state is ignored. A ticked box means an author believed it was
 * done, which is not a fact about what the work order is asking for.
 */
function readAcceptanceCriteria(
  sections: Map<string, string>,
  template: IssueTemplate,
): string[] {
  const heading = template.acceptanceCriteriaSection;
  if (!heading) return [];

  const content = sections.get(heading.toLowerCase());
  if (!content) return [];

  return [...content.matchAll(/^\s*[-*]\s*(?:\[[ xX]?\]\s*)?(.+)$/gm)]
    .map((match) => match[1].trim())
    .filter((text) => text.length > 0);
}

/**
 * Path constraints, when the issue names components rather than prose.
 *
 * Absent is the normal case and means the repository default applies, so an
 * unparseable section yields an empty list rather than a rejection: this is
 * not the field #62 gates on, and failing a work order over a prose answer to
 * "affected component" would reject issues that are perfectly clear to a human.
 */
function readPathConstraints(sections: Map<string, string>): string[] {
  const content = sections.get(PATH_CONSTRAINTS_SECTION.toLowerCase());
  if (!content) return [];

  // Only backticked globs. A component name like `api` is a label, not a path,
  // and turning it into a glob would confine a run to a directory nobody
  // chose — worse than not constraining it at all.
  return [...content.matchAll(/`([^`]*[*/][^`]*)`/g)]
    .map((match) => match[1].trim())
    .filter((glob) => glob.length > 0);
}

/**
 * ADR references anywhere in the body.
 *
 * Provenance (VISION §5), so a false positive costs a spurious link and a
 * false negative loses the connection between a decision and the work that
 * rests on it. Scanned across the whole body rather than one section for that
 * reason.
 */
function readDecisionRefs(body: string): string[] {
  const refs = [...body.matchAll(/\bADR-(\d{3,4})\b/gi)].map(
    (match) => `ADR-${match[1]}`,
  );
  return [...new Set(refs)];
}

/**
 * What the work needs from a runner, from labels.
 *
 * Labels rather than prose, and that is the point: VISION §3.1 and §7 keep the
 * hot path deterministic, so routing input has to come from something an
 * operator sets explicitly. Inferring `own-infrastructure` from a sentence
 * would put a model in the one place the design says never to.
 *
 * An unrecognised `needs:` label is IGNORED here rather than rejected —
 * `NormalizedIssue.unknownInputLabels` already surfaces typos, and failing to
 * create a work order because of a label the author mistyped would be a
 * disproportionate response to a spelling mistake.
 */
export const NEEDS_LABEL_PREFIX = 'needs:';

const NEEDS_BY_LABEL: Record<string, RunnerNeed> = {
  'needs:full-streaming': 'full-streaming',
  'needs:cost-reporting': 'cost-reporting',
  'needs:structured-rate-limits': 'structured-rate-limits',
  'needs:own-infrastructure': 'own-infrastructure',
};

function readNeeds(issue: NormalizedIssue): RunnerNeed[] {
  const needs = issue.labels
    .map((label) => NEEDS_BY_LABEL[label.name.toLowerCase()])
    .filter((need): need is RunnerNeed => need !== undefined);

  return [...new Set(needs)];
}

function issueUrl(repository: { owner: string; name: string }, issueNumber: number): string {
  return `https://github.com/${repository.owner}/${repository.name}/issues/${issueNumber}`;
}

function skip(reason: SkipReason): IssueProjectionResult {
  return { eligible: false, reason };
}
