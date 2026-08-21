import { ISSUE_TEMPLATES, type IssueKind, type IssueTemplate } from './issue-templates';

export interface ConformanceFailure {
  /** `missing-section`, `empty-acceptance-criteria`, `untestable-criteria`. */
  reason: string;
  /** The section at fault, named so the refusal is actionable. */
  section: string;
}

/**
 * Markdown headings in a body, mapped to the text beneath each.
 *
 * Written against `##`-style headings because that is what the GitHub issue
 * form renders a template's field labels as. A body using `**bold**` labels
 * instead is not conformant, and saying so is correct — the point of the gate
 * is that issues have a predictable shape a work order can be generated from.
 */
export function parseSections(body: string): Map<string, string> {
  const sections = new Map<string, string>();
  // Split on headings while keeping them, so each heading's content is
  // everything up to the next one.
  const parts = body.split(/^#{1,6}[ \t]+(.+)$/gm);

  // parts[0] is any preamble before the first heading; pairs follow.
  for (let i = 1; i < parts.length; i += 2) {
    const heading = parts[i].trim().toLowerCase();
    sections.set(heading, (parts[i + 1] ?? '').trim());
  }
  return sections;
}

/**
 * Whether an acceptance-criteria section actually says something testable.
 *
 * Checklist items rather than prose, because the template asks for them in
 * that form and because a work order is generated per criterion. A section
 * reading "TBD" or "see above" passes a non-empty check and fails this one,
 * which is the whole reason the check is not just `length > 0`.
 */
function hasTestableCriteria(content: string): boolean {
  const items = content.match(/^\s*[-*]\s*\[[ xX]?\]\s*(.+)$/gm) ?? [];
  if (items.length === 0) return false;

  const PLACEHOLDERS = /^(tbd|todo|n\/a|none|see above|\.\.\.)$/i;
  return items.some((item) => {
    const text = item.replace(/^\s*[-*]\s*\[[ xX]?\]\s*/, '').trim();
    return text.length >= 10 && !PLACEHOLDERS.test(text);
  });
}

/**
 * Check a candidate against its template.
 *
 * Returns EVERY failure rather than the first. An agent that fixes one missing
 * section, resubmits, and is told about the next one has to burn a round trip
 * per problem — and #108's whole premise is that issue volume is the failure
 * mode being prevented.
 */
export function checkConformance(
  kind: IssueKind,
  body: string,
  template: IssueTemplate = ISSUE_TEMPLATES[kind],
): ConformanceFailure[] {
  const sections = parseSections(body);
  const failures: ConformanceFailure[] = [];

  for (const required of template.requiredSections) {
    const content = sections.get(required.toLowerCase());
    if (content === undefined) {
      failures.push({ reason: 'missing-section', section: required });
    } else if (content.length === 0) {
      failures.push({ reason: 'empty-section', section: required });
    }
  }

  const criteriaSection = template.acceptanceCriteriaSection;
  if (criteriaSection) {
    const content = sections.get(criteriaSection.toLowerCase());
    // Only checked when the section is present — a missing one was already
    // reported above, and saying both would be two failures for one mistake.
    if (content !== undefined && content.length > 0 && !hasTestableCriteria(content)) {
      failures.push({ reason: 'untestable-criteria', section: criteriaSection });
    }
  }

  return failures;
}
