import { describe, it, expect } from 'vitest';
import {
  describeEffect,
  formatEstimatedCost,
} from '../../../components/approvals/approvalFormat';

describe('formatEstimatedCost', () => {
  it('renders null as Unknown, never as a zero amount', () => {
    // NULL IS NOT ZERO. A `spendsMoney` action the gate could not price is not
    // a free action, and this is the figure that decides whether a budget
    // check can run at all.
    expect(formatEstimatedCost(null)).toBe('Unknown');
    expect(formatEstimatedCost(null)).not.toBe('$0.00');
  });

  it('renders a real zero as $0.00, which is a different claim', () => {
    expect(formatEstimatedCost(0)).toBe('$0.00');
  });

  it('renders dollars to two places', () => {
    expect(formatEstimatedCost(1.239)).toBe('$1.24');
  });
});

describe('describeEffect', () => {
  it('flattens every field beside the kind', () => {
    expect(
      describeEffect({
        kind: 'git-push',
        repository: 'acme/api',
        branch: 'feat/x',
        force: false,
        protectedBranch: false,
      }),
    ).toEqual({
      kind: 'git-push',
      detail:
        'repository: acme/api · branch: feat/x · force: false · protectedBranch: false',
    });
  });

  it('renders an effect shape it has never seen rather than nothing', () => {
    // `effects` is a FROZEN record of what a historical action declared, and
    // the union it was written against can widen. A per-kind renderer would
    // show nothing for an unrecognised shape — on the screen whose whole job
    // is to say what the action would do.
    expect(describeEffect({ kind: 'future-thing', shape: { a: 1 } })).toEqual({
      kind: 'future-thing',
      detail: 'shape: {"a":1}',
    });
  });

  it('leaves the detail empty for an effect with no fields', () => {
    expect(describeEffect({ kind: 'spend' }).detail).toBe('');
  });
});
