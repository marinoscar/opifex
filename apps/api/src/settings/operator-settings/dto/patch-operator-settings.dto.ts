import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  OPERATOR_SETTING_KEYS,
  isOperatorSettingKey,
} from '../operator-settings.registry';

/**
 * The body of `PATCH /api/operator-settings` (#338, epic #332).
 *
 * ## Only the changed keys, and this is correctness rather than economy
 *
 * An absent row means "fall through to the environment". A form that submitted
 * every key it rendered would turn "never touched" into "explicitly set to
 * whatever it shows", materialising today's defaults into rows — and every
 * later release's change to a built-in default would then never reach that
 * deployment. That is the failure
 * `common/schemas/user-settings-namespaces.schema.ts` opens by describing, one
 * layer further out, and ADR-0018 §2 restates it for this table.
 *
 * So the body is a sparse map, an absent key means "leave it alone", and that
 * is asserted rather than assumed — see `operator-settings.controller.spec.ts`.
 *
 * ## `null` means "revert to the environment", not "set to null"
 *
 * The same JSON Merge Patch convention `dataTablesPatchSchema` and
 * `navigationPatchSchema` already use. It deletes the row, so the key resolves
 * to whatever the environment currently says — and only to the code's default
 * if the environment says nothing. ADR-0018 §2 is explicit that a revert must
 * not erase an env value an operator set outside the running system.
 *
 * The one wrinkle, stated because it is genuinely surprising: for
 * `dispatch.maxConcurrent` and `runners.claudeCodeLocal.defaultTimeoutMinutes`,
 * `null` is ALSO a legal value meaning "no ceiling". The two are still
 * distinguishable, because the wire form of that value is the STRING `'null'`
 * — which the registry's `nullableIntegerSetting` accepts for exactly this
 * reason, and which the epic's exit criteria require ("a number, then absent
 * — never the string `'undefined'`"). A JSON `null` is always the revert.
 */

/** What a settings value can be on the wire. */
export const operatorSettingWriteValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  // The revert. Never "store a null" — see the header.
  z.null(),
]);

export const patchOperatorSettingsSchema = z
  .record(z.string(), operatorSettingWriteValueSchema)
  .superRefine((body, ctx) => {
    const keys = Object.keys(body);

    if (keys.length === 0) {
      ctx.addIssue({
        code: 'custom',
        message:
          'Send at least one setting key. An empty patch is almost always a ' +
          'form submitting nothing rather than a deliberate no-op.',
        path: [],
      });
      return;
    }

    for (const key of keys) {
      if (!isOperatorSettingKey(key)) {
        // Rejected here, before anything is written, so a body with one good
        // key and one typo applies neither. A multi-key patch is not one
        // transaction (see the controller) — refusing the whole body up front
        // is what keeps a typo from leaving half of it applied.
        ctx.addIssue({
          code: 'custom',
          message: `"${key}" is not a managed setting key`,
          path: [key],
        });
      }
    }
  });

export class PatchOperatorSettingsDto extends createZodDto(
  patchOperatorSettingsSchema,
) {}

/**
 * Every managed key, for the OpenAPI description and for a client that wants
 * to know what it may send without reading the response first.
 */
export const MANAGED_SETTING_KEYS: readonly string[] = OPERATOR_SETTING_KEYS;
