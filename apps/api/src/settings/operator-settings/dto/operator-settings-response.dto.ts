import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  OPERATOR_SETTING_GROUPS,
  OPERATOR_SETTING_KEYS,
  OPERATOR_SETTING_KINDS,
  RELOAD_SEMANTICS,
} from '../operator-settings.registry';

// =============================================================================
// The shape `GET /api/operator-settings` returns (#338, epic #332)
// =============================================================================
//
// THE ONE PROPERTY THIS FILE EXISTS TO GUARANTEE
// ----------------------------------------------
// `secretSettingSchema` has no `value` member, and it never gets one. The
// document is PARSED through `operatorSettingsDocumentSchema` on the way out
// (see `OperatorSettingsController.list`), and zod strips keys a schema does
// not declare — so a secret's plaintext cannot reach a client through a field
// somebody adds to the builder later and forgets to think about. The
// whole-response test in `operator-settings-secret-leak.spec.ts` is the proof;
// this schema is the mechanism that makes the proof hold for fields that do
// not exist yet.
//
// That is why the two arms are a discriminated union rather than one object
// with optional members. One object with `value?` and `configured?` would be
// satisfied by a secret entry carrying both, and the strip would do nothing.
//
// WHY `source` SAYS `database` AND NOT `db`
// -----------------------------------------
// It is the exact string `OperatorSettingSource` already publishes, which the
// same epic's write path also records into `audit_events.meta` as `fromSource`
// and `toSource` — the rows the Control Center's own History section renders
// beside these values. Two spellings of one provenance, in one screen, is the
// drift ADR-0011 and ADR-0018 §1 both argue the fix for is "only one of them
// exists" rather than a mapping table.
// =============================================================================

/** Where a resolved value came from. Mirrors `OperatorSettingSource`. */
export const operatorSettingSourceSchema = z.enum([
  'default',
  'env',
  'database',
]);

/**
 * A resolved non-secret value.
 *
 * The four scalar shapes the registry's `kind` can produce, plus `null` for
 * the nullable integers where null is a real value meaning "no ceiling" —
 * `dispatch.maxConcurrent` and `runners.claudeCodeLocal.defaultTimeoutMinutes`.
 */
export const operatorSettingValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

/**
 * A supplied value the registry rejected.
 *
 * Reported rather than hidden: the default is what is in force, and an
 * operator staring at a value they set which is not the one running is the
 * exact confusion this epic exists to remove.
 */
export const operatorSettingInvalidSchema = z.object({
  source: operatorSettingSourceSchema,
  reason: z.string(),
});

/**
 * A stored secret that will not decrypt (#339).
 *
 * Distinct from `invalid`, and the distinction is the point: `invalid` is a
 * typo, this is a broken deployment. The UI renders it instead of a
 * plausible-looking value, because the value it would otherwise render is the
 * registry default — "not configured" — which is indistinguishable from a slot
 * nobody has filled in.
 */
export const operatorSettingErrorSchema = z.object({
  reason: z.enum([
    'key_unavailable',
    'malformed_envelope',
    'unsupported_key_version',
    'decrypt_failed',
  ]),
  message: z.string(),
});

/** Everything both arms carry. */
const operatorSettingBase = {
  key: z.enum(OPERATOR_SETTING_KEYS as [string, ...string[]]),
  group: z.enum(OPERATOR_SETTING_GROUPS),
  label: z.string(),
  help: z.string(),
  /** The registry's `kind`, under the name the UI knows it by. */
  type: z.enum(OPERATOR_SETTING_KINDS),
  reload: z.enum(RELOAD_SEMANTICS),
  dangerous: z.boolean(),
  source: operatorSettingSourceSchema,
  /** The environment variable this key falls back to. */
  envVar: z.string(),
  /** Whether `null` is a legal value distinct from "use the default". */
  nullable: z.boolean(),
  /** When the stored override was last written. Null when there is no row. */
  updatedAt: z.iso.datetime().nullable(),
  /** What a control may offer. Absent members simply do not constrain. */
  constraints: z.object({
    min: z.number().optional(),
    max: z.number().optional(),
    values: z.array(z.string()).optional(),
    format: z.enum(['url', 'email']).optional(),
  }),
  invalid: operatorSettingInvalidSchema.optional(),
  error: operatorSettingErrorSchema.optional(),
};

/** The common fields alone, for the builder that assembles both arms. */
export const operatorSettingBaseSchema = z.object(operatorSettingBase);

export type OperatorSettingCommon = z.infer<typeof operatorSettingBaseSchema>;

export const plainSettingSchema = z.object({
  ...operatorSettingBase,
  secret: z.literal(false),
  value: operatorSettingValueSchema,
  /** The declared default, so a control can offer "reset to default". */
  default: operatorSettingValueSchema,
});

export const secretSettingSchema = z.object({
  ...operatorSettingBase,
  secret: z.literal(true),
  /** Whether anything is set at all, at any layer. */
  configured: z.boolean(),
  /**
   * `********abcd`, or null when nothing is configured.
   *
   * Fixed-width mask plus at most the last four characters, and none of them
   * below sixteen — see `common/crypto/redact.ts` for why the width says
   * nothing about the value's length. Enough for "is this the token I just
   * pasted?", useless for guessing the rest.
   */
  hint: z.string().nullable(),
});

export const operatorSettingSchema = z.discriminatedUnion('secret', [
  plainSettingSchema,
  secretSettingSchema,
]);

/** Whether the database overlay is in force, and if not, why not. */
export const operatorSettingsOverlaySchema = z.object({
  /** When a load last SUCCEEDED. Null until one has. */
  loadedAt: z.iso.datetime().nullable(),
  /** When a load was last ATTEMPTED, successful or not. */
  attemptedAt: z.iso.datetime().nullable(),
  /** How many managed keys currently have a row. */
  overriddenKeys: z.number().int(),
  /** A NAME the UI can branch on, never prose. */
  warning: z.literal('operator_settings_overlay_unavailable').optional(),
  /** The driver's own words, for the banner's detail line. */
  problem: z.string().optional(),
  /**
   * True when overrides were loaded once and may now be stale, as opposed to
   * never having loaded at all — the case where `.env` really is what is in
   * force.
   */
  stale: z.boolean().optional(),
});

/**
 * Whether a secret can be written right now.
 *
 * Surfaced so the Control Center can say "secret storage is unavailable"
 * BEFORE an operator types a credential into a form that is going to 503.
 */
export const secretStorageSchema = z.object({
  configured: z.boolean(),
  problem: z.string().optional(),
});

export const operatorSettingsDocumentSchema = z.object({
  /** The counter `If-Match` is checked against. Null until a load succeeds. */
  revision: z.number().int().nullable(),
  status: z.enum(['loaded', 'unavailable']),
  overlay: operatorSettingsOverlaySchema,
  secretStorage: secretStorageSchema,
  settings: z.array(operatorSettingSchema),
});

export class OperatorSettingsDocumentDto extends createZodDto(
  operatorSettingsDocumentSchema,
) {}

export type OperatorSettingsDocument = z.infer<
  typeof operatorSettingsDocumentSchema
>;
export type OperatorSettingEntry = z.infer<typeof operatorSettingSchema>;
