import type { DefaultGrantAttributes } from './defaults';

/**
 * Renewal, the narrowing half (#115, epic #22).
 *
 * VISION §8: *"Expiry — days or session. Renewal is one tap; silence
 * revokes."* #96 built the second half — `authorize` filters on
 * `expiresAt > now`, so a lapsed grant stops authorizing with no grace period
 * — and this file is part of the first.
 *
 * ## Why renewal does not copy the old grant's attributes forward
 *
 * The obvious implementation is `create({ ...oldRow, expiresAt: now + 14d })`,
 * and it is wrong in a way that takes months to become visible. A grant
 * created once with generous attributes — an explicit $500 ceiling for a
 * migration weekend, say — would carry them for as long as somebody keeps
 * tapping renew, and the chain would launder a ONE-TIME decision into a
 * PERMANENT one. That is precisely the outcome VISION §8 opens by warning
 * about: nobody ever decides to grant blanket trust, they arrive at it one
 * frictionless tap at a time.
 *
 * So a renewal starts from `defaultGrantAttributes(now)` — the same numbers
 * the one-tap creation path uses — and the old grant may only make them
 * NARROWER. An operator who genuinely wants the wide grant back can still
 * create one explicitly through `TrustGrantService.create`, where the numbers
 * are recorded on the row as their choice, which is exactly the asymmetry
 * `defaults.ts` argues for.
 *
 * ## Why this is a separate pure function with its own spec
 *
 * #115's acceptance criterion is that no renewal path can widen anything, and
 * that is the kind of property a later well-meaning refactor breaks silently:
 * inline `Math.min` calls scattered through a transaction body look like
 * plumbing, and a fifth attribute added without its `min` reads as an
 * omission nobody notices in review. One function, one argument per attribute,
 * one assertion per attribute in the spec.
 */

/**
 * The old grant, as narrowing sees it.
 *
 * Structural rather than `TrustGrantRow` or `TrustGrantView`, so the spec can
 * pass a literal and the function stays independent of Prisma's Decimal.
 */
export interface NarrowableGrant {
  /** When the old grant started authorizing. With `expiresAt`, its LENGTH. */
  createdAt: Date;
  /** When the old grant stops authorizing. */
  expiresAt: Date;
  budgetCeilingUsd: number;
  maxFailureRate: number;
  maxCostPerActionUsd: number;
  minActionsBeforeAutoRevoke: number;
}

/**
 * The narrower of the old grant and the defaults, attribute by attribute.
 *
 * Every attribute is a `min`, because for all five of them SMALLER IS
 * NARROWER — including the two where that is not obvious:
 *
 *  - `maxFailureRate`: a lower ceiling on failures revokes SOONER.
 *  - `minActionsBeforeAutoRevoke`: a lower sample-size floor lets the two
 *    rate rules fire EARLIER. A renewal that raised it would delay
 *    auto-revoke, which is a widening dressed as a statistics improvement.
 *
 * ## `now` is a parameter, and expiry is the reason
 *
 * The other four attributes are magnitudes and compare directly. Expiry is an
 * INSTANT, and comparing instants would be wrong in the one direction that
 * matters: the old grant's `expiresAt` is by definition within hours of now
 * when a renewal happens, so `min(old.expiresAt, defaults.expiresAt)` would
 * return the old one every time and produce a "renewal" that expires this
 * afternoon. Renewal would then be a no-op that looks like it worked, which is
 * worse than refusing.
 *
 * So expiry is narrowed as a DURATION: the new grant runs for the shorter of
 * the default 14 days and the length the old grant was originally given,
 * measured from `now`. An operator who deliberately created a 2-day grant gets
 * 2 days back; nobody gets more than the default.
 *
 * A non-finite or non-positive old duration — a corrupt row, a clock that
 * moved — falls back to the DEFAULT duration rather than propagating. The
 * alternative is a computed expiry at or before `now`, which
 * `TrustGrantService.create` refuses outright, so the "conservative" reading
 * would make such a grant permanently un-renewable with an error naming a
 * column the operator cannot see. The default is the safe-by-construction
 * value; falling back to it is bounded, and it is what the fast path would
 * have produced anyway.
 */
export function narrowerOf(
  old: NarrowableGrant,
  defaults: DefaultGrantAttributes,
  now: Date,
): DefaultGrantAttributes {
  const defaultDurationMs = defaults.expiresAt.getTime() - now.getTime();
  const oldDurationMs = old.expiresAt.getTime() - old.createdAt.getTime();
  const usableOldDuration =
    Number.isFinite(oldDurationMs) && oldDurationMs > 0
      ? oldDurationMs
      : defaultDurationMs;

  return {
    expiresAt: new Date(
      now.getTime() + Math.min(defaultDurationMs, usableOldDuration),
    ),
    budgetCeilingUsd: narrower(old.budgetCeilingUsd, defaults.budgetCeilingUsd),
    maxFailureRate: narrower(old.maxFailureRate, defaults.maxFailureRate),
    maxCostPerActionUsd: narrower(
      old.maxCostPerActionUsd,
      defaults.maxCostPerActionUsd,
    ),
    minActionsBeforeAutoRevoke: narrower(
      old.minActionsBeforeAutoRevoke,
      defaults.minActionsBeforeAutoRevoke,
    ),
  };
}

/**
 * `Math.min`, except that an unreadable old value does not win.
 *
 * `Math.min(NaN, 25)` is `NaN`, and a NaN ceiling is not a narrow ceiling — it
 * is a ceiling every comparison fails against, which is the one direction a
 * budget check must never fail in (`trust-grant.service.ts` makes the same
 * argument about `decimalToNumber`). A Decimal column that would not convert
 * therefore contributes nothing and the default stands.
 */
function narrower(oldValue: number, defaultValue: number): number {
  if (!Number.isFinite(oldValue)) return defaultValue;
  return Math.min(oldValue, defaultValue);
}
