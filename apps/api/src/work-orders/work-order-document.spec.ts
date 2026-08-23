import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

import {
  EXECUTION_RECORD_PATH,
  executionRecordCommitMessage,
  serializeWorkOrder,
  toWorkOrderDocument,
} from './work-order-document';
import {
  generateWorkOrder,
  type IssueProjection,
} from './work-order-generator';

const SCHEMA = JSON.parse(
  readFileSync(
    join(__dirname, '../../../../schemas/work-order.schema.json'),
    'utf8',
  ),
) as Record<string, unknown>;

const PROVENANCE = readFileSync(
  join(__dirname, '../../../../docs/PROVENANCE.md'),
  'utf8',
);

const BASE = 'a3f91c2000000000000000000000000000000000';

function issue(overrides: Partial<IssueProjection> = {}): IssueProjection {
  return {
    repository: { owner: 'marinoscar', name: 'opifex' },
    issueNumber: 312,
    title: 'Add widget listing',
    taskSpec: 'Add a paginated GET /api/widgets endpoint.',
    acceptanceCriteria: ['GET /api/widgets returns 200 with a paginated list'],
    pathConstraints: ['apps/api/**'],
    decisionRefs: ['ADR-0005'],
    issueUrl: 'https://github.com/marinoscar/opifex/issues/312',
    ...overrides,
  };
}

function generated(overrides: Partial<IssueProjection> = {}) {
  const result = generateWorkOrder({
    issue: issue(overrides),
    baseCommit: BASE,
  });
  if (!result.ok)
    throw new Error(`Expected generation to succeed: ${result.message}`);
  return result.workOrder;
}

