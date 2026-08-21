import { checkConformance, parseSections } from './issue-conformance';
import { ISSUE_TEMPLATES } from './issue-templates';

function featureBody(overrides: Partial<Record<string, string>> = {}): string {
  const sections: Record<string, string> = {
    'Problem statement': 'Exports are manual and take twenty minutes.',
    'Proposed solution': 'Add a CSV export endpoint behind the existing auth.',
    'Affected component': 'api',
    Priority: 'P2 medium',
    'Acceptance criteria': [
      '- [ ] Given a signed-in user, when they GET /export, then a CSV downloads',
      '- [ ] Existing report tests still pass',
    ].join('\n'),
    ...overrides,
  };

  return Object.entries(sections)
    .filter(([, content]) => content !== undefined)
    .map(([heading, content]) => `## ${heading}\n\n${content}`)
    .join('\n\n');
}

describe('parseSections', () => {
  it('maps each heading to the text beneath it', () => {
    const sections = parseSections('## One\n\nfirst\n\n## Two\n\nsecond');

    expect(sections.get('one')).toBe('first');
    expect(sections.get('two')).toBe('second');
  });

  it('handles any heading level', () => {
    expect(parseSections('# Title\n\ncontent').get('title')).toBe('content');
    expect(parseSections('#### Deep\n\ncontent').get('deep')).toBe('content');
  });

  it('records a heading with nothing under it as empty, not absent', () => {
    // The two are different refusals — "you forgot this section" versus "you
    // left it blank" — and collapsing them makes the message unactionable.
    const sections = parseSections('## Empty\n\n## Next\n\ncontent');

    expect(sections.get('empty')).toBe('');
    expect(sections.has('empty')).toBe(true);
  });

  it('ignores preamble before the first heading', () => {
    expect(parseSections('some intro\n\n## One\n\nfirst').get('one')).toBe('first');
  });
});

describe('checkConformance', () => {
  describe('a well-formed feature request', () => {
    it('passes', () => {
      expect(checkConformance('feature', featureBody())).toEqual([]);
    });
  });

  describe('missing sections', () => {
    it('names the section that is missing', () => {
      const body = featureBody({ 'Problem statement': undefined });

      expect(checkConformance('feature', body)).toEqual([
        { reason: 'missing-section', section: 'Problem statement' },
      ]);
    });

    it('reports EVERY failure, not just the first', () => {
      // An agent told about one problem per round trip burns a round trip per
      // problem — and issue volume is the exact failure mode #108 prevents.
      const failures = checkConformance('feature', '## Priority\n\nP2 medium');

      expect(failures.map((f) => f.section).sort()).toEqual([
        'Acceptance criteria',
        'Affected component',
        'Problem statement',
        'Proposed solution',
      ]);
    });

    it('distinguishes an empty section from an absent one', () => {
      const body = featureBody({ 'Proposed solution': '' });

      expect(checkConformance('feature', body)).toContainEqual({
        reason: 'empty-section',
        section: 'Proposed solution',
      });
    });

    it('is case-insensitive about headings', () => {
      const body = featureBody().replace('## Problem statement', '## PROBLEM STATEMENT');

      expect(checkConformance('feature', body)).toEqual([]);
    });
  });

  describe('acceptance criteria', () => {
    it('refuses prose where the template asks for a checklist', () => {
      // A work order is generated per criterion. Prose produces a work order
      // with nothing specific to satisfy.
      const body = featureBody({
        'Acceptance criteria': 'It should work well and be reasonably fast.',
      });

      expect(checkConformance('feature', body)).toContainEqual({
        reason: 'untestable-criteria',
        section: 'Acceptance criteria',
      });
    });

    it('refuses a placeholder that would pass a non-empty check', () => {
      // The reason the check is not `length > 0`. "TBD" is present, non-empty,
      // formatted as a checklist, and says nothing.
      const body = featureBody({ 'Acceptance criteria': '- [ ] TBD' });

      expect(checkConformance('feature', body)).toContainEqual({
        reason: 'untestable-criteria',
        section: 'Acceptance criteria',
      });
    });

    it('refuses an item too short to be testable', () => {
      const body = featureBody({ 'Acceptance criteria': '- [ ] works' });

      expect(checkConformance('feature', body)).toContainEqual({
        reason: 'untestable-criteria',
        section: 'Acceptance criteria',
      });
    });

    it('accepts a checked item — a criterion is testable either way', () => {
      const body = featureBody({
        'Acceptance criteria': '- [x] Given a request, when X, then Y happens',
      });

      expect(checkConformance('feature', body)).toEqual([]);
    });

    it('accepts an asterisk bullet', () => {
      const body = featureBody({
        'Acceptance criteria': '* [ ] Given a request, when X, then Y happens',
      });

      expect(checkConformance('feature', body)).toEqual([]);
    });

    it('accepts when at least one item is real, even beside a placeholder', () => {
      const body = featureBody({
        'Acceptance criteria': '- [ ] TBD\n- [ ] Given a request, when X, then Y happens',
      });

      expect(checkConformance('feature', body)).toEqual([]);
    });

    it('does not double-report a section that is missing entirely', () => {
      // One mistake, one failure. Reporting "missing" and "untestable" for the
      // same absent heading reads as two separate problems.
      const failures = checkConformance('feature', featureBody({ 'Acceptance criteria': undefined }));

      expect(failures.filter((f) => f.section === 'Acceptance criteria')).toEqual([
        { reason: 'missing-section', section: 'Acceptance criteria' },
      ]);
    });
  });

  describe('per-kind templates', () => {
    it('does not demand acceptance criteria of a bug report', () => {
      // A bug's acceptance criterion is that it stops happening; demanding one
      // produces boilerplate rather than information.
      expect(ISSUE_TEMPLATES.bug.acceptanceCriteriaSection).toBeNull();

      const body = [
        '## Description\n\nThe export button 500s.',
        '## Reproduction steps\n\n1. Click export',
        '## Expected behaviour\n\nA CSV downloads.',
        '## Actual behaviour\n\nA 500.',
        '## Affected component\n\napi',
        '## Severity\n\nP1 high',
      ].join('\n\n');

      expect(checkConformance('bug', body)).toEqual([]);
    });

    it('holds an epic to its exit criteria', () => {
      const body = [
        '## Problem / why this exists\n\nNothing observes GitHub.',
        '## Intended outcome\n\nA reconciler that does.',
        '## Child work\n\n- [ ] #45',
        '## Exit criteria\n\nvarious things happen',
      ].join('\n\n');

      expect(checkConformance('epic', body)).toContainEqual({
        reason: 'untestable-criteria',
        section: 'Exit criteria',
      });
    });
  });
});
