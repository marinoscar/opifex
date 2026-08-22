import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

/**
 * Compiled validators for the three contracts, importable from anywhere.
 *
 * Extracted from `conformance.spec.ts` rather than left in it. #36 wrote these
 * to be reusable — *"a runner implementation can be driven to emit events and
 * have them checked here, without restructuring anything"* — and #61 requires
 * `claude-code-local` to "pass the conformance suite from #36". A validator
 * exported from a spec file cannot be imported without running that file's 50
 * tests a second time inside whatever imported it, so the reuse #36 designed
 * for only actually works from a plain module.
 *
 * The conformance suite re-exports these, so its own contract is unchanged.
 */

export const SCHEMA_DIR = join(__dirname, '..', '..', '..', '..', 'schemas');

/** The six normalized types. A seventh is a schema version bump, not a fix. */
export const EVENT_TYPES = [
  'run.started',
  'run.heartbeat',
  'run.progress',
  'run.blocked',
  'run.completed',
  'run.failed',
] as const;

export const CONTRACTS = ['run-event', 'work-order', 'runner-capability'] as const;
export type Contract = (typeof CONTRACTS)[number];

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

/** Ajv's errors as one line, so a failing expectation says what was wrong. */
export function explainErrors(validate: ValidateFunction): string {
  return (validate.errors ?? [])
    .map((error) => `${error.instancePath || '/'} ${error.message}`)
    .join('; ');
}
