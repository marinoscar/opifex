import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

/**
 * `schemas/run-event.schema.json` and its worked examples.
 *
 * #33 requires the examples validate in CI, and the reason is that an example
 * is a promise: it is what a runner author copies. An example that has drifted
 * out of validity is worse than no example, because it is followed.
 */

const SCHEMA_DIR = join(__dirname, '..', '..', '..', '..', 'schemas');
const EXAMPLE_DIR = join(SCHEMA_DIR, 'examples', 'run-event');

const schema = JSON.parse(
  readFileSync(join(SCHEMA_DIR, 'run-event.schema.json'), 'utf8'),
) as Record<string, unknown>;

function buildValidator(): ValidateFunction {
  // Draft 2020-12 needs ajv's 2020 entry point; the default export only knows
  // draft-07 and would silently ignore `unevaluatedProperties`, which is the
  // keyword doing most of the work in this schema.
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

/** A minimal valid event, for tests that mutate one field at a time. */
function baseEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: '1.0.0',
    eventId: 'evt-1',
    runId: '018f2c31-7a4e-7c3b-9f21-4d5e6a7b8c9d',
    workOrderId: 'wo_opifex_312_a3f91c2_a1',
    type: 'run.heartbeat',
    source: 'runner-reported',
    occurredAt: '2026-08-21T10:00:00.000Z',
    ...overrides,
  };
}

