/**
 * What a `dangerous` change actually changes, wherever it is made (#381).
 *
 * ## The inconsistency this module exists to close
 *
 * #345 made the four hard spend ceilings ordinary managed registry keys, and
 * #348's Configuration section renders EVERY registry key by design. So the
 * ceilings became editable from two screens, and only one of them asked: the
 * Credentials section put them behind a confirmation that states what moves
 * and what moving it does (#349), while Configuration rendered them as plain
 * bounded fields next to `github.maxRetries`, marked with a chip and gated by
 * nothing.
 *
 * That was never a security hole — both paths are the same audited,
 * interactive, RBAC-gated write — but it took the argument out from under
 * ADR-0018 §6, which rests on the write being a DELIBERATE ACT. A field that
 * saves on blur is not obviously one.
 *
 * ## Why the description is derived rather than enumerated
 *
 * Configuration's promise is that it renders whatever the registry publishes,
 * with no list of keys anywhere in `apps/web` (see `config/operatorSettings.ts`).
 * A confirmation keyed off a hand-written table of dangerous keys would break
 * that promise the first time the backend marks a new key `dangerous`: the
 * key would render, and would then save unconfirmed while looking exactly like
 * one that does not.
 *
 * So there are two tiers, and the second one is the load-bearing half:
 *
 *  - A key a screen models SPECIFICALLY gets the specific description. Today
 *    that is the four ceiling keys, whose raise/lower and shorter/longer
 *    sentences live in `config/spendCeilings.ts` and are reused verbatim
 *    rather than re-derived here.
 *  - EVERY other `dangerous` key gets a generic description built from what
 *    the response already carries: the value it holds now, the value it would
 *    hold, the registry's own `help`, and the registry's own `reload`
 *    semantics. That is never empty, and it never invents a claim the API did
 *    not make.
 */

import { reloadPresentation } from './operatorSettings';
import {
  baselineFieldValue,
  type DraftEntry,
  type SettingsDraft,
} from './operatorSettingsDraft';
import { ceilingFieldOf, describeCeilingChange } from './spendCeilings';
import type {
  OperatorSetting,
  PlainOperatorSetting,
} from '../types/operatorSettings';

/**
 * One field that moves, and what moving it does.
 *
 * `CeilingChange` in `config/spendCeilings.ts` is structurally one of these
 * plus the wire value it carries, which is how the ceiling panel and the
 * Configuration section share one dialog without sharing a description.
 */
export interface DangerousChange {
  key: string;
  label: string;
  /** As it stands now, quoted rather than normalised. `(not set)` for empty. */
  from: string;
  /** As it would stand. */
  to: string;
  /** What that does, in the operator's terms. */
  consequence: string;
  /** When it takes effect, quoted from the registry's `reload`. */
  takesEffect?: string;
}

/**
 * Every `dangerous` key this draft would actually send.
 *
 * Iterates the RESPONSE rather than the draft, for the reason `buildPatch`
 * does: a draft holding a key the server no longer publishes is dropped rather
 * than described. Secrets never appear — they are written one at a time from
 * the Credentials section and never enter a draft at all.
 */
export function dangerousChanges(
  settings: readonly OperatorSetting[],
  draft: SettingsDraft,
): DangerousChange[] {
  const described: DangerousChange[] = [];

  for (const entry of settings) {
    // Narrows to the plain arm: a secret carries no value to describe.
    if (entry.secret) continue;
    if (!entry.dangerous) continue;

    const entryDraft = draft[entry.key];
    if (!entryDraft) continue;
    if (!isMoved(entry, entryDraft)) continue;

    described.push(describeDangerousChange(entry, entryDraft));
  }

  return described;
}

/** Has this row moved off what the response said? */
function isMoved(entry: PlainOperatorSetting, draft: DraftEntry): boolean {
  if (draft.kind === 'revert') return entry.source === 'database';
  return !Object.is(draft.value, baselineFieldValue(entry));
}

/**
 * One change, described as specifically as anything on hand allows.
 *
 * A ceiling key is handed to `describeCeilingChange`, so the raise/lower and
 * shorter/longer sentences an operator reads on the Credentials tab are the
 * same sentences they read here — one wording, one place to correct it.
 * Everything else falls through to a generic description that is still about
 * THIS key: its current value, its new value, its own `help`, and its own
 * reload semantics.
 */
export function describeDangerousChange(
  entry: PlainOperatorSetting,
  draft: DraftEntry,
): DangerousChange {
  const takesEffect = reloadPresentation(entry.reload).help;
  const ceiling = ceilingFieldOf(entry.key);

  if (ceiling && draft.kind === 'edit' && typeof draft.value === 'string') {
    const specific = describeCeilingChange(
      ceiling.definition,
      ceiling.field,
      entry,
      draft.value,
    );
    if (specific) return { ...specific, takesEffect };
  }

  const from = display(baselineFieldValue(entry));

  if (draft.kind === 'revert') {
    return {
      key: entry.key,
      label: entry.label,
      from,
      to: `whatever ${entry.envVar} says`,
      consequence:
        'The stored override is DELETED rather than changed, so this key ' +
        `falls back to ${entry.envVar} — or to the built-in default if that ` +
        'is unset. What it will resolve to is not knowable from this screen; ' +
        'the value shown after the write is the API re-resolved.',
      takesEffect,
    };
  }

  return {
    key: entry.key,
    label: entry.label,
    from,
    to: display(draft.value),
    consequence: consequenceOf(entry, draft.value),
    takesEffect,
  };
}

/**
 * The generic consequence: the registry's own sentence, plus what moved.
 *
 * `entry.help` is quoted rather than summarised. It is the one description of
 * this key that is maintained beside the key itself, and a screen paraphrasing
 * it would be a second declaration of the thing epic #332 exists to keep
 * singular.
 */
function consequenceOf(
  entry: PlainOperatorSetting,
  value: string | boolean,
): string {
  const marked =
    'This key is marked dangerous by the registry: changing it can spend ' +
    'money, act outwardly, or widen a boundary.';

  if (typeof value === 'boolean') {
    return `Turning this ${value ? 'ON' : 'OFF'}. ${marked} ${entry.help}`;
  }

  if (value.trim() === '') {
    return `Clearing this. ${marked} ${entry.help}`;
  }

  return `${marked} ${entry.help}`;
}

/** A value as the dialog shows it. Empty is an absence, and says so. */
function display(value: string | boolean): string {
  if (typeof value === 'boolean') return String(value);
  return value === '' ? '(not set)' : value;
}
