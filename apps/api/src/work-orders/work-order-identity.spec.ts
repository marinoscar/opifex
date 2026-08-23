import {
  COMMIT_PREFIX_LENGTH,
  nextAttempt,
  parseWorkOrderIdentity,
  workOrderBranch,
  workOrderIdentity,
  type WorkOrderCoordinates,
} from './work-order-identity';

const BASE = 'a3f91c2000000000000000000000000000000000';

function coordinates(
  overrides: Partial<WorkOrderCoordinates> = {},
): WorkOrderCoordinates {
  return {
    repository: 'opifex',
    issueNumber: 312,
    baseCommit: BASE,
    attempt: 1,
    ...overrides,
  };
}

describe('workOrderIdentity', () => {
  it('matches the format VISION §4 specifies', () => {
    expect(workOrderIdentity(coordinates())).toBe('wo_opifex_312_a3f91c2_a1');
  });

  it('uses exactly seven characters of the base commit', () => {
    expect(COMMIT_PREFIX_LENGTH).toBe(7);
    expect(workOrderIdentity(coordinates())).toContain(BASE.slice(0, 7));
    expect(workOrderIdentity(coordinates())).not.toContain(BASE.slice(0, 8));
  });

  describe('determinism, which the whole recovery model rests on', () => {
    it('gives the same answer every time', () => {
      // VISION §3.4 makes recovery abandon-and-re-run rather than session
      // resumption, and that only works if a re-run is idempotent.
      expect(workOrderIdentity(coordinates())).toBe(
        workOrderIdentity(coordinates()),
      );
    });

    it('reads no clock and no randomness', () => {
      // A function that answered differently on Tuesday would make the
      // recovery model unsound. Asserted by moving the clock rather than by
      // reading the source.
      jest.useFakeTimers().setSystemTime(new Date('2027-01-01T00:00:00Z'));
      const later = workOrderIdentity(coordinates());
      jest.useRealTimers();

      expect(later).toBe('wo_opifex_312_a3f91c2_a1');
    });
  });

  describe('what makes it a DIFFERENT work order', () => {
    it('a different base commit', () => {
      // Correct, and load-bearing: the same task against a different starting
      // tree is different work, and reusing the branch would rebase somebody's
      // changes by accident.
      expect(
        workOrderIdentity(coordinates({ baseCommit: 'b'.repeat(40) })),
      ).not.toBe(workOrderIdentity(coordinates()));
    });

    it('a different attempt', () => {
      expect(workOrderIdentity(coordinates({ attempt: 2 }))).toBe(
        'wo_opifex_312_a3f91c2_a2',
      );
    });

    it('a different issue', () => {
      expect(workOrderIdentity(coordinates({ issueNumber: 313 }))).toBe(
        'wo_opifex_313_a3f91c2_a1',
      );
    });
  });

  describe('names that would break the format', () => {
    it('lowercases, so case alone cannot make two identities', () => {
      expect(workOrderIdentity(coordinates({ repository: 'Opifex' }))).toBe(
        workOrderIdentity(coordinates({ repository: 'opifex' })),
      );
    });

    it('replaces underscores, which are the separator', () => {
      // `my_repo` would otherwise produce an identity that parses back wrong.
      expect(workOrderIdentity(coordinates({ repository: 'my_repo' }))).toBe(
        'wo_my-repo_312_a3f91c2_a1',
      );
    });

    it('replaces dots, which invite someone to split on them', () => {
      expect(workOrderIdentity(coordinates({ repository: 'my.repo' }))).toBe(
        'wo_my-repo_312_a3f91c2_a1',
      );
    });

    it('leaves no leading or trailing separator', () => {
      expect(workOrderIdentity(coordinates({ repository: '__repo__' }))).toBe(
        'wo_repo_312_a3f91c2_a1',
      );
    });
  });

  describe('refusing to name what cannot be named', () => {
    it('rejects an abbreviated base commit', () => {
      // An abbreviated base is ambiguous the moment the repository grows, and
      // this identity has to still resolve to one commit in a year.
      expect(() =>
        workOrderIdentity(coordinates({ baseCommit: 'a3f91c2' })),
      ).toThrow(/full 40-character SHA/);
    });

    it('rejects a base commit that is not hex', () => {
      expect(() =>
        workOrderIdentity(coordinates({ baseCommit: 'z'.repeat(40) })),
      ).toThrow(/full 40-character SHA/);
    });

    it.each([0, -1, 1.5])('rejects issue number %s', (issueNumber) => {
      expect(() => workOrderIdentity(coordinates({ issueNumber }))).toThrow(
        /positive integer/,
      );
    });

    it.each([0, -1])('rejects attempt %s', (attempt) => {
      expect(() => workOrderIdentity(coordinates({ attempt }))).toThrow(
        /positive integer/,
      );
    });

    it('rejects a repository name with nothing usable in it', () => {
      // Throwing rather than coercing: every downstream use reads this string
      // back, and a silently mangled identity correlates with nothing.
      expect(() =>
        workOrderIdentity(coordinates({ repository: '///' })),
      ).toThrow(/no usable characters/);
    });
  });
});

