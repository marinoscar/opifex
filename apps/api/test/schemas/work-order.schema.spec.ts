import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

import {
  workOrderBranch,
  workOrderIdentity,
} from '../../src/work-orders/work-order-identity';

/**
 * `schemas/work-order.schema.json` and its worked examples.
 *
 * #31 requires the examples validate in CI. An example is a promise: it is
 * what somebody copies. One that has drifted out of validity is worse than no
 * example, because it gets followed.
 *
 * This suite also pins the schema against the GENERATOR (#62). The schema
 * describes the format; the code produces it. A description that rejects the
 * real thing is a trap, and the two drifting apart is the single most likely
 * way this schema stops being true.
 */

const SCHEMA_DIR = join(__dirname, '..', '..', '..', '..', 'schemas');
const EXAMPLE_DIR = join(SCHEMA_DIR, 'examples', 'work-order');

const schema = JSON.parse(
  readFileSync(join(SCHEMA_DIR, 'work-order.schema.json'), 'utf8'),
) as Record<string, unknown>;

function buildValidator(): ValidateFunction {
  // Draft 2020-12 needs ajv's 2020 entry point; the default export only knows
  // draft-07 and would silently ignore `unevaluatedProperties` — the keyword
  // enforcing "there is no runner field".
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

/** A minimal valid work order, for tests that mutate one field at a time. */
function workOrder(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: '1.0.0',
    identity: 'wo_opifex_312_a3f91c2_a1',
    branch: 'factory/312-a3f91c2-a1',
    repository: { owner: 'marinoscar', name: 'opifex' },
    baseCommit: 'a3f91c2000000000000000000000000000000000',
    attempt: 1,
    issue: { number: 312, url: 'https://github.com/marinoscar/opifex/issues/312' },
    taskSpec: 'Add the endpoint.',
    acceptanceCriteria: ['GET /api/widgets returns 200 with a paginated list'],
    pathConstraints: [],
    budgetCeilingUsd: null,
    wallClockTimeoutMinutes: null,
    needs: [],
    ...overrides,
  };
}