describe('run-event.schema.json', () => {
  let validate: ValidateFunction;

  beforeAll(() => {
    validate = buildValidator();
  });

  it('compiles under draft 2020-12 in strict mode', () => {
    // Strict mode rejects unknown keywords and mistyped ones, so a typo in the
    // schema fails here rather than silently disabling a constraint.
    expect(() => buildValidator()).not.toThrow();
  });

  describe('the worked examples', () => {
    const files = readdirSync(EXAMPLE_DIR).filter((f) => f.endsWith('.json'));

    it('found the examples', () => {
      // Guards the guard: an empty directory would make every case below pass
      // vacuously.
      expect(files.length).toBeGreaterThanOrEqual(10);
    });

    it.each(files)('%s validates', (file) => {
      const event = JSON.parse(readFileSync(join(EXAMPLE_DIR, file), 'utf8'));

      const valid = validate(event);
      if (!valid) {
        throw new Error(
          `${file} does not validate:\n${JSON.stringify(validate.errors, null, 2)}`,
        );
      }
      expect(valid).toBe(true);
    });

    it('covers all six event types across the examples', () => {
      // The floor is only demonstrated if every type has a worked example.
      const types = new Set(
        files.map((f) => JSON.parse(readFileSync(join(EXAMPLE_DIR, f), 'utf8')).type),
      );

      expect([...types].sort()).toEqual([
        'run.blocked',
        'run.completed',
        'run.failed',
        'run.heartbeat',
        'run.progress',
        'run.started',
      ]);
    });

    it('covers all three sources across the examples', () => {
      const sources = new Set(
        files.map((f) => JSON.parse(readFileSync(join(EXAMPLE_DIR, f), 'utf8')).source),
      );

      expect([...sources].sort()).toEqual([
        'control-plane-synthesized',
        'git-derived',
        'runner-reported',
      ]);
    });

    it('includes a streaming example carrying a tool signature', () => {
      // #33 requires this specifically: loop detection (#55) is built entirely
      // on the field, and an example without it would not show a runner author
      // what to send.
      const withTool = files
        .map((f) => JSON.parse(readFileSync(join(EXAMPLE_DIR, f), 'utf8')))
        .filter((e) => e.tool !== undefined);

      expect(withTool.length).toBeGreaterThanOrEqual(1);
      expect(withTool[0].tool).toMatchObject({
        name: expect.any(String),
        signature: expect.any(String),
      });
    });

    it('includes a non-streaming example that carries NO tool signature', () => {
      // The contrast is the point: VISION §6 says equal observability across
      // vendors is not achievable, and these files are what the floor looks
      // like from underneath.
      const gitDerived = files
        .map((f) => JSON.parse(readFileSync(join(EXAMPLE_DIR, f), 'utf8')))
        .filter((e) => e.source === 'git-derived');

      expect(gitDerived.length).toBeGreaterThanOrEqual(1);
      for (const event of gitDerived) {
        expect(event.tool).toBeUndefined();
      }
    });
  });

  describe('source is load-bearing', () => {
    it('rejects an event with no source', () => {
      // VISION §9: a synthesized event must never masquerade as a report. A
      // sender that omits this gets an error, not a plausible assumption.
      const { source, ...withoutSource } = baseEvent();
      expect(source).toBeDefined();

      expect(validate(withoutSource)).toBe(false);
    });

    it('rejects a source outside the three', () => {
      expect(validate(baseEvent({ source: 'inferred' }))).toBe(false);
    });

    it('has no default for source anywhere in the schema', () => {
      // A default would let an omitted source be filled in, which is exactly
      // the masquerade the field exists to prevent.
      const properties = schema.properties as Record<string, Record<string, unknown>>;
      expect(properties.source.default).toBeUndefined();
    });
  });

  describe('the six types are closed', () => {
    it('rejects a seventh type', () => {
      // A floor that grows on demand is not a floor. Adding one is a version
      // bump, deliberately.
      expect(validate(baseEvent({ type: 'run.paused' }))).toBe(false);
    });

    it.each([
      'run.started',
      'run.heartbeat',
      'run.progress',
      'run.completed',
    ])('accepts %s with no type-specific payload', (type) => {
      expect(validate(baseEvent({ type }))).toBe(true);
    });
  });

  describe('run.blocked', () => {
    it('REQUIRES the blocked object', () => {
      // Without a reason and a reset time, "park and auto-resume" is
      // indistinguishable from "kill and re-run" — VISION §9's three failure
      // modes collapse into two, which it calls the most common supervision
      // bug.
      expect(validate(baseEvent({ type: 'run.blocked' }))).toBe(false);
    });

    it('accepts a reason with a reset time', () => {
      expect(
        validate(
          baseEvent({
            type: 'run.blocked',
            blocked: { reason: 'rate-limit', resetAt: '2026-08-21T18:00:00.000Z' },
          }),
        ),
      ).toBe(true);
    });

    it('accepts `unknown` with NO reset time', () => {
      // Permitted on purpose: a run blocked for a reason the runner cannot
      // name still parks. #56 escalates it rather than parking forever,
      // because nothing can compute when it would resume.
      expect(validate(baseEvent({ type: 'run.blocked', blocked: { reason: 'unknown' } }))).toBe(
        true,
      );
    });

    it('rejects an unrecognised reason', () => {
      expect(
        validate(baseEvent({ type: 'run.blocked', blocked: { reason: 'feeling-slow' } })),
      ).toBe(false);
    });
  });

  describe('run.failed', () => {
    it('requires a failure reason', () => {
      expect(validate(baseEvent({ type: 'run.failed' }))).toBe(false);
    });

    it('accepts a reason with the advisory retryable flag', () => {
      expect(
        validate(
          baseEvent({ type: 'run.failed', failure: { reason: 'tests red', retryable: true } }),
        ),
      ).toBe(true);
    });
  });

  describe('run.progress tool signature', () => {
    it('is optional, because a non-streaming runner cannot supply it', () => {
      expect(validate(baseEvent({ type: 'run.progress' }))).toBe(true);
    });

    it('requires both name and signature when present', () => {
      expect(validate(baseEvent({ type: 'run.progress', tool: { name: 'Bash' } }))).toBe(false);
    });

    it('accepts a full tool object', () => {
      expect(
        validate(
          baseEvent({
            type: 'run.progress',
            tool: { name: 'Bash', signature: 'sha256:abc', phase: 'running tests' },
          }),
        ),
      ).toBe(true);
    });
  });

  describe('cost', () => {
    it('is absent rather than zero when not reported', () => {
      // VISION §6 makes cost reporting a declared capability, so a runner that
      // cannot report must not look like one that spent nothing.
      expect(validate(baseEvent())).toBe(true);
    });

    it('rejects a negative cost', () => {
      expect(validate(baseEvent({ cost: { usd: -1 } }))).toBe(false);
    });
  });

  describe('identity and idempotency', () => {
    it('requires an eventId, which is what makes ingestion idempotent', () => {
      const { eventId, ...withoutId } = baseEvent();
      expect(eventId).toBeDefined();

      expect(validate(withoutId)).toBe(false);
    });

    it('requires a uuid runId', () => {
      expect(validate(baseEvent({ runId: 'not-a-uuid' }))).toBe(false);
    });

    it('requires occurredAt to be a real timestamp', () => {
      expect(validate(baseEvent({ occurredAt: 'yesterday' }))).toBe(false);
    });

    it('pins the schema version', () => {
      expect(validate(baseEvent({ schemaVersion: '2.0.0' }))).toBe(false);
    });
  });

  describe('unknown fields', () => {
    it('are rejected, so a typo is not silently accepted', () => {
      // `occuredAt` (one r) would otherwise be stored as an unknown field and
      // the event would carry no timestamp at all.
      expect(validate(baseEvent({ occuredAt: '2026-08-21T10:00:00.000Z' }))).toBe(false);
    });

    it('are rejected inside the nested objects too', () => {
      expect(
        validate(
          baseEvent({
            type: 'run.blocked',
            blocked: { reason: 'rate-limit', resetsAt: '2026-08-21T18:00:00.000Z' },
          }),
        ),
      ).toBe(false);
    });
  });
});