describe('workOrderBranch', () => {
  it('matches the format VISION §4 specifies', () => {
    expect(workOrderBranch(coordinates())).toBe('factory/312-a3f91c2-a1');
  });

  it('sits under the factory/ prefix runners declare', () => {
    // So a branch Opifex created is distinguishable from one a human made, at
    // a glance and by a glob.
    expect(workOrderBranch(coordinates())).toMatch(/^factory\//);
  });

  it('omits the repository, which the branch already lives in', () => {
    expect(workOrderBranch(coordinates())).not.toContain('opifex');
  });

  it('is derived from the same coordinates as the identity', () => {
    // The idempotency is the naming scheme, not a lock: two dispatches of the
    // same work compute the same branch, and the second runner finds the
    // first one's branch already there.
    const identity = workOrderIdentity(coordinates());
    const branch = workOrderBranch(coordinates());

    expect(identity).toContain('a3f91c2');
    expect(branch).toContain('a3f91c2');
  });

  it('changes with the base commit, so a moved base gets a fresh branch', () => {
    expect(
      workOrderBranch(coordinates({ baseCommit: 'b'.repeat(40) })),
    ).not.toBe(workOrderBranch(coordinates()));
  });
});

describe('parseWorkOrderIdentity', () => {
  it('reads an identity back apart', () => {
    expect(parseWorkOrderIdentity('wo_opifex_312_a3f91c2_a1')).toEqual({
      repository: 'opifex',
      issueNumber: 312,
      baseCommit: 'a3f91c2',
      attempt: 1,
    });
  });

  it('round-trips a slugged repository name as the slug', () => {
    // Not the inverse of generation, and the doc says so: the original name is
    // gone by the time it reaches the string.
    const identity = workOrderIdentity(coordinates({ repository: 'my_repo' }));

    expect(parseWorkOrderIdentity(identity)?.repository).toBe('my-repo');
  });

  it('handles a repository name containing a dash', () => {
    expect(parseWorkOrderIdentity('wo_my-repo_9_abc1234_a3')).toMatchObject({
      repository: 'my-repo',
      issueNumber: 9,
      attempt: 3,
    });
  });

  it.each([
    ['wo_opifex_312_a3f91c2', 'no attempt'],
    ['opifex_312_a3f91c2_a1', 'no prefix'],
    ['wo_opifex_312_XYZ1234_a1', 'a non-hex commit'],
    ['wo_opifex_abc_a3f91c2_a1', 'a non-numeric issue'],
    ['', 'nothing at all'],
  ])('returns null for %s (%s)', (identity) => {
    // Strict on purpose: a half-filled object is something somebody then
    // treats as real.
    expect(parseWorkOrderIdentity(identity)).toBeNull();
  });
});

describe('nextAttempt', () => {
  it('increments only the attempt', () => {
    // One obvious way for the retry policy to say "again" without re-deriving
    // coordinates and risking a different base.
    expect(nextAttempt(coordinates())).toEqual(coordinates({ attempt: 2 }));
  });

  it('keeps the base pinned across a retry', () => {
    // The point of abandon-and-re-run: the same starting tree, a fresh run.
    expect(nextAttempt(coordinates()).baseCommit).toBe(BASE);
  });

  it('does not mutate what it was given', () => {
    const original = coordinates();
    nextAttempt(original);

    expect(original.attempt).toBe(1);
  });
});
