import { assessCriteria, describeProblems, MIN_CRITERION_LENGTH } from './acceptance-criteria';

const GOOD = [
  'GET /api/widgets returns 200 with a paginated list',
  'A request without a token returns 401',
];

describe('assessCriteria', () => {
  describe('what passes', () => {
    it('accepts criteria that name an observable outcome', () => {
      expect(assessCriteria(GOOD)).toEqual({ testable: true, problems: [] });
    });

    it('accepts a single good criterion', () => {
      expect(assessCriteria([GOOD[0]]).testable).toBe(true);
    });

    it('does not reject a word merely for containing a subjective one', () => {
      // `includes` would make "clean" reject this. A gate that rejects good
      // work is worse than one that lets some bad work through, because
      // people route around it rather than fixing their issues.
      expect(assessCriteria(['The parser is cleanly separated from the lexer']).testable).toBe(
        true,
      );
    });

    it('accepts a criterion that merely mentions a placeholder word', () => {
      expect(assessCriteria(['Rejects a TBD placeholder with a 400']).testable).toBe(true);
    });

    it('ignores blank entries rather than failing on them', () => {
      expect(assessCriteria([GOOD[0], '', '   ']).testable).toBe(true);
    });
  });

  describe('nothing to check against', () => {
    it('rejects an empty list', () => {
      const verdict = assessCriteria([]);

      expect(verdict.testable).toBe(false);
      expect(verdict.problems[0].reason).toContain('no definition of done');
    });

    it('rejects a list of only whitespace', () => {
      expect(assessCriteria(['  ', '\n']).testable).toBe(false);
    });

    it('attributes a whole-set problem to no particular criterion', () => {
      expect(assessCriteria([]).problems[0].criterion).toBeNull();
    });
  });

  describe('placeholders — the section was never filled in', () => {
    it.each(['TBD', 'todo', 'N/A', 'none', '-', 'see above', 'As discussed'])(
      'rejects %s standing alone',
      (placeholder) => {
        const verdict = assessCriteria([placeholder]);

        expect(verdict.testable).toBe(false);
        expect(verdict.problems[0].reason).toContain('placeholder');
      },
    );

    it('ignores trailing punctuation when matching', () => {
      expect(assessCriteria(['TBD.']).testable).toBe(false);
    });
  });

  describe('too short to state an outcome', () => {
    it('rejects a criterion under the minimum', () => {
      const verdict = assessCriteria(['Works']);

      expect(verdict.testable).toBe(false);
      expect(verdict.problems[0].reason).toContain('too short');
    });

    it('is tuned low, to catch the empty rather than enforce a house style', () => {
      expect(MIN_CRITERION_LENGTH).toBeLessThanOrEqual(20);
    });
  });

  describe('feelings rather than observations', () => {
    it.each([
      'The UI looks good on mobile',
      'The endpoint is fast',
      'The code is maintainable',
      'Error handling works properly',
      'Caching is added as needed',
      'Validation, logging, etc',
    ])('rejects "%s"', (criterion) => {
      // A vague criterion does not make a run fail — it makes a run SUCCEED
      // against the wrong target, and produce a pull request somebody has to
      // read carefully to discover is wrong.
      expect(assessCriteria([criterion]).testable).toBe(false);
    });

    it('says which phrase it objected to, so the author can fix it', () => {
      const verdict = assessCriteria(['The endpoint is fast']);

      expect(verdict.problems[0].reason).toContain('is fast');
      expect(verdict.problems[0].reason).toContain('describes a feeling');
    });

    it('names the criterion, not just the phrase', () => {
      expect(assessCriteria(['The endpoint is fast']).problems[0].criterion).toBe(
        'The endpoint is fast',
      );
    });
  });

  describe('reporting', () => {
    it('reports every bad criterion, not just the first', () => {
      // An author who fixes one and resubmits only to be rejected again stops
      // engaging with the gate.
      const verdict = assessCriteria(['TBD', 'It looks good', GOOD[0]]);

      expect(verdict.problems).toHaveLength(2);
    });

    it('reports one problem per criterion, not one per rule it broke', () => {
      // 'TBD' is both a placeholder and short. Saying so twice is noise.
      expect(assessCriteria(['TBD']).problems).toHaveLength(1);
    });

    it('renders the problems as something a human can act on', () => {
      const message = describeProblems(assessCriteria(['TBD', 'It is fast enough']).problems);

      expect(message).toContain('placeholder');
      expect(message).toContain('TBD');
    });

    it('passes cleanly when there is nothing to say', () => {
      expect(describeProblems(assessCriteria(GOOD).problems)).toBe('');
    });
  });
});
