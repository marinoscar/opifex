/**
 * How an approval's supporting facts are rendered (#98).
 *
 * Small, pure, and tested — because the two distinctions below are the ones a
 * component would otherwise get subtly wrong, in a direction nobody notices
 * until it matters.
 */

import type { ApprovalEffect } from '../../types/approvals';

/**
 * The estimated cost, or **"Unknown"**.
 *
 * NULL IS NOT ZERO, and this is the one figure where the difference decides
 * something: a `spendsMoney` action whose cost could not be estimated is not a
 * free action, it is one the gate could not price — which is precisely the
 * case where a budget check cannot run at all. `$0.00` would tell the operator
 * the opposite of what the data says.
 *
 * The em dash `money()` uses on the cost screen is deliberately not reused
 * here: a dash is read as "nothing to show", and this needs to be read as "we
 * do not know", by someone approving a spend.
 */
export function formatEstimatedCost(usd: number | null): string {
  return usd === null ? 'Unknown' : `$${usd.toFixed(2)}`;
}

export interface EffectDescription {
  /** The discriminator every consumer branches on, e.g. `git-push`. */
  kind: string;
  /** Its remaining fields, flattened. Empty string when it has none. */
  detail: string;
}

/**
 * One declared effect, flattened for display.
 *
 * Rendered generically rather than with a per-kind template, and that is a
 * decision rather than laziness: `effects` is a FROZEN RECORD of what a
 * historical action declared it would do, and the union it was written against
 * can widen. A per-kind renderer would silently show nothing for a shape it
 * did not recognise — on the screen whose whole job is to say what the action
 * would do. Printing every field means an unknown effect is still legible.
 */
export function describeEffect(effect: ApprovalEffect): EffectDescription {
  const detail = Object.entries(effect)
    .filter(([field]) => field !== 'kind')
    .map(([field, value]) => `${field}: ${formatEffectValue(value)}`)
    .join(' · ');

  return { kind: effect.kind, detail };
}

function formatEffectValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
