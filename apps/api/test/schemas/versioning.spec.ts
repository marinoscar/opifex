import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CONTRACTS,
  SCHEMA_DIR,
  validatorFor,
  type Contract,
} from './contract-validators';

/**
 * The compatibility policy from ADR-0010, asserted rather than described.
 *
 * The policy's whole value is one promise — *a document written against an
 * earlier minor still validates after the schema moves on* — and a promise
 * stated only in a markdown file is one nobody finds out is broken until a
 * re-run fails. VISION §3.4's recovery model is abandon-and-re-run from the
 * pinned base commit, so an old work order being unreadable is not a
 * compatibility inconvenience, it is a lost recovery path.
 *
 * `runner-capability` is the first schema to move (1.0.0 -> 1.1.0, adding
 * `speaksSchemaVersions`), so it is the case that actually exercises the rule
 * rather than asserting it vacuously.
 */

interface SchemaShape {
  properties: {
    schemaVersion: { pattern?: string; default?: string; const?: string };
    [key: string]: unknown;
  };
}

function schemaFor(contract: Contract): SchemaShape {
  return JSON.parse(
    readFileSync(join(SCHEMA_DIR, `${contract}.schema.json`), 'utf8'),
  ) as SchemaShape;
}

/**
 * A manifest built from the worked example rather than invented here.
 *
 * The example is the one `claude-code-local` actually publishes, and it is
 * already asserted valid by the conformance suite — so a fixture derived from
 * it cannot drift into using enum values the schema never had, which is
 * exactly what a hand-written one does the first time an enum is renamed.
 */
function manifest(overrides: Record<string, unknown> = {}) {
  const example = JSON.parse(
    readFileSync(
      join(
        SCHEMA_DIR,
        'examples',
        'runner-capability',
        'claude-code-local.json',
      ),
      'utf8',
    ),
  ) as Record<string, unknown>;
  return { ...example, ...overrides };
}

describe('schema versioning (ADR-0010)', () => {
  describe('every schema states its version the same way', () => {
    it.each([...CONTRACTS])(
      '%s accepts the 1.x range, not one exact version',
      (contract) => {
        const { schemaVersion } = schemaFor(contract).properties;

        // `const` would mean the schema accepts exactly one version, which is
        // what ADR-0010 replaced: under it, no rollout has a moment where a
        // producer and a consumer can both be valid.
        expect(schemaVersion.const).toBeUndefined();
        expect(schemaVersion.pattern).toBe('^1\\.\\d+\\.\\d+$');
      },
    );

    it.each([...CONTRACTS])(
      '%s names the version a producer should write',
      (contract) => {
        const { schemaVersion } = schemaFor(contract).properties;

        expect(schemaVersion.default).toMatch(/^\d+\.\d+\.\d+$/);
        // The version to write must itself be a version the schema accepts —
        // trivially true today and the first thing a careless bump breaks.
        expect(schemaVersion.default!).toMatch(
          new RegExp(schemaVersion.pattern!),
        );
      },
    );
  });

  describe('a document from an earlier minor still validates', () => {
    it('accepts a 1.0.0 manifest against the 1.1.0 schema', () => {
      // The real case, not a hypothetical: runner-capability moved to 1.1.0 by
      // adding `speaksSchemaVersions`, and this is a manifest written before
      // that field existed.
      expect(
        schemaFor('runner-capability').properties.schemaVersion.default,
      ).toBe('1.1.0');
      expect(
        validatorFor('runner-capability')(manifest({ schemaVersion: '1.0.0' })),
      ).toBe(true);
    });

    it.each([...CONTRACTS])(
      '%s rejects a 2.x document, which belongs to another file',
      (contract) => {
        const schema = schemaFor(contract);
        expect('2.0.0').not.toMatch(
          new RegExp(schema.properties.schemaVersion.pattern!),
        );
      },
    );
  });

  describe('speaksSchemaVersions, so the producer can emit what the consumer reads', () => {
    const validate = () => validatorFor('runner-capability');

    it('is optional — absent means the newest 1.x the control plane has', () => {
      expect(validate()(manifest())).toBe(true);
    });

    it('accepts a runner naming what it consumes and what it emits', () => {
      expect(
        validate()(
          manifest({
            schemaVersion: '1.1.0',
            speaksSchemaVersions: {
              workOrder: ['1.0.0'],
              runEvent: ['1.0.0'],
            },
          }),
        ),
      ).toBe(true);
    });

    it('rejects a declaration missing either direction', () => {
      // A runner that says what it can read but not what it emits has told the
      // control plane half of what it needs to route safely.
      expect(
        validate()(
          manifest({ speaksSchemaVersions: { workOrder: ['1.0.0'] } }),
        ),
      ).toBe(false);
    });

    it('rejects an empty list, which claims to speak nothing', () => {
      expect(
        validate()(
          manifest({
            speaksSchemaVersions: { workOrder: [], runEvent: ['1.0.0'] },
          }),
        ),
      ).toBe(false);
    });

    it('rejects a version that is not semver', () => {
      expect(
        validate()(
          manifest({
            speaksSchemaVersions: { workOrder: ['1.x'], runEvent: ['1.0.0'] },
          }),
        ),
      ).toBe(false);
    });

    it('rejects an unknown contract name', () => {
      // The two directions are the whole seam (VISION §6). A third key is
      // either a typo or a contract nobody has agreed on.
      expect(
        validate()(
          manifest({
            speaksSchemaVersions: {
              workOrder: ['1.0.0'],
              runEvent: ['1.0.0'],
              capability: ['1.0.0'],
            },
          }),
        ),
      ).toBe(false);
    });
  });

  describe('strictness is what makes the policy necessary', () => {
    it.each([...CONTRACTS])(
      '%s still refuses unknown properties',
      (contract) => {
        // ADR-0010 rests on this: because unknown fields are rejected, an added
        // optional field IS breaking for a pinned consumer, which is why the
        // producer has to emit what the consumer declares. If this ever became
        // permissive, the reasoning in that ADR would no longer hold.
        const schema = JSON.parse(
          readFileSync(join(SCHEMA_DIR, `${contract}.schema.json`), 'utf8'),
        ) as { unevaluatedProperties?: boolean };
        expect(schema.unevaluatedProperties).toBe(false);
      },
    );
  });
});