describe('the work-order document', () => {
  let validate: ValidateFunction;

  beforeAll(() => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    validate = ajv.compile(SCHEMA);
  });

  const errors = (candidate: unknown) =>
    validate(candidate) ? [] : validate.errors;

  describe('it validates against the real schema', () => {
    it('a generated work order serializes to a valid document', () => {
      // #63: "the fenced JSON validates against the work-order schema (#31)."
      // Against the actual schema file, from actual generator output — the
      // two have to agree in practice, not in principle.
      expect(errors(toWorkOrderDocument(generated()))).toEqual([]);
    });

    it('validates with no optional fields set', () => {
      expect(
        errors(
          toWorkOrderDocument(
            generated({ decisionRefs: [], pathConstraints: [] }),
          ),
        ),
      ).toEqual([]);
    });

    it('validates a retry', () => {
      const result = generateWorkOrder({
        issue: issue(),
        baseCommit: BASE,
        attempt: 4,
      });
      if (!result.ok) throw new Error('unreachable');

      expect(errors(toWorkOrderDocument(result.workOrder))).toEqual([]);
    });

    it('validates with ceilings and needs', () => {
      const result = generateWorkOrder({
        issue: issue({ needs: ['full-streaming', 'cost-reporting'] }),
        baseCommit: BASE,
        budgetCeilingUsd: 5,
        wallClockTimeoutMinutes: 30,
      });
      if (!result.ok) throw new Error('unreachable');

      expect(errors(toWorkOrderDocument(result.workOrder))).toEqual([]);
    });

    it('carries the issue url the generator validated', () => {
      // Validating a field and then dropping it was a real gap: the schema
      // requires issue.url, and the authorization record is posted to the
      // very issue it names.
      expect(toWorkOrderDocument(generated()).issue.url).toBe(issue().issueUrl);
    });

    it('names no runner', () => {
      // The schema rejects one via unevaluatedProperties; this asserts the
      // serializer never tries.
      expect(Object.keys(toWorkOrderDocument(generated()))).not.toContain(
        'runner',
      );
    });
  });

  describe('one serialization, two destinations', () => {
    it('is deterministic', () => {
      // Byte-identity between the two records is only structural if this is.
      expect(serializeWorkOrder(generated())).toBe(
        serializeWorkOrder(generated()),
      );
    });

    it('is readable in a diff and in a fenced block', () => {
      // These bytes are committed to a branch and shown to a human. Compact
      // JSON would satisfy the schema and be unreadable in both places.
      const document = serializeWorkOrder(generated());

      expect(document).toContain('\n  "identity"');
      expect(document.endsWith('\n')).toBe(true);
    });

    it('round-trips through JSON unchanged', () => {
      const document = serializeWorkOrder(generated());

      expect(JSON.parse(document)).toEqual(toWorkOrderDocument(generated()));
    });
  });

  describe('the execution record commit message', () => {
    const message = () =>
      executionRecordCommitMessage({
        workOrder: generated(),
        runnerKey: 'claude-code-local',
        runnerVersion: '2.1.223',
        runId: '018f2c31-7a4e-7c3b-9f21-4d5e6a7b8c9d',
      });

    it('carries the full agent trailer block', () => {
      // docs/PROVENANCE.md: the five agent trailers are all-or-nothing. A
      // commit carrying Runner: and no Run-Id: is malformed, not partially
      // compliant.
      for (const trailer of [
        'Work-Order:',
        'Issue:',
        'Runner:',
        'Run-Id:',
        'Attempt:',
      ]) {
        expect(message()).toContain(trailer);
      }
    });

    it('puts the trailers last, as git requires', () => {
      const lines = message().trimEnd().split('\n');

      expect(lines[lines.length - 1]).toMatch(/^Attempt: \d+$/);
    });

    it('separates the trailer block from the body by a blank line', () => {
      const lines = message().split('\n');
      const first = lines.findIndex((line) => line.startsWith('Work-Order:'));

      expect(lines[first - 1]).toBe('');
    });

    it('matches the documented patterns', () => {
      // Pinned against the spec rather than against a literal, so a change to
      // either has to be a change to both.
      const documented = (trailer: string) => {
        const section = PROVENANCE.slice(
          PROVENANCE.indexOf(`### \`${trailer}:\``),
        );
        const pattern = /matching `\^([^`]+)\$`/.exec(
          section.slice(0, 700),
        )![1];
        return new RegExp(`^${pattern}$`);
      };

      const values = Object.fromEntries(
        message()
          .split('\n')
          .filter((line) => /^[A-Z][A-Za-z-]*: /.test(line))
          .map((line) => [
            line.slice(0, line.indexOf(':')),
            line.slice(line.indexOf(': ') + 2),
          ]),
      );

      for (const trailer of [
        'Work-Order',
        'Issue',
        'Runner',
        'Run-Id',
        'Attempt',
      ]) {
        expect(values[trailer]).toMatch(documented(trailer));
      }
    });

    it('carries at most one Decision:, as the vocabulary requires', () => {
      // "A key appears at most once. Two Issue: trailers is an error, not a
      // list." The same rule applies to Decision:, so a work order resting on
      // several ADRs names the primary one rather than emitting duplicates.
      const withMany = generateWorkOrder({
        issue: issue({ decisionRefs: ['ADR-0001', 'ADR-0005', 'ADR-0006'] }),
        baseCommit: BASE,
      });
      if (!withMany.ok) throw new Error('unreachable');

      const rendered = executionRecordCommitMessage({
        workOrder: withMany.workOrder,
        runnerKey: 'claude-code-local',
        runnerVersion: '2.1.223',
        runId: '018f2c31-7a4e-7c3b-9f21-4d5e6a7b8c9d',
      });

      expect(rendered.match(/^Decision: /gm)).toHaveLength(1);
    });

    it('omits Decision: entirely when there is none', () => {
      const rendered = executionRecordCommitMessage({
        workOrder: generated({ decisionRefs: [] }),
        runnerKey: 'claude-code-local',
        runnerVersion: '2.1.223',
        runId: '018f2c31-7a4e-7c3b-9f21-4d5e6a7b8c9d',
      });

      expect(rendered).not.toContain('Decision:');
    });

    it('says what the commit IS, for somebody reading git log in six months', () => {
      expect(message()).toContain('what the runner was GIVEN');
    });

    it('names the work order in the subject line', () => {
      expect(message().split('\n')[0]).toContain('wo_opifex_312_a3f91c2_a1');
    });
  });

  describe('where the record lives', () => {
    it('is a fixed path, so it can be read back without searching', () => {
      expect(EXECUTION_RECORD_PATH).toBe('.opifex/work-order.json');
    });
  });
});
