/**
 * The two hard spend ceilings, as a screen has to present them
 * (#349, #345, ADR-0018).
 *
 * ## The figures are strings, and stay strings
 *
 * `dispatch.hardSpendCeilingUsd` and `supervisor.hardSpendCeilingUsd` are
 * declared in the registry as STRING settings, deliberately, and the registry
 * header says why at length: a number can carry two states and this field
 * needs three. A figure, an UNSET ceiling, and a MALFORMED one — `50O` with a
 * letter O, typed by somebody who believed they had set a limit — are three
 * different situations, and only the third means a human is walking around
 * with a false belief about their budget. Unset and malformed both refuse to
 * spend, so collapsing them costs the most specific diagnostic in the system.
 *
 * Nothing here coerces the value to a number. `classifyCeiling` reports which
 * of the three states a piece of text is in, mirroring `parseHardCeiling` in
 * `apps/api/src/budget/hard-spend-ceiling.ts` rule for rule, and the raw text
 * is what gets stored and what gets shown back.
 *
 * ## The guarantee that changed
 *
 * These ceilings used to be structural: settable only in `.env`, so raising
 * one required access to the host. Since #345 the database row wins and the
 * change takes effect without a restart, which means the guarantee is now
 * ACCESS-CONTROLLED rather than structural — it rests on #334 (an agent
 * subprocess inherits no credential) and #346 (a non-interactive token is
 * refused on this write path), and ADR-0018 §6 is explicit that either one
 * missing invalidates the decision rather than merely weakening it. An
 * operator moving a ceiling on this screen is exercising that decision, so
 * the screen links it rather than describing it second-hand.
 */

import type { OperatorSetting } from '../types/operatorSettings';

/** ADR-0018, which is what makes these fields editable at all. */
export const CEILING_ADR = {
  id: 'ADR-0018',
  title: 'Operator settings resolution and hard ceilings',
  path: 'docs/adr/0018-operator-settings-resolution-and-ceilings.md',
  url: 'https://github.com/marinoscar/opifex/blob/main/docs/adr/0018-operator-settings-resolution-and-ceilings.md',
} as const;

/**
 * Where current spend against a ceiling's window can be read.
 *
 * `cost-summary` names the read model that actually publishes it. There is
 * exactly one: `GET /api/cost/summary` returns `ceiling.spend`, tallied over
 * the CEILING's own window rather than the window the request asked for.
 *
 * `not-observable` is the honest alternative, and it is used rather than
 * avoided: nothing in the API publishes supervisor spend against the
 * supervisor ceiling. `config/readiness.ts` renders an unprovable step as "not
 * yet verifiable" instead of guessing, and a budget figure is the last place
 * to start guessing — a number labelled "spent so far" that was inferred
 * would be worse than a blank, because it would be acted on.
 */
export type CeilingSpendSource =
  { kind: 'cost-summary' } | { kind: 'not-observable'; reason: string };

export interface CeilingDefinition {
  id: 'dispatch' | 'supervisor';
  title: string;
  /** The key holding the USD figure. A string setting — see the header. */
  usdKey: string;
  /** The key holding the rolling window in days. */
  windowKey: string;
  /** What an unset ceiling does. Not "unlimited" for either of these. */
  unsetMeans: string;
  spendSource: CeilingSpendSource;
}

/**
 * The two ceilings, named explicitly.
 *
 * Unlike the Configuration section, this cannot be generated from the
 * response: a ceiling is a PAIR of keys, and the figure has a matching spend
 * observation that only exists per ceiling. Both facts live in the API's code
 * and neither is published. A definition whose keys are absent from the
 * response renders nothing, so this degrades to silence rather than to a
 * broken panel.
 */
export const CEILING_DEFINITIONS: readonly CeilingDefinition[] = [
  {
    id: 'dispatch',
    title: 'Factory spend',
    usdKey: 'dispatch.hardSpendCeilingUsd',
    windowKey: 'dispatch.hardSpendCeilingWindowDays',
    unsetMeans:
      'No ceiling is configured, which REFUSES every dispatch rather than ' +
      'permitting unlimited spend. An unset ceiling is not an unlimited one.',
    spendSource: { kind: 'cost-summary' },
  },
  {
    id: 'supervisor',
    title: 'Supervisor spend',
    usdKey: 'supervisor.hardSpendCeilingUsd',
    windowKey: 'supervisor.hardSpendCeilingWindowDays',
    unsetMeans:
      'No ceiling is configured, and the supervisor then does not run at ' +
      'all: every tick records a skipped_budget row instead.',
    spendSource: {
      kind: 'not-observable',
      reason:
        'Nothing in the API publishes supervisor spend against this window. ' +
        'GET /api/cost/summary reports the factory ceiling only, and the ' +
        'supervisor is metered on a separate key (ADR-0015), so no figure ' +
        'shown here would be about this ceiling.',
    },
  },
];

// ---------------------------------------------------------------------------
// The three states a ceiling figure can be in
// ---------------------------------------------------------------------------

