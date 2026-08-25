import { INPUT_LABEL_PREFIX } from './factory-labels';
import {
  NEEDS_LABEL_PREFIX,
  TIER_LABEL_PREFIX,
  classifyIgnoredLabels,
  describeIgnoredLabels,
} from './ignored-labels';

/**
 * `classifyIgnoredLabels` and `describeIgnoredLabels` are the whole of
 * #297's new behaviour: the read boundary turns a mistyped or contradictory
 * routing label into a finding, and the projection turns the finding into a
 * sentence a human reads. Both are pure, so every case here is a plain
 * input/output pair — no issue, no repository, no I/O.
 */
describe('classifyIgnoredLabels', () => {
  it('finds nothing on a clean issue', () => {
    expect(classifyIgnoredLabels(['bug', 'factory:ready'])).toEqual([]);
  });

  it('finds nothing when there are no labels at all', () => {
    expect(classifyIgnoredLabels([])).toEqual([]);
  });

  describe('an unrecognised value per family', () => {
    it('flags a mistyped factory: label', () => {
      expect(classifyIgnoredLabels(['factory:hold-please'])).toEqual([
        {
          prefix: INPUT_LABEL_PREFIX,
          kind: 'unrecognised',
          labels: ['factory:hold-please'],
        },
      ]);
    });

    it('flags a mistyped needs: label', () => {
      expect(classifyIgnoredLabels(['needs:ful-streaming'])).toEqual([
        {
          prefix: NEEDS_LABEL_PREFIX,
          kind: 'unrecognised',
          labels: ['needs:ful-streaming'],
        },
      ]);
    });

    it('flags a mistyped tier: label', () => {
      expect(classifyIgnoredLabels(['tier:huge'])).toEqual([
        {
          prefix: TIER_LABEL_PREFIX,
          kind: 'unrecognised',
          labels: ['tier:huge'],
        },
      ]);
    });

    it('does not flag a needs: set with several valid members', () => {
      // needs: is a set, not a single choice — several are a coherent
      // request, so there is no contradiction to detect for this family.
      expect(
        classifyIgnoredLabels(['needs:full-streaming', 'needs:cost-reporting']),
      ).toEqual([]);
    });
  });

  describe('a tier: contradiction', () => {
    it('flags two different valid tiers as a contradiction, not two typos', () => {
      expect(classifyIgnoredLabels(['tier:small', 'tier:large'])).toEqual([
        {
          prefix: TIER_LABEL_PREFIX,
          kind: 'contradiction',
          labels: ['tier:large', 'tier:small'],
        },
      ]);
    });

    it('is a plain array-equality tie, order of the input labels does not matter', () => {
      const forward = classifyIgnoredLabels(['tier:small', 'tier:large']);
      const backward = classifyIgnoredLabels(['tier:large', 'tier:small']);
      expect(forward).toEqual(backward);
    });
  });

  describe('case-insensitivity, both ways (#297)', () => {
    it('recognises Tier:Small as a valid declaration, not a typo', () => {
      expect(classifyIgnoredLabels(['Tier:Small'])).toEqual([]);
    });

    it('does NOT treat tier:small + Tier:Small as a contradiction', () => {
      // They are compared by VALUE, not by label name: this is one
      // declaration said twice with different capitalisation, and reading it
      // as a contradiction would be exactly the false positive #297 warns
      // against.
      expect(classifyIgnoredLabels(['tier:small', 'Tier:Small'])).toEqual([]);
    });

    it('still catches a genuine contradiction once case is normalised away', () => {
      // Tier:Small and TIER:LARGE differ in more than case — they name two
      // different values — so the contradiction still fires.
      expect(classifyIgnoredLabels(['Tier:Small', 'TIER:LARGE'])).toEqual([
        {
          prefix: TIER_LABEL_PREFIX,
          kind: 'contradiction',
          labels: ['TIER:LARGE', 'Tier:Small'],
        },
      ]);
    });
  });

  it('reports the typo and keeps the valid tier alongside it', () => {
    // An unrecognised label sits next to a valid one — the valid tier is not
    // itself a problem, and must not be swept into the same finding as the
    // typo, or read as contradicting it.
    const found = classifyIgnoredLabels(['tier:standard', 'tier:extra-large']);

    expect(found).toEqual([
      {
        prefix: TIER_LABEL_PREFIX,
        kind: 'unrecognised',
        labels: ['tier:extra-large'],
      },
    ]);
  });

  it('joins findings from multiple families in one call', () => {
    const found = classifyIgnoredLabels([
      'needs:ful-streaming',
      'tier:small',
      'tier:large',
    ]);

    expect(found).toEqual([
      {
        prefix: NEEDS_LABEL_PREFIX,
        kind: 'unrecognised',
        labels: ['needs:ful-streaming'],
      },
      {
        prefix: TIER_LABEL_PREFIX,
        kind: 'contradiction',
        labels: ['tier:large', 'tier:small'],
      },
    ]);
  });
});

describe('describeIgnoredLabels', () => {
  it('names a single offender in the singular', () => {
    const description = describeIgnoredLabels(
      classifyIgnoredLabels(['tier:huge']),
    );

    expect(description).toBe(
      'ignored labels: tier:huge is not a recognised tier: label — the default applies',
    );
  });

  it('names several offenders in the plural', () => {
    const description = describeIgnoredLabels(
      classifyIgnoredLabels(['needs:ful-streaming', 'needs:full-stream']),
    );

    expect(description).toBe(
      'ignored labels: needs:ful-streaming, needs:full-stream are not a recognised needs: label — the default applies',
    );
  });

  it('describes a contradiction by naming both labels', () => {
    const description = describeIgnoredLabels(
      classifyIgnoredLabels(['tier:small', 'tier:large']),
    );

    expect(description).toBe(
      'ignored labels: tier:large and tier:small contradict each other — the default applies',
    );
  });

  it('joins multiple families into one clause list', () => {
    const description = describeIgnoredLabels(
      classifyIgnoredLabels([
        'needs:ful-streaming',
        'tier:small',
        'tier:large',
      ]),
    );

    expect(description).toBe(
      'ignored labels: needs:ful-streaming is not a recognised needs: label; ' +
        'tier:large and tier:small contradict each other — the default applies',
    );
  });

  it('is the empty-input identity: no findings, no offenders named', () => {
    expect(describeIgnoredLabels([])).toBe(
      'ignored labels:  — the default applies',
    );
  });
});
