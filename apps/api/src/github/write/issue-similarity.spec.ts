import {
  DUPLICATE_THRESHOLD,
  TITLE_WEIGHT,
  jaccard,
  similarity,
  tokenize,
} from './issue-similarity';

describe('tokenize', () => {
  it('drops short words and stop words', () => {
    expect([...tokenize('the export is on a page')].sort()).toEqual(['export', 'page']);
  });

  it('strips fenced code', () => {
    // Two issues quoting the same stack trace are not duplicates, and leaving
    // the trace in makes them look like one.
    expect(tokenize('report\n```\nTypeError undefined reading foo\n```')).toEqual(
      new Set(['report']),
    );
  });

  it('strips inline code', () => {
    expect(tokenize('broken `SomeVeryDistinctiveSymbol` here')).toEqual(
      new Set(['broken', 'here']),
    );
  });

  it('keeps link text but drops the URL', () => {
    // The text carries meaning; the URL is shared by every issue about one file.
    expect([...tokenize('see [the export module](https://github.com/acme/app/blob/main/x)')].sort()).toEqual(
      ['export', 'module', 'see'],
    );
  });

  it('strips HTML comments, which every templated issue shares', () => {
    expect(tokenize('<!-- opifex:marker -->\nreal content')).toEqual(
      new Set(['real', 'content']),
    );
  });

  it('is case-insensitive', () => {
    expect(tokenize('Export')).toEqual(tokenize('export'));
  });
});

describe('jaccard', () => {
  it('is 1 for identical sets and 0 for disjoint ones', () => {
    expect(jaccard(new Set(['a', 'b']), new Set(['a', 'b']))).toBe(1);
    expect(jaccard(new Set(['a']), new Set(['b']))).toBe(0);
  });

  it('is 0 when either side is empty, rather than dividing by zero', () => {
    expect(jaccard(new Set(), new Set(['a']))).toBe(0);
    expect(jaccard(new Set(['a']), new Set())).toBe(0);
  });

  it('is symmetric', () => {
    const a = new Set(['x', 'y', 'z']);
    const b = new Set(['y', 'z', 'w']);

    expect(jaccard(a, b)).toBe(jaccard(b, a));
  });
});

describe('similarity', () => {
  const ISSUE = {
    title: 'Add CSV export to the reports page',
    body: 'Operators export reports by hand. Add a CSV download button.',
  };

  it('scores an identical issue at 1', () => {
    expect(similarity(ISSUE, ISSUE)).toBeCloseTo(1);
  });

  it('scores unrelated issues near 0', () => {
    expect(
      similarity(ISSUE, {
        title: 'Rotate the JWT signing secret',
        body: 'The signing secret has not changed since deployment.',
      }),
    ).toBeLessThan(0.15);
  });

  it('weights the title heavily', () => {
    // Two issues with the same title are almost always the same issue however
    // the bodies differ; two with similar bodies are routinely different work
    // against the same subsystem.
    expect(TITLE_WEIGHT).toBeGreaterThan(0.5);

    const sameTitle = similarity(ISSUE, { title: ISSUE.title, body: 'Completely other words.' });
    const sameBody = similarity(ISSUE, { title: 'Entirely different heading.', body: ISSUE.body });

    expect(sameTitle).toBeGreaterThan(sameBody);
  });

  describe('at the refusal threshold', () => {
    it('refuses a reworded duplicate', () => {
      // The case that actually occurs: the same prompt seeing the same
      // repository twice.
      const reworded = {
        title: 'Add CSV export to the reports page',
        body: 'Operators currently export reports by hand; add a CSV download button.',
      };

      expect(similarity(ISSUE, reworded)).toBeGreaterThanOrEqual(DUPLICATE_THRESHOLD);
    });

    it('does NOT refuse different work against the same subsystem', () => {
      // "add a test for X" and "fix X" share most of their body vocabulary and
      // are not duplicates. A false refusal is the expensive error: the
      // duplicate can be closed, but a refused issue is work never tracked.
      const different = {
        title: 'Add tests for the CSV export encoder',
        body: 'The CSV export has no test coverage for quoting or newlines.',
      };

      expect(similarity(ISSUE, different)).toBeLessThan(DUPLICATE_THRESHOLD);
    });

    it('leaves headroom below 1, so an exact title alone is enough', () => {
      // 0.7 x 1.0 = 0.7 from the title, which must clear the threshold on its
      // own — an identical title with a rewritten body is still a duplicate.
      expect(DUPLICATE_THRESHOLD).toBeLessThanOrEqual(TITLE_WEIGHT);
    });
  });
});