export type CeilingClassification =
  | { kind: 'unset' }
  | { kind: 'amount'; usd: number; text: string }
  | { kind: 'malformed'; text: string };

/**
 * Which of the three states this text is in, by the API's own rules.
 *
 * Mirrors `parseHardCeiling`: empty or whitespace is UNSET; anything that is
 * not a finite, non-negative number is MALFORMED and is quoted back rather
 * than replaced with "expected number"; everything else is the amount.
 *
 * `Number('')` and `Number('  ')` are both 0, which is why empty is handled
 * first — a ceiling of zero means "spend nothing", and it must not be
 * reachable by accident from a blank field.
 */
export function classifyCeiling(text: string): CeilingClassification {
  if (text.trim() === '') return { kind: 'unset' };

  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return { kind: 'malformed', text };
  }

  return { kind: 'amount', usd: parsed, text };
}

/** The classification as one sentence, for a field's helper text. */
export function describeClassification(
  classification: CeilingClassification,
  definition: CeilingDefinition,
): string {
  switch (classification.kind) {
    case 'unset':
      return definition.unsetMeans;
    case 'malformed':
      return (
        `"${classification.text}" is not a non-negative number. It would be ` +
        'stored as written and reported as malformed, and spending would be ' +
        'refused — the same refusal as an unset ceiling, but for a ' +
        'different reason.'
      );
    default:
      return `A ceiling of $${classification.usd} per window.`;
  }
}

// ---------------------------------------------------------------------------
// What a change actually changes
// ---------------------------------------------------------------------------

export interface CeilingChange {
  key: string;
  label: string;
  /** As stored now, quoted rather than normalised. */
  from: string;
  /** As it would be stored. */
  to: string;
  /** What that does, in the operator's terms. */
  consequence: string;
}

/**
 * The confirmation's contents: every field that moves, and what moving it does.
 *
 * The consequences are the registry's own, restated. Two of them are easy to
 * get backwards and are therefore spelled out rather than left implied:
 * SHORTENING the window makes the same figure permit more spend per month, and
 * LOWERING a ceiling binds the next dispatch rather than a run already under
 * way — the gate is at admission, and a dispatched agent is not recalled.
 */
export function describeCeilingChange(
  definition: CeilingDefinition,
  field: 'usd' | 'window',
  entry: OperatorSetting,
  next: string,
): CeilingChange | null {
  const current = entry.secret ? '' : stringify(entry.value);
  if (current === next) return null;

  const base = {
    key: entry.key,
    label: entry.label,
    from: current === '' ? '(not set)' : current,
    to: next === '' ? '(not set)' : next,
  };

  if (field === 'window') {
    return { ...base, consequence: windowConsequence(current, next) };
  }

  return {
    ...base,
    consequence: usdConsequence(definition, current, next),
  };
}

function usdConsequence(
  definition: CeilingDefinition,
  current: string,
  next: string,
): string {
  const before = classifyCeiling(current);
  const after = classifyCeiling(next);

  if (after.kind === 'unset') {
    return `Removing the ceiling does not lift it. ${definition.unsetMeans}`;
  }

  if (after.kind === 'malformed') {
    return (
      `"${after.text}" is not a non-negative number, so it will be stored, ` +
      'reported as malformed, and refuse to spend — it is not a ceiling ' +
      'and it is not "no ceiling".'
    );
  }

  if (before.kind !== 'amount') {
    return (
      `Spending up to $${after.usd} per window becomes permitted where ` +
      'nothing was permitted before.'
    );
  }

  if (after.usd > before.usd) {
    return (
      `This RAISES the limit from $${before.usd} to $${after.usd}. It takes ` +
      'effect on the next admission — no restart is needed, and no trust ' +
      'grant can raise it further.'
    );
  }

  return (
    `This LOWERS the limit from $${before.usd} to $${after.usd}. A run ` +
    'already under way is not recalled: the gate is at admission, so the ' +
    'change binds the next dispatch.'
  );
}

function windowConsequence(current: string, next: string): string {
  const before = Number(current);
  const after = Number(next);

  if (!Number.isFinite(after) || after <= 0) {
    return (
      `"${next}" is not a positive whole number of days, so the API will ` +
      'refuse it and the window will not change.'
    );
  }

  if (!Number.isFinite(before) || before <= 0) {
    return `The ceiling will be measured over a rolling ${after}-day window.`;
  }

  if (after < before) {
    return (
      `Shortening the window from ${before} to ${after} days makes the same ` +
      'figure permit MORE spend per month. It is as much a budget change as ' +
      'the figure is.'
    );
  }

  return (
    `Lengthening the window from ${before} to ${after} days makes the same ` +
    'figure permit less spend per month, and makes recovery from hitting it ' +
    'take longer.'
  );
}

/** A setting value as the text a field holds. Null is empty, not "null". */
function stringify(value: string | number | boolean | null): string {
  return value === null ? '' : String(value);
}
