/**
 * The draft an operator is editing, and the patch it becomes (#348, epic #332).
 *
 * ## Why this is a pure module and not state inside the section
 *
 * The one property #348 must guarantee is that `PATCH /api/operator-settings`
 * carries ONLY the keys that changed. That is not a rendering concern and it
 * is not an optimisation: an absent row means "fall through to the
 * environment", so a body carrying every rendered key would materialise
 * today's defaults into rows and freeze this deployment against every later
 * change to a default the code ships. Keeping the diff here means it can be
 * asserted directly, key by key, without a DOM.
 *
 * ## Three things a row can be, and `null` is two of them
 *
 * A draft entry is either an EDIT (the control's own value, as the control
 * holds it) or a REVERT. They produce different wire values and the difference
 * is the API's, not ours:
 *
 *  - A revert sends JSON `null`, which DELETES the stored row. The key then
 *    resolves to whatever the environment says — and only to the code's
 *    default if the environment says nothing.
 *  - An `acceptsNull` key set to "no value" sends the STRING `'null'`, which
 *    STORES a null. That is a real value for `dispatch.maxConcurrent` ("no
 *    ceiling") and for `runners.claudeCodeLocal.defaultTimeoutMinutes`, and
 *    the registry's nullable integer schema accepts the string form for
 *    exactly this reason.
 *
 * Collapsing the two would make "no ceiling" indistinguishable from "stop
 * overriding this", which are opposite intentions with opposite consequences.
 *
 * ## An edit back to the current value is not a change
 *
 * Typing `5` over a `5` that came from the environment leaves the key out of
 * the patch, so it does not become a stored row. That is deliberate: creating
 * a row that merely restates the environment is the exact freeze described
 * above, in miniature, and the operator gets no feedback that it happened.
 */

import type {
  OperatorSetting,
  OperatorSettingsPatch,
  PlainOperatorSetting,
} from '../types/operatorSettings';

/** What a control holds. Booleans are booleans; everything else is text. */
export type DraftFieldValue = string | boolean;

export type DraftEntry =
  { kind: 'edit'; value: DraftFieldValue } | { kind: 'revert' };

/** Keyed by setting key. Absent means "this row has not been touched". */
export type SettingsDraft = Record<string, DraftEntry>;

/**
 * The value a control starts at, derived from the response alone.
 *
 * `null` becomes an empty string, which is how an `acceptsNull` key renders
 * "no value" — and how a key whose value is genuinely absent renders too. The
 * two are the same thing to a text field, and `toWireValue` is where the
 * distinction is re-established from `acceptsNull`.
 */
export function baselineFieldValue(
  entry: PlainOperatorSetting,
): DraftFieldValue {
  if (entry.type === 'boolean') return entry.value === true;
  return entry.value === null ? '' : String(entry.value);
}

export interface WireValueOk {
  ok: true;
  value: OperatorSettingsPatch[string];
}

export interface WireValueProblem {
  ok: false;
  problem: string;
}

/**
 * The draft entry as the API would receive it, or why it cannot be sent.
 *
 * Range and integrality are checked here as well as in the API. Not because
 * the API's check is doubted — it is the enforcement point and this is not —
 * but because "the API rejected your whole patch" arrives after the operator
 * has left the field, and naming the field while they are still in it is the
 * difference between a correction and a mystery.
 */
export function toWireValue(
  entry: PlainOperatorSetting,
  draft: DraftEntry,
): WireValueOk | WireValueProblem {
  if (draft.kind === 'revert') return { ok: true, value: null };

  if (typeof draft.value === 'boolean') {
    return { ok: true, value: draft.value };
  }

  const text = draft.value.trim();

  if (text === '') {
    if (entry.acceptsNull) {
      // The string, not JSON null. See this module's header.
      return { ok: true, value: 'null' };
    }
    return {
      ok: false,
      problem:
        'This needs a value. To stop overriding it, use "Revert to ' +
        'environment" instead of clearing it.',
    };
  }

  if (entry.type === 'integer') {
    const parsed = Number(text);
    if (!Number.isInteger(parsed)) {
      return { ok: false, problem: 'This has to be a whole number.' };
    }
    const { min, max } = entry.constraints;
    if (min !== undefined && parsed < min) {
      return { ok: false, problem: `This has to be at least ${min}.` };
    }
    if (max !== undefined && parsed > max) {
      return { ok: false, problem: `This has to be at most ${max}.` };
    }
    return { ok: true, value: parsed };
  }

  if (entry.type === 'enum') {
    const values = entry.constraints.values ?? [];
    if (values.length > 0 && !values.includes(text)) {
      return {
        ok: false,
        problem: `This has to be one of: ${values.join(', ')}.`,
      };
    }
  }

  return { ok: true, value: text };
}

/**
 * Has this row actually changed?
 *
 * A revert only counts when there is a row to delete. Reverting a key that
 * already reads from the environment is a no-op the API would accept and store
 * nothing for, and sending it would put a key in the patch that the operator
 * did not change — which is the property this module exists to keep.
 */
export function isChanged(entry: OperatorSetting, draft: DraftEntry): boolean {
  if (draft.kind === 'revert') return entry.source === 'database';
  if (entry.secret) return false;
  return !Object.is(draft.value, baselineFieldValue(entry));
}

export interface BuiltPatch {
  /** The sparse body. Only the keys that changed, and only valid ones. */
  changes: OperatorSettingsPatch;
  /** Keyed by setting key: why that row cannot be sent as it stands. */
  problems: Record<string, string>;
}

/**
 * The patch, built from the response and the draft.
 *
 * Iterates the RESPONSE rather than the draft, so a draft holding a key the
 * server no longer publishes — a key removed from the registry between two
 * reads — is dropped rather than sent to be rejected.
 *
 * Secrets are skipped entirely, and that stayed true when #349 landed: a
 * credential is written from the Credentials section, one key at a time,
 * through `config/secretRotation.ts`, whose value never enters a draft object
 * in the first place. A secret reaching this function would therefore be a bug
 * worth failing quietly-but-visibly over rather than a value to guess at.
 */
export function buildPatch(
  settings: readonly OperatorSetting[],
  draft: SettingsDraft,
): BuiltPatch {
  const changes: OperatorSettingsPatch = {};
  const problems: Record<string, string> = {};

  for (const entry of settings) {
    const entryDraft = draft[entry.key];
    if (!entryDraft) continue;
    if (entry.secret) continue;
    if (!isChanged(entry, entryDraft)) continue;

    const wire = toWireValue(entry, entryDraft);
    if (wire.ok) changes[entry.key] = wire.value;
    else problems[entry.key] = wire.problem;
  }

  return { changes, problems };
}

/** How many rows the operator has actually changed. Derived, never stored. */
export function changedCount(
  settings: readonly OperatorSetting[],
  draft: SettingsDraft,
): number {
  return settings.filter((entry) => {
    const entryDraft = draft[entry.key];
    return entryDraft ? isChanged(entry, entryDraft) : false;
  }).length;
}
