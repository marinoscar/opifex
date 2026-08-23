/**
 * Prisma's `Decimal`, as the number a JSON document wants.
 *
 * ## Why this is shared rather than inlined
 *
 * Three cockpit read models return `costUsd`, and the first two converted it
 * two different ways — `.toNumber()` in one and `Number(...)` in another. Both
 * work against a real `Decimal` (decimal.js implements `toString`), so nothing
 * failed; the disagreement only surfaced because a test double implemented
 * `toNumber` and not `toString`, and `Number(...)` quietly produced `NaN`.
 *
 * That is the shape of the bug worth preventing: a conversion that is correct
 * in production, wrong against a double, and therefore tested into a false
 * sense of coverage. One function means one answer.
 *
 * ## Null is preserved, never coerced
 *
 * `Number(null)` is `0`, and "the runner reports no cost" is not the claim
 * "this run was free". The cost screen is where that distinction is most
 * expensive to lose.
 */
export interface DecimalLike {
  toNumber(): number;
}

export function toNumberOrNull(value: DecimalLike | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'number' ? value : value.toNumber();
}
