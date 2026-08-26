/**
 * `GET /api/operator-settings`, as the Control Center reads it (#348, epic #332).
 *
 * A mirror of `apps/api/src/settings/operator-settings/dto/operator-settings-response.dto.ts`,
 * and deliberately a LOOSE one in two places.
 *
 * `key` and `group` are `string`, not the unions the API derives from its
 * registry. That is the whole point of #348: the settings sections are
 * generated from this response, so adding a key — or a whole group — in
 * `operator-settings.registry.ts` must not require an edit here or anywhere
 * else in `apps/web`. A union would compile fine and then silently exclude the
 * new key from every exhaustive map somebody wrote against it.
 *
 * `type` and `reload` ARE unions, because a control has to be chosen for the
 * first and a chip drawn for the second, and both are closed vocabularies the
 * API publishes (`OPERATOR_SETTING_KINDS`, `RELOAD_SEMANTICS`). The renderers
 * still fall back rather than crash on an unrecognised value — see
 * `config/operatorSettingsView.ts` — so a new kind degrades to a text field
 * instead of a blank row.
 *
 * ## The secret arm has no `value`, here as on the wire
 *
 * `SecretOperatorSetting` carries `configured`, `hint`, `source` and
 * `updatedAt` and nothing else, matching the API's discriminated union exactly.
 * A component that tried to read `entry.value` off a secret does not compile.
 */

/** Which layer the value in force came from. */
export type OperatorSettingSource = 'default' | 'env' | 'database';

/** The shape of the value, which chooses the control. */
export type OperatorSettingKind = 'boolean' | 'integer' | 'string' | 'enum';

/** When a change takes effect. Never inferred in the UI — see the chip. */
export type ReloadSemantics = 'live' | 'next-unit' | 'restart';

/** Every scalar a non-secret setting can resolve to. */
export type OperatorSettingValue = string | number | boolean | null;

/** What a control may offer. Absent members simply do not constrain. */
export interface OperatorSettingConstraints {
  min?: number;
  max?: number;
  values?: string[];
  format?: 'url' | 'email';
}

/** A supplied value the registry rejected, and which layer supplied it. */
export interface OperatorSettingInvalid {
  source: OperatorSettingSource;
  reason: string;
}

/** A stored secret that will not decrypt (#339). Not the same as `invalid`. */
export interface OperatorSettingError {
  reason:
    | 'key_unavailable'
    | 'malformed_envelope'
    | 'unsupported_key_version'
    | 'decrypt_failed';
  message: string;
}

/** Everything both arms carry. */
export interface OperatorSettingCommon {
  key: string;
  group: string;
  label: string;
  help: string;
  type: OperatorSettingKind;
  reload: ReloadSemantics;
  dangerous: boolean;
  source: OperatorSettingSource;
  envVar: string;
  /** Whether `null` is a real value here, distinct from "use the default". */
  acceptsNull: boolean;
  /** When the stored override was last written. Null when there is no row. */
  updatedAt: string | null;
  constraints: OperatorSettingConstraints;
  invalid?: OperatorSettingInvalid;
  error?: OperatorSettingError;
}

export interface PlainOperatorSetting extends OperatorSettingCommon {
  secret: false;
  value: OperatorSettingValue;
  default: OperatorSettingValue;
}

export interface SecretOperatorSetting extends OperatorSettingCommon {
  secret: true;
  configured: boolean;
  /** `********abcd`, or null when nothing is configured. Never the value. */
  hint: string | null;
}

export type OperatorSetting = PlainOperatorSetting | SecretOperatorSetting;

/** Whether the database overlay is in force, and if not, why not. */
export interface OperatorSettingsOverlay {
  loadedAt: string | null;
  attemptedAt: string | null;
  overriddenKeys: number;
  warning?: 'operator_settings_overlay_unavailable';
  problem?: string;
  /** Loaded once and possibly stale, as opposed to never loaded at all. */
  stale?: boolean;
}

/** Whether a secret can be written at all right now. The Credentials section
 * disables Replace and says why when this is false (#349). */
export interface OperatorSecretStorage {
  configured: boolean;
  problem?: string;
}

export interface OperatorSettingsDocument {
  /** The counter `If-Match` is checked against. Null until a load succeeds. */
  revision: number | null;
  status: 'loaded' | 'unavailable';
  overlay: OperatorSettingsOverlay;
  secretStorage: OperatorSecretStorage;
  settings: OperatorSetting[];
}

/**
 * What `PATCH /api/operator-settings` accepts per key.
 *
 * A JSON `null` is always "delete the row and fall back to the environment".
 * An explicit null VALUE — "no ceiling", for the two `acceptsNull` integers —
 * travels as the string `'null'`, which the registry's nullable integer schema
 * accepts for exactly this reason. The two are not interchangeable and the API
 * header says so.
 */
export type OperatorSettingWriteValue = string | number | boolean | null;

/** A sparse map. Only the keys being changed — see `useOperatorSettings`. */
export type OperatorSettingsPatch = Record<string, OperatorSettingWriteValue>;
