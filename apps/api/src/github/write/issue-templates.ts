/**
 * The issue shapes Opifex is allowed to open, and what each must contain.
 *
 * ## Why this is a constant and not a fetch
 *
 * #108 says a candidate is validated "against the repository's issue-template
 * shape". These descriptors mirror `.github/ISSUE_TEMPLATE/*.yml` in this
 * repository, and the honest limitation is stated here rather than hidden: a
 * watched repository with different templates is validated against these,
 * not against its own.
 *
 * That is deliberate for now. Fetching and parsing a repository's template
 * YAML costs a request per creation and introduces a second failure mode —
 * a repository with no templates would have no validation at all, which is
 * exactly the case the gate exists for. Opifex's own convention (CLAUDE.md's
 * issue-driven development rules) is what these encode, and a repository that
 * wants Opifex opening issues in it adopts them. When per-repository templates
 * are needed, `IssueTemplate` is the seam: `resolveTemplate` becomes async and
 * everything downstream is unchanged.
 */

export type IssueKind = 'feature' | 'bug' | 'epic';

export interface IssueTemplate {
  kind: IssueKind;
  /**
   * Section headings the body must contain, matched case-insensitively as
   * markdown headings. Mirrors the template's `validations: required: true`
   * fields — an optional field is not listed, so omitting it is not a refusal.
   */
  requiredSections: string[];
  /**
   * The heading whose content must be non-empty and must contain at least one
   * checklist item.
   *
   * VISION §10 makes "acceptance criteria are testable" the definition of a
   * well-formed issue, and the feature template says so in as many words: a
   * work order is generated from this field and the agent executing it is held
   * to exactly what it says. A heading with nothing under it produces a work
   * order with nothing to satisfy, which is worse than no issue at all —
   * it looks complete.
   */
  acceptanceCriteriaSection: string | null;
  /** Labels every issue of this kind carries, matching the template's own. */
  labels: string[];
}

export const ISSUE_TEMPLATES: Record<IssueKind, IssueTemplate> = {
  feature: {
    kind: 'feature',
    requiredSections: [
      'Problem statement',
      'Proposed solution',
      'Affected component',
      'Priority',
      'Acceptance criteria',
    ],
    acceptanceCriteriaSection: 'Acceptance criteria',
    labels: ['feature'],
  },
  bug: {
    kind: 'bug',
    requiredSections: [
      'Description',
      'Reproduction steps',
      'Expected behaviour',
      'Actual behaviour',
      'Affected component',
      'Severity',
    ],
    // The bug template has no acceptance-criteria field: a bug's acceptance
    // criterion is that it stops happening, and demanding one produces
    // boilerplate rather than information.
    acceptanceCriteriaSection: null,
    labels: ['bug'],
  },
  epic: {
    kind: 'epic',
    requiredSections: [
      'Problem / why this exists',
      'Intended outcome',
      'Child work',
      'Exit criteria',
    ],
    acceptanceCriteriaSection: 'Exit criteria',
    labels: ['epic'],
  },
};
