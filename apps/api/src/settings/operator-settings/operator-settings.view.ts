import { maskSecret } from '../../common/crypto/redact';
import { encryptionKeyStatus } from '../../common/crypto/secret-box';
import {
  operatorSettingEntries,
  type AnyOperatorSettingDefinition,
  type OperatorSettingKey,
} from './operator-settings.registry';
import type {
  OperatorSettingsService,
  ResolvedOperatorSetting,
} from './operator-settings.service';
import {
  operatorSettingsDocumentSchema,
  type OperatorSettingCommon,
  type OperatorSettingEntry,
  type OperatorSettingsDocument,
} from './dto/operator-settings-response.dto';

/**
 * Turning the registry plus the resolver into the document the Control Center
 * renders (#338, epic #332).
 *
 * ## Why this is a separate module from the controller
 *
 * It is a pure function of `(registry, resolver state)`, and the one property
 * that matters about it — a secret's plaintext appears nowhere in the output —
 * is a property of a value, not of an HTTP round trip. Keeping it out of the
 * controller means the leak test can serialize the real thing without booting
 * Nest, and means the masking cannot be bypassed by a second call site
 * assembling its own response.
 *
 * ## Two layers of defence, deliberately
 *
 * 1. `secretEntry()` never places a value on the object it builds. It receives
 *    the plaintext, derives `configured` and `hint` from it, and returns.
 * 2. The whole document is `parse`d through `operatorSettingsDocumentSchema`
 *    before it is returned, and zod strips undeclared keys. The secret arm of
 *    that union has no `value` member, so a field added here later and not
 *    thought about is removed rather than served.
 *
 * The second layer exists because the first is a promise about code somebody
 * will edit, and the acceptance criterion for this issue is specifically about
 * "a field nobody thought about".
 */
export function buildOperatorSettingsDocument(
  settings: OperatorSettingsService,
): OperatorSettingsDocument {
  const overlay = settings.overlay();
  const encryption = encryptionKeyStatus();

  const entries = operatorSettingEntries().map(([key, definition]) =>
    buildEntry(settings, key, definition),
  );

  const document = {
    revision: overlay.revision,
    status: overlay.status,
    overlay: {
      loadedAt: overlay.loadedAt?.toISOString() ?? null,
      attemptedAt: overlay.attemptedAt?.toISOString() ?? null,
      overriddenKeys: overlay.overriddenKeys,
      ...(overlay.warning ? { warning: overlay.warning } : {}),
      ...(overlay.problem ? { problem: overlay.problem } : {}),
      ...(overlay.stale === undefined ? {} : { stale: overlay.stale }),
    },
    secretStorage: {
      configured: encryption.configured,
      ...(encryption.problem ? { problem: encryption.problem } : {}),
    },
    settings: entries,
  };

  // The second layer. See this module's header — this is not belt-and-braces
  // validation of our own output, it is the strip.
  return operatorSettingsDocumentSchema.parse(document);
}

function buildEntry(
  settings: OperatorSettingsService,
  key: OperatorSettingKey,
  definition: AnyOperatorSettingDefinition,
): OperatorSettingEntry {
  const resolved = settings.resolve(key);
  const common = {
    key,
    group: definition.group,
    label: definition.label,
    help: definition.help,
    type: definition.kind,
    reload: definition.reload,
    // Normalised to a boolean here rather than passed through as
    // `true | undefined`: a UI branching on `dangerous` should not have to
    // know that the registry omits the field when it is false.
    dangerous: definition.dangerous === true,
    source: resolved.source,
    envVar: definition.envVar,
    nullable: definition.nullable,
    updatedAt: settings.storedAt(key)?.toISOString() ?? null,
    constraints: {
      ...(definition.min === undefined ? {} : { min: definition.min }),
      ...(definition.max === undefined ? {} : { max: definition.max }),
      ...(definition.values === undefined
        ? {}
        : { values: [...definition.values] }),
      ...(definition.format === undefined ? {} : { format: definition.format }),
    },
    ...(resolved.invalid ? { invalid: resolved.invalid } : {}),
    ...(resolved.error ? { error: resolved.error } : {}),
  };

  return definition.secret
    ? secretEntry(common, resolved)
    : {
        ...common,
        secret: false as const,
        value: asApiValue(resolved.value),
        default: asApiValue(definition.default),
      };
}

/**
 * The secret arm. The plaintext comes in; nothing derived from more than four
 * of its characters goes out.
 *
 * `configured` is computed from the resolved value rather than from "is there
 * a row", because an operator wants to know whether the factory HAS a
 * credential — which is true when the environment supplies one and no row
 * exists. `source` beside it says which layer it came from.
 *
 * A key whose stored secret will not decrypt reports `configured: false` and
 * carries `error`: the value in force really is "not configured" (the resolver
 * refuses to fall back to the environment there, on purpose), and claiming
 * otherwise would be the exact lie #339 exists to prevent.
 */
function secretEntry(
  common: OperatorSettingCommon,
  resolved: ResolvedOperatorSetting<OperatorSettingKey>,
): OperatorSettingEntry {
  const plaintext = typeof resolved.value === 'string' ? resolved.value : '';
  const configured = plaintext !== '';

  return {
    ...common,
    secret: true as const,
    configured,
    hint: configured ? maskSecret(plaintext) : null,
  };
}

/**
 * A resolved value narrowed to what the response schema publishes.
 *
 * Every registry value is a string, a number, a boolean or null today, and the
 * schema says so. Anything else would be a new registry kind, and turning it
 * into its string form here is a better failure than a `parse` throwing on the
 * whole document and taking every other key down with it.
 */
function asApiValue(value: unknown): string | number | boolean | null {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  return String(value);
}
