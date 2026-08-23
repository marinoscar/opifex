import { Injectable, Logger } from '@nestjs/common';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

import type { RunnerCapabilityManifest, WorkOrder } from './generated';

export interface ContractViolation {
  /** The offending field, or `(root)` for a whole-document problem. */
  path: string;
  /** Why it was rejected, in Ajv's words. */
  message: string;
}

/** The contracts this validates. Run events have their own, older validator. */
export type ValidatedContract = 'work-order' | 'runner-capability';

/**
 * Schema validation for the two contracts that had none (#35).
 *
 * Run events were already checked at ingestion by `RunEventValidator`. Work
 * orders and capability manifests were not, and they are the two documents
 * whose failures are least recoverable:
 *
 * - A **capability manifest** is a runner's declaration of itself, and the
 *   schema says an overstated one produces "a control plane that trusts signal
 *   it is not actually receiving". That is not a parse error, it is a run
 *   nobody is really watching, discovered later.
 * - A **work order** becomes an authorization record in an issue comment and an
 *   execution record in a commit (#63), byte-identical by construction. Both
 *   are immutable. A malformed one is not a bad request to retry — it is a
 *   wrong document written down permanently, in two places.
 *
 * ## Why Ajv and not zod
 *
 * The same reason `RunEventValidator` gives: the schema file IS the contract,
 * it is what a runner author reads and codes against, and restating it in zod
 * would produce two definitions whose drift is invisible until a runner sends
 * something one accepts and the other rejects. The generated types in
 * `./generated` come from the same file, so the type and the validator have a
 * single origin — which is exactly what #35 asks for.
 *
 * ## Loaded at construction
 *
 * Both schemas are read and compiled when the module starts, so a malformed
 * schema fails at boot rather than on the first document at 3am.
 */
@Injectable()
export class ContractValidator {
  private readonly logger = new Logger(ContractValidator.name);
  private readonly validators: Record<ValidatedContract, ValidateFunction>;

  constructor() {
    // The 2020 entry point, not Ajv's default: the default knows only draft-07
    // and would silently ignore `unevaluatedProperties`, the keyword that
    // rejects a misspelled field instead of accepting it as unknown.
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);

    this.validators = {
      'work-order': ajv.compile(ContractValidator.load('work-order')),
      'runner-capability': ajv.compile(
        ContractValidator.load('runner-capability'),
      ),
    };

    this.logger.log('Work-order and runner-capability schemas loaded');
  }

  /**
   * Locate `schemas/` from either `src/` or a compiled `dist/`.
   *
   * The depth differs between the two, so both are tried rather than assumed —
   * a path that works under ts-node and breaks in a container is the kind of
   * thing that only shows up after deployment. Same candidate list as
   * `RunEventValidator`, for the same reason.
   */
  private static load(contract: ValidatedContract): Record<string, unknown> {
    const file = `${contract}.schema.json`;
    const candidates = [
      join(__dirname, '..', '..', '..', '..', 'schemas', file),
      join(__dirname, '..', '..', '..', 'schemas', file),
      join(process.cwd(), '..', '..', 'schemas', file),
    ];

    const found = candidates.find((candidate) => existsSync(candidate));
    if (!found) {
      throw new Error(
        `Could not locate ${file}. Tried:\n${candidates.join('\n')}`,
      );
    }
    return JSON.parse(readFileSync(found, 'utf8')) as Record<string, unknown>;
  }

  /**
   * Every violation, not the first.
   *
   * #35 requires a failure to name "the offending field and why". One field per
   * round trip is exactly the friction that ends with someone disabling
   * validation, so all of them come back at once.
   */
  private check(
    contract: ValidatedContract,
    candidate: unknown,
  ): ContractViolation[] {
    const validate = this.validators[contract];
    if (validate(candidate)) return [];

    return (validate.errors ?? []).map((error) => ({
      // `instancePath` is '' for a root-level problem, which reads badly on its
      // own; name the document instead.
      path: error.instancePath || '(root)',
      message: error.message ?? 'is invalid',
    }));
  }

  checkWorkOrder(
    candidate: unknown,
  ):
    | { valid: true; workOrder: WorkOrder }
    | { valid: false; violations: ContractViolation[] } {
    const violations = this.check('work-order', candidate);
    return violations.length === 0
      ? { valid: true, workOrder: candidate as WorkOrder }
      : { valid: false, violations };
  }

  checkCapability(
    candidate: unknown,
  ):
    | { valid: true; capability: RunnerCapabilityManifest }
    | { valid: false; violations: ContractViolation[] } {
    const violations = this.check('runner-capability', candidate);
    return violations.length === 0
      ? { valid: true, capability: candidate as RunnerCapabilityManifest }
      : { valid: false, violations };
  }

  /** `path: message` per line, for a log line or an error body. */
  static describe(violations: ContractViolation[]): string {
    return violations.map((v) => `${v.path}: ${v.message}`).join('; ');
  }
}
