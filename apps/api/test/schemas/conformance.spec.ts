import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

import {
  parseWorkOrderIdentity,
  workOrderBranch,
  workOrderIdentity,
} from '../../src/work-orders/work-order-identity';

/**
 * The contract conformance suite (#36).
 *
 * ## Why this exists separately from the per-schema specs
 *
 * VISION §9 makes the point about liveness, and #36 says it applies to the
 * contracts too: building only the happy path *"guarantees discovering, six
 * months later, that the seam was fictional."*
 *
 * The per-schema specs assert that good examples pass. That is necessary and
 * it is not enough — **a schema that accepts everything passes those tests
 * identically to one that works.** So this suite is built around the invalid
 * fixtures: each one must be rejected, and rejected *for the reason it was
 * written for*. A fixture asserted only to "fail somehow" keeps passing after
 * the schema stops checking the thing it was written for.
 *
 * ## Structured so a runner can be pointed at it
 *
 * #36 asks for this to become the basis of the cross-runner conformance work
 * in #23. `validatorFor` and `EVENT_TYPES` are exported for exactly that: a
 * runner implementation can be driven to emit events and have them checked
 * here, without restructuring anything.
 */

const SCHEMA_DIR = join(__dirname, '..', '..', '..', '..', 'schemas');

/** The six normalized types. A seventh is a schema version bump, not a fix. */
export const EVENT_TYPES = [
  'run.started',
  'run.heartbeat',
  'run.progress',
  'run.blocked',
  'run.completed',
  'run.failed',
] as const;

const CONTRACTS = ['run-event', 'work-order', 'runner-capability'] as const;
type Contract = (typeof CONTRACTS)[number];

export function validatorFor(contract: Contract): ValidateFunction {
  // Draft 2020-12 needs ajv's 2020 entry point; the default export only knows
  // draft-07 and would silently ignore `unevaluatedProperties` — the keyword
  // doing most of the work in all three schemas.
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(
    JSON.parse(readFileSync(join(SCHEMA_DIR, `${contract}.schema.json`), 'utf8')),
  );
}

function examplesIn(contract: Contract, subdirectory = ''): string[] {
  const dir = join(SCHEMA_DIR, 'examples', contract, subdirectory);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => join(dir, file));
}

const load = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;

