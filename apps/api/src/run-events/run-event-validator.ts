import { Injectable, Logger } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

import type { RunEventPayload } from './run-event.types';

export interface ValidationFailure {
  path: string;
  message: string;
}

/**
 * Validates incoming events against `schemas/run-event.schema.json` itself.
 *
 * ## Why ajv rather than a zod DTO
 *
 * Every other request body in this API is a `createZodDto`, and this one
 * deliberately is not. The schema file IS the contract — it is what a runner
 * author reads and codes against, and what #52's git watcher already validates
 * its output against. Restating it in zod would produce two definitions of one
 * contract, and the drift between them would be invisible until a runner sent
 * something the schema allowed and the API rejected.
 *
 * The cost is that this bypasses the global `ZodValidationPipe`, so the
 * controller must call this explicitly and turn failures into a 400 itself.
 * That is a real cost and it is worth paying once, here, rather than
 * maintaining a second copy of the six event types forever.
 *
 * ## Loaded from disk at construction, on purpose
 *
 * The schema is read once when the module starts, so a malformed schema fails
 * at boot rather than on the first event a runner sends at 3am.
 */
@Injectable()
export class RunEventValidator {
  private readonly logger = new Logger(RunEventValidator.name);
  private readonly validate: ValidateFunction;

  constructor() {
    const schemaPath = RunEventValidator.resolveSchemaPath();
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as Record<string, unknown>;

    // The 2020 entry point, not ajv's default: the default only knows
    // draft-07 and would silently ignore `unevaluatedProperties`, which is
    // what rejects a misspelled field rather than storing it as unknown.
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    this.validate = ajv.compile(schema);

    this.logger.log(`Run-event schema loaded from ${schemaPath}`);
  }

  /**
   * Where `schemas/` lives, from either `src/` or a compiled `dist/`.
   *
   * The depth differs between the two, so both are tried rather than assuming
   * one — a path that works under `ts-node` and breaks in a container is the
   * kind of thing that only shows up after deployment.
   */
  private static resolveSchemaPath(): string {
    const candidates = [
      join(__dirname, '..', '..', '..', '..', 'schemas', 'run-event.schema.json'),
      join(__dirname, '..', '..', '..', 'schemas', 'run-event.schema.json'),
      join(process.cwd(), '..', '..', 'schemas', 'run-event.schema.json'),
    ];

    for (const candidate of candidates) {
      try {
        readFileSync(candidate, 'utf8');
        return candidate;
      } catch {
        continue;
      }
    }

    throw new Error(
      `Could not locate run-event.schema.json. Tried:\n${candidates.join('\n')}`,
    );
  }

  /**
   * Validate one candidate event.
   *
   * Returns every failure rather than the first: a runner author fixing one
   * field per round trip is exactly the friction that leads to someone
   * disabling validation.
   */
  check(candidate: unknown): { valid: true; event: RunEventPayload } | {
    valid: false;
    failures: ValidationFailure[];
  } {
    if (this.validate(candidate)) {
      return { valid: true, event: candidate as RunEventPayload };
    }

    return {
      valid: false,
      failures: (this.validate.errors ?? []).map((error) => ({
        // `instancePath` is '' for a root-level problem, which reads badly in
        // an error body; name the document instead.
        path: error.instancePath || '(root)',
        message: error.message ?? 'is invalid',
      })),
    };
  }
}
