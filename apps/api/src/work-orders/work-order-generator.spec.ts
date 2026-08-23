import {
  generateWorkOrder,
  type GenerationInput,
  type IssueProjection,
} from './work-order-generator';
import { workOrderIdentity } from './work-order-identity';

const BASE = 'a3f91c2000000000000000000000000000000000';

function issue(overrides: Partial<IssueProjection> = {}): IssueProjection {
  return {
    repository: { owner: 'marinoscar', name: 'opifex' },
    issueNumber: 312,
    title: 'Add widget listing',
    taskSpec: 'Add a paginated GET /api/widgets endpoint.',
    acceptanceCriteria: [
      'GET /api/widgets returns 200 with a paginated list',
      'A request without a token returns 401',
    ],
    pathConstraints: ['apps/api/**'],
    decisionRefs: ['ADR-0002'],
    issueUrl: 'https://github.com/marinoscar/opifex/issues/312',
    ...overrides,
  };
}

function input(overrides: Partial<GenerationInput> = {}): GenerationInput {
  return { issue: issue(), baseCommit: BASE, ...overrides };
}

/** Narrow to the success arm, failing loudly rather than reading undefined. */
function generated(result: ReturnType<typeof generateWorkOrder>) {
  if (!result.ok)
    throw new Error(`Expected generation to succeed: ${result.message}`);
  return result.workOrder;
}

