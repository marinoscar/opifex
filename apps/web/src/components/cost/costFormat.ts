/**
 * How money is rendered on the cost screen (#213).
 *
 * The distinctions here are the screen's whole honesty argument, so they live
 * in one tested module rather than as inline ternaries.
 */

/**
 * Dollars, or an em dash for "nothing reported".
 *
 * Null is NOT zero. VISION §6 makes cost reporting a declared capability, so a
 * window in which no runner reported anything must not render as a window in
 * which nothing was spent.
 */
export function money(usd: number | null): string {
  return usd === null ? '—' : `$${usd.toFixed(2)}`;
}

/** Four places, for figures small enough that two would round to nothing. */
export function preciseMoney(usd: number | null): string {
  return usd === null ? '—' : `$${usd.toFixed(4)}`;
}

/**
 * Whether a total is really a floor.
 *
 * #213: the total is a floor whenever runs reported nothing, and the screen has
 * to say so rather than presenting it as a figure. Two different causes, and
 * the caveat names which applies:
 *
 * - `runsWithoutCost` — runs that reported no cost but had a ceiling, so their
 *   spend is estimated rather than unknown.
 * - `unboundedRuns` — runs with neither a report nor a ceiling. Nothing bounds
 *   them, so the total below them could be arbitrarily wrong.
 */
export function floorCaveat(summary: {
  runsWithoutCost: number;
  unboundedRuns: number;
}): string | null {
  if (summary.unboundedRuns > 0) {
    return `A floor, not a total: ${summary.unboundedRuns} run(s) reported no cost and had no ceiling to bound them.`;
  }
  if (summary.runsWithoutCost > 0) {
    return `Includes an estimate: ${summary.runsWithoutCost} run(s) reported no cost and are counted at their authorized ceiling.`;
  }
  return null;
}

/**
 * How much of the ceiling is used, as a percentage, or null when unknowable.
 *
 * Null rather than 0 when no ceiling is configured, because a missing ceiling
 * REFUSES dispatch rather than permitting it — drawing an empty bar would say
 * the opposite of what a null limit means.
 */
export function ceilingUsedPercent(
  limitUsd: number | null,
  totalUsd: number,
): number | null {
  if (limitUsd === null || limitUsd <= 0) return null;
  return Math.min(100, (totalUsd / limitUsd) * 100);
}