describe('work-order.schema.json', () => {
  let validate: ValidateFunction;

  beforeAll(() => {
    validate = buildValidator();
  });

  const errors = (candidate: unknown) => (validate(candidate) ? [] : validate.errors);

  it('compiles under strict draft 2020-12', () => {
    expect(() => buildValidator()).not.toThrow();
  });

  describe('the worked examples', () => {
    const files = readdirSync(EXAMPLE_DIR).filter((name) => name.endsWith('.json'));

    it('there are some', () => {
      expect(files.length).toBeGreaterThan(0);
    });

    it.each(files)('%s validates', (file) => {
      const example = JSON.parse(readFileSync(join(EXAMPLE_DIR, file), 'utf8'));

      expect(errors(example)).toEqual([]);
    });

    it('covers a retry at the same base', () => {
      // The case that proves abandon-and-re-run: a fresh attempt against the
      // SAME tree, not a fresh base.
      const retry = JSON.parse(readFileSync(join(EXAMPLE_DIR, 'retry.json'), 'utf8'));

      expect(retry.attempt).toBeGreaterThan(1);
      expect(retry.identity).toContain('_a3');
      expect(retry.baseCommit).toBe(workOrder().baseCommit);
    });
  });

  describe('agreeing with the generator', () => {
    it('accepts an identity the generator produced', () => {
      // #62 owns the format; this schema describes it. The description must
      // not reject the real thing.
      const identity = workOrderIdentity({
        repository: 'opifex',
        issueNumber: 312,
        baseCommit: 'a3f91c2000000000000000000000000000000000',
        attempt: 1,
      });

      expect(errors(workOrder({ identity }))).toEqual([]);
    });

    it('accepts a branch the generator produced', () => {
      const coordinates = {
        repository: 'my_repo.name',
        issueNumber: 4096,
        baseCommit: 'b'.repeat(40),
        attempt: 12,
      };

      expect(
        errors(
          workOrder({
            identity: workOrderIdentity(coordinates),
            branch: workOrderBranch(coordinates),
          }),
        ),
      ).toEqual([]);
    });
  });

  describe('there is no runner field, and there cannot be one', () => {
    it('rejects a work order naming a runner', () => {
      // VISION §6. A work order that named its runner could not be
      // re-dispatched when that runner was at capacity, which is most of the
      // value of having a seam.
      expect(errors(workOrder({ runner: 'claude-code-local' }))).not.toEqual([]);
    });

    it.each(['runnerKey', 'runnerId', 'assignedRunner', 'executor'])(
      'rejects %s too, via unevaluatedProperties',
      (field) => {
        expect(errors(workOrder({ [field]: 'anything' }))).not.toEqual([]);
      },
    );

    it('mentions no runner anywhere in the property list', () => {
      const properties = Object.keys(schema.properties as Record<string, unknown>);

      expect(properties.join(' ').toLowerCase()).not.toContain('runner');
    });

    it('expresses what it needs instead', () => {
      expect(errors(workOrder({ needs: ['full-streaming'] }))).toEqual([]);
    });

    it('rejects a need nothing advertises', () => {
      // Closed enum, so a typo fails loudly at generation rather than
      // silently matching every runner.
      expect(errors(workOrder({ needs: ['ful-streaming'] }))).not.toEqual([]);
    });
  });

  describe('provenance cannot be omitted', () => {
    it('rejects a work order with no issue', () => {
      // §4 makes a work order a projection of an issue, never an independent
      // source of truth. There is no way to express one that came from
      // nowhere.
      const { issue: _dropped, ...orphan } = workOrder();

      expect(errors(orphan)).not.toEqual([]);
    });

    it('rejects an issue with no url', () => {
      expect(errors(workOrder({ issue: { number: 312 } }))).not.toEqual([]);
    });

    it('rejects an issue with no number', () => {
      expect(
        errors(workOrder({ issue: { url: 'https://github.com/x/y/issues/1' } })),
      ).not.toEqual([]);
    });

    it('accepts optional decision references', () => {
      expect(errors(workOrder({ decisionRefs: ['ADR-0005'] }))).toEqual([]);
    });

    it('rejects a malformed decision reference', () => {
      expect(errors(workOrder({ decisionRefs: ['ADR-5'] }))).not.toEqual([]);
    });
  });

  describe('the ceilings are required, and nullable', () => {
    it.each(['budgetCeilingUsd', 'wallClockTimeoutMinutes'])(
      'rejects a work order with no %s',
      (field) => {
        // Required-and-nullable on purpose: null means somebody decided there
        // is no ceiling. Optional would let an unbounded work order look
        // identical to one nobody thought about.
        const candidate = workOrder();
        delete candidate[field];

        expect(errors(candidate)).not.toEqual([]);
      },
    );

    it('accepts an explicit null', () => {
      expect(errors(workOrder({ budgetCeilingUsd: null }))).toEqual([]);
    });

    it('accepts a real ceiling', () => {
      expect(errors(workOrder({ budgetCeilingUsd: 5, wallClockTimeoutMinutes: 30 }))).toEqual([]);
    });

    it('rejects a negative budget', () => {
      expect(errors(workOrder({ budgetCeilingUsd: -1 }))).not.toEqual([]);
    });

    it('rejects a zero-minute timeout', () => {
      expect(errors(workOrder({ wallClockTimeoutMinutes: 0 }))).not.toEqual([]);
    });
  });

  describe('acceptance criteria', () => {
    it('rejects an empty list', () => {
      // §10: throughput ceiling is spec quality. A work order with no
      // definition of done cannot produce a run that FAILS — only one that
      // produces something nobody can check.
      expect(errors(workOrder({ acceptanceCriteria: [] }))).not.toEqual([]);
    });

    it('rejects a missing list', () => {
      const candidate = workOrder();
      delete candidate.acceptanceCriteria;

      expect(errors(candidate)).not.toEqual([]);
    });

    it('rejects an empty string among them', () => {
      expect(errors(workOrder({ acceptanceCriteria: [''] }))).not.toEqual([]);
    });
  });

  describe('the pinned base', () => {
    it('rejects an abbreviated SHA', () => {
      // Ambiguous the moment the repository grows, and this has to still
      // resolve to one commit in a year.
      expect(errors(workOrder({ baseCommit: 'a3f91c2' }))).not.toEqual([]);
    });

    it('rejects a non-hex SHA', () => {
      expect(errors(workOrder({ baseCommit: 'z'.repeat(40) }))).not.toEqual([]);
    });

    it('rejects an uppercase SHA', () => {
      // One canonical spelling, so two work orders for the same base cannot
      // differ by case.
      expect(errors(workOrder({ baseCommit: 'A'.repeat(40) }))).not.toEqual([]);
    });
  });

  describe('identity and branch are patterns, not prose', () => {
    it.each([
      ['wo_opifex_312_a3f91c2', 'no attempt'],
      ['wo_opifex_312_a3f91c2_1', 'no a prefix'],
      ['wo_opifex_312_a3f91c2_a0', 'a zeroth attempt'],
      ['wo_Opifex_312_a3f91c2_a1', 'an unslugged repository'],
      ['wo_opifex_0_a3f91c2_a1', 'issue zero'],
    ])('rejects identity %s (%s)', (identity) => {
      expect(errors(workOrder({ identity }))).not.toEqual([]);
    });

    it.each([
      ['312-a3f91c2-a1', 'no factory/ prefix'],
      ['factory/312-a3f91c2', 'no attempt'],
      ['factory/opifex-312-a3f91c2-a1', 'a repository name that does not belong'],
    ])('rejects branch %s (%s)', (branch) => {
      expect(errors(workOrder({ branch }))).not.toEqual([]);
    });
  });

  describe('the version', () => {
    it('rejects a different schema version', () => {
      expect(errors(workOrder({ schemaVersion: '2.0.0' }))).not.toEqual([]);
    });
  });
});