describe('generateWorkOrder', () => {
  describe('the projection', () => {
    it('derives identity and branch from the pinned base', () => {
      const workOrder = generated(generateWorkOrder(input()));

      expect(workOrder.identity).toBe('wo_opifex_312_a3f91c2_a1');
      expect(workOrder.branch).toBe('factory/312-a3f91c2-a1');
    });

    it('is identical for the same issue, commit and attempt', () => {
      // #62: "re-generating for the same issue at the same commit and attempt
      // yields an identical identity."
      expect(generated(generateWorkOrder(input())).identity).toBe(
        generated(generateWorkOrder(input())).identity,
      );
    });

    it('carries the task spec, criteria, constraints and decisions through', () => {
      const workOrder = generated(generateWorkOrder(input()));

      expect(workOrder).toMatchObject({
        taskSpec: 'Add a paginated GET /api/widgets endpoint.',
        pathConstraints: ['apps/api/**'],
        decisionRefs: ['ADR-0002'],
      });
      expect(workOrder.acceptanceCriteria).toHaveLength(2);
    });

    it('stores the criteria it actually assessed, trimmed', () => {
      const workOrder = generated(
        generateWorkOrder(
          input({
            issue: issue({
              acceptanceCriteria: ['  A token is required for access  ', ''],
            }),
          }),
        ),
      );

      expect(workOrder.acceptanceCriteria).toEqual([
        'A token is required for access',
      ]);
    });

    it('keeps the owner, which the identity drops', () => {
      // The identity uses the repository NAME alone, per VISION §4. The owner
      // still has to reach the row, or nothing can find the repository again.
      expect(generated(generateWorkOrder(input())).repositoryOwner).toBe(
        'marinoscar',
      );
    });

    it('defaults ceilings to null rather than to a number nobody chose', () => {
      // Null means "no ceiling set here"; a default number would be a policy
      // decision smuggled in as a fallback.
      const workOrder = generated(generateWorkOrder(input()));

      expect(workOrder.budgetCeilingUsd).toBeNull();
      expect(workOrder.wallClockTimeoutMinutes).toBeNull();
    });

    it('carries ceilings when they are given', () => {
      const workOrder = generated(
        generateWorkOrder(
          input({ budgetCeilingUsd: 5, wallClockTimeoutMinutes: 30 }),
        ),
      );

      expect(workOrder).toMatchObject({
        budgetCeilingUsd: 5,
        wallClockTimeoutMinutes: 30,
      });
    });
  });

  describe('the base commit is pinned, never resolved later', () => {
    it('records exactly the commit it was given', () => {
      // #62: if it were resolved at dispatch, a work order authorized on
      // Monday and run on Tuesday would start from a different tree than the
      // one the authorizer looked at.
      expect(generated(generateWorkOrder(input())).baseCommit).toBe(BASE);
    });

    it('encodes that same commit in the identity', () => {
      // The identity and the row cannot disagree about the base, or the name
      // would have been computed against a commit the run never used.
      const workOrder = generated(generateWorkOrder(input()));

      expect(workOrder.identity).toContain(workOrder.baseCommit.slice(0, 7));
    });

    it('produces a different work order at a different base', () => {
      const moved = generated(
        generateWorkOrder(input({ baseCommit: 'b'.repeat(40) })),
      );

      expect(moved.identity).not.toBe(
        generated(generateWorkOrder(input())).identity,
      );
    });
  });

  describe('attempts', () => {
    it('is the first attempt unless told otherwise', () => {
      expect(generated(generateWorkOrder(input())).attempt).toBe(1);
    });

    it('names a retry distinctly, so it gets its own branch', () => {
      const retry = generated(generateWorkOrder(input({ attempt: 2 })));

      expect(retry.identity).toBe('wo_opifex_312_a3f91c2_a2');
      expect(retry.branch).toBe('factory/312-a3f91c2-a2');
    });

    it('keeps the same base across a retry', () => {
      // Abandon-and-re-run means the same starting tree, a fresh run — not a
      // fresh base (VISION §3.4).
      expect(
        generated(generateWorkOrder(input({ attempt: 2 }))).baseCommit,
      ).toBe(BASE);
    });

    it('agrees with the identity helper', () => {
      const workOrder = generated(generateWorkOrder(input({ attempt: 3 })));

      expect(workOrder.identity).toBe(workOrderIdentity(workOrder.coordinates));
    });
  });

  describe('refusing a spec that cannot be run against', () => {
    it('rejects an issue with no acceptance criteria', () => {
      // VISION §10: "throughput ceiling is spec quality, not token budget."
      const result = generateWorkOrder(
        input({ issue: issue({ acceptanceCriteria: [] }) }),
      );

      expect(result.ok).toBe(false);
      expect(result.ok === false && result.message).toContain(
        'no definition of done',
      );
    });

    it('rejects untestable criteria with the specific reason', () => {
      // #62: "rejected with a specific reason." The reason travels back to a
      // GitHub comment, so the author can fix their issue rather than guess.
      const result = generateWorkOrder(
        input({
          issue: issue({ acceptanceCriteria: ['The endpoint is fast'] }),
        }),
      );

      expect(result.ok).toBe(false);
      expect(result.ok === false && result.message).toContain('is fast');
    });

    it('rejects an issue with no task spec', () => {
      const result = generateWorkOrder(
        input({ issue: issue({ taskSpec: '   ' }) }),
      );

      expect(result.ok).toBe(false);
      expect(result.ok === false && result.message).toContain(
        'nothing to tell a runner to do',
      );
    });

    it('rejects an issue with no link back to itself', () => {
      // #62 makes provenance REQUIRED, not optional. VISION §5: a hole in the
      // chain is not detectable after the fact.
      const result = generateWorkOrder(
        input({ issue: issue({ issueUrl: '' }) }),
      );

      expect(result.ok).toBe(false);
      expect(result.ok === false && result.message).toContain(
        'link back to the issue',
      );
    });

    it('reports every problem at once, not the first one', () => {
      const result = generateWorkOrder(
        input({
          issue: issue({ issueUrl: '', taskSpec: '', acceptanceCriteria: [] }),
        }),
      );

      expect(result.ok === false && result.problems).toHaveLength(3);
    });

    it('returns a result rather than throwing', () => {
      // The rejection is a normal outcome the reconciler will hit regularly,
      // and an exception message is a worse carrier for the reason than a
      // structured list.
      expect(() =>
        generateWorkOrder(input({ issue: issue({ acceptanceCriteria: [] }) })),
      ).not.toThrow();
    });

    it('produces no work order at all when it refuses', () => {
      const result = generateWorkOrder(
        input({ issue: issue({ acceptanceCriteria: ['TBD'] }) }),
      );

      expect(result).not.toHaveProperty('workOrder');
    });
  });

  describe('what it never does', () => {
    it('never names a runner', () => {
      // VISION §6: routing matches needs against advertised capabilities. A
      // work order that named its runner could not be re-dispatched.
      const workOrder = generated(generateWorkOrder(input()));

      expect(Object.keys(workOrder)).not.toContain('runner');
      expect(Object.keys(workOrder)).not.toContain('runnerKey');
    });

    it('reads no clock', () => {
      jest.useFakeTimers().setSystemTime(new Date('2027-06-01T00:00:00Z'));
      const later = generated(generateWorkOrder(input())).identity;
      jest.useRealTimers();

      expect(later).toBe('wo_opifex_312_a3f91c2_a1');
    });
  });
});