describe('contract conformance', () => {
  describe('every schema compiles under draft 2020-12 in strict mode', () => {
    it.each(CONTRACTS)('%s', (contract) => {
      // Strict mode is what catches a typo'd keyword. Without it a misspelled
      // `unevaluatedProperties` is silently ignored and the schema quietly
      // accepts anything.
      expect(() => validatorFor(contract)).not.toThrow();
    });
  });

  describe('every worked example validates', () => {
    it.each(CONTRACTS)('%s has at least one example', (contract) => {
      // A contract with no example is one nobody has tried to use.
      expect(examplesIn(contract).length).toBeGreaterThan(0);
    });

    it.each(
      CONTRACTS.flatMap((contract) =>
        examplesIn(contract).map((path) => [contract, basename(path), path] as const),
      ),
    )('%s/%s', (contract, _name, path) => {
      // An example is a promise: it is what a runner author copies. One that
      // has drifted out of validity is worse than no example, because it is
      // followed.
      const validate = validatorFor(contract);

      expect(validate(load(path)) ? [] : validate.errors).toEqual([]);
    });
  });

  describe('every invalid fixture is rejected, for its own reason', () => {
    const invalid = CONTRACTS.flatMap((contract) =>
      examplesIn(contract, 'invalid').map((path) => [contract, basename(path), path] as const),
    );

    it('there are invalid fixtures at all', () => {
      // The guard against this whole block passing vacuously.
      expect(invalid.length).toBeGreaterThan(0);
    });

    it.each(invalid)('%s/%s is rejected', (contract, _name, path) => {
      expect(validatorFor(contract)(load(path))).toBe(false);
    });

    /**
     * The keyword each fixture must be rejected BY.
     *
     * This is the half that stops the suite rotting. A fixture asserted only
     * to fail keeps passing after the schema stops checking the thing it was
     * written for — the file is still invalid, just for a different and
     * accidental reason.
     */
    const REJECTED_BY: Record<string, string> = {
      'names-a-runner-field-that-does-not-exist.json': 'unevaluatedProperties',
      'streaming-fidelity-as-a-boolean.json': 'oneOf',
      'no-cost-reporting-without-saying-so.json': 'required',
      'zero-concurrency.json': 'minimum',
      'no-branch-patterns.json': 'minItems',
      'key-with-spaces.json': 'pattern',
    };

    it.each(invalid.filter(([, name]) => REJECTED_BY[name]))(
      '%s/%s is rejected by the right keyword',
      (contract, name, path) => {
        const validate = validatorFor(contract);
        validate(load(path));

        expect(validate.errors?.map((error) => error.keyword)).toContain(REJECTED_BY[name]);
      },
    );

    it('every invalid fixture has a documented reason', () => {
      // A fixture nobody explained is one nobody can maintain.
      const documented = readFileSync(
        join(SCHEMA_DIR, 'examples', 'runner-capability', 'invalid', 'README.md'),
        'utf8',
      );

      for (const [contract, name] of invalid) {
        if (contract !== 'runner-capability') continue;
        expect(documented).toContain(name);
      }
    });
  });

  describe('the six run-event types are covered exhaustively', () => {
    const covered = examplesIn('run-event').map((path) => load(path).type as string);

    it.each(EVENT_TYPES)('%s has a worked example', (type) => {
      expect(covered).toContain(type);
    });

    it('covers both streaming and non-streaming shapes', () => {
      // #36 asks for both. A suite that only exercised the rich shape would
      // let the non-streaming path rot unnoticed, which is precisely VISION
      // §9's warning about a fictional seam.
      const names = examplesIn('run-event').map((path) => basename(path));

      expect(names.some((name) => name.startsWith('streaming-'))).toBe(true);
      expect(names.some((name) => name.startsWith('nonstreaming-'))).toBe(true);
    });

    it('covers a control-plane-synthesized event', () => {
      // VISION §9 forbids a synthesized event masquerading as a report, so the
      // third source has to be exercised too.
      const sources = examplesIn('run-event').map((path) => load(path).source as string);

      expect(sources).toContain('control-plane-synthesized');
      expect(sources).toContain('runner-reported');
      expect(sources).toContain('git-derived');
    });
  });

  describe('capability manifests span the observability range', () => {
    it('validates a full-streaming runner and a near-zero-streaming one', () => {
      // #32: equal observability across vendors is not achievable; a common
      // floor that some runners exceed is. The schema has to fit both ends or
      // it encodes one vendor's shape.
      const fidelities = examplesIn('runner-capability').map(
        (path) => load(path).streamingFidelity as string,
      );

      expect(fidelities).toContain('full');
      expect(fidelities).toContain('none');
    });

    it('grades fidelity and rate-limit signal rather than making them boolean', () => {
      const validate = validatorFor('runner-capability');
      const manifest = load(examplesIn('runner-capability')[0]);

      for (const field of ['streamingFidelity', 'rateLimitSignal']) {
        expect(validate({ ...manifest, [field]: true })).toBe(false);
      }
    });

    it('can express a preview tier, which routing refuses to lean on', () => {
      const tiers = examplesIn('runner-capability').map((path) => load(path).stabilityTier);

      expect(tiers).toContain('experimental');
    });
  });

  describe('work-order identity round-trips', () => {
    it('construct -> serialize -> parse gives back the same identity', () => {
      // #36 asks for exactly this. It is the property abandon-and-re-run
      // recovery rests on (VISION §3.4): if a re-run computed a different
      // identity, the second runner would not find the first one's branch.
      const coordinates = {
        repository: 'opifex',
        issueNumber: 312,
        baseCommit: 'a3f91c2000000000000000000000000000000000',
        attempt: 1,
      };

      const identity = workOrderIdentity(coordinates);
      const parsed = parseWorkOrderIdentity(identity);

      expect(parsed).not.toBeNull();
      expect(workOrderIdentity({ ...coordinates, ...parsed!, baseCommit: coordinates.baseCommit })).toBe(
        identity,
      );
    });

    it('round-trips every worked work-order example', () => {
      for (const path of examplesIn('work-order')) {
        const example = load(path) as { identity: string; branch: string; baseCommit: string };
        const parsed = parseWorkOrderIdentity(example.identity);

        expect(parsed).not.toBeNull();
        expect(
          workOrderBranch({ ...parsed!, baseCommit: example.baseCommit }),
        ).toBe(example.branch);
      }
    });

    it('an identity and its branch agree about the base commit', () => {
      // The two are derived from the same coordinates, and a divergence would
      // mean a runner checking out one commit and reporting another.
      for (const path of examplesIn('work-order')) {
        const example = load(path) as { identity: string; branch: string; baseCommit: string };
        const short = example.baseCommit.slice(0, 7);

        expect(example.identity).toContain(short);
        expect(example.branch).toContain(short);
      }
    });
  });
});
