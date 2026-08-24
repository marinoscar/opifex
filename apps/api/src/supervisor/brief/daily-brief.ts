import type { SnapshotInput } from '../snapshot/snapshot.types';
import {
  type TrustDigest,
  type TrustExecutedItem,
  renderTrustDigest,
} from './trust-digest';

/**
 * Re-exported so the name stays where ADR-0012 put it.
 *
 * The definition moved to `trust-digest.ts` with #100, because that is now
 * what produces these items. Every existing importer keeps working, and the
 * shape is unchanged apart from three OPTIONAL fields — see the interface.
 */
export type { TrustExecutedItem };

/**
 * The daily brief (#93, ADR-0012).
 *
 * VISION §8's goal is "not fewer decisions but **decisions batched and moved
 * off the critical path**", and the brief is the batching mechanism: the
 * things that did not warrant waking someone, gathered and ranked.
 *
 * ## Ranking is the whole feature
 *
 * #93 says so outright: "a chronological list of everything that happened is a
 * log, and it will not be read after the first week. The brief is worth
 * building only if the top item is reliably the thing most worth looking at."
 *
 * So the rank is computed from what the item COSTS TO IGNORE, and every item
 * states why it ranks where it does. A brief whose ordering cannot be argued
 * with is one nobody can correct when it gets the order wrong.
 */

/** Rank bands, low number first. The number is never shown; the reason is. */
export enum BriefRank {
  /**
   * A human has already been asked and has not answered.
   *
   * Top, and not because it is the most severe — a stalled run costs nothing
   * while it sits. It is top because an unacknowledged escalation means the
   * notification path may have failed silently, which #58 calls the failure
   * "indistinguishable from no escalation" and the one this system exists to
   * eliminate.
   */
  Unacknowledged = 0,
  /** Only a human can clear it, so nothing else will (VISION §8). */
  Quarantined = 1,
  /** Stopped and nobody has been told. */
  SilentRun = 2,
  /** Ended badly inside the window. */
  RecentFailure = 3,
  /** Waiting on a specification, before anything is spent on it. */
  ThinSpec = 4,
}

export interface BriefItem {
  rank: BriefRank;
  /** One line: what it is. */
  headline: string;
  /** Why it ranks here. The sentence that makes the ordering arguable. */
  why: string;
  /** What it points at, for a link. */
  ref: string;
}

export interface DailyBrief {
  /** Ranked, most in need of a human first. */
  items: BriefItem[];
  /** True when nothing needed anybody. */
  quiet: boolean;
  /**
   * Actions executed under trust since the last brief.
   *
   * ADR-0012: the trust digest (#100) EXTENDS the brief rather than becoming a
   * second daily email. Empty today because no action class is promoted —
   * VISION §7 rung 3 is at least a month away — and the field exists now so
   * #100 has a section to fill rather than an artifact to invent.
   *
   * This section carries a completeness guarantee the ranked items do not: it
   * is rendered IN FULL, or the brief says how many it could not show. A
   * truncated attention list costs an operator one look; a truncated trust
   * list silently omits something that happened without them.
   */
  trustExecuted: TrustExecutedItem[];
  /** How many trust-executed actions exist beyond those listed. */
  trustNotShown: number;
  /**
   * The rest of the trust digest (#100): cost per grant, budget and expiry
   * headroom, grants that ended, and what looked unusual.
   *
   * OPTIONAL, and that is load-bearing rather than laziness. Absent means "no
   * trust data was read" — which is what a deployment with no grants, or one
   * whose digest query failed, produces — and it renders as the pre-#100
   * sentence rather than as a set of empty headings. #94's argument, applied
   * one level down: the ranked half of the brief must not be lost because the
   * retrospective half could not be computed.
   */
  trustDigest?: TrustDigest;
}

/** How many ranked items the brief carries. */
export const MAX_BRIEF_ITEMS = 12;

/**
 * Rank a day.
 *
 * PURE, and takes the same snapshot input the supervisor reasons from, so the
 * brief and the proposals in the log describe one factory rather than two
 * reads of it a second apart.
 *
 * `digest` is optional and is NOT consulted by the ranking. ADR-0012 gives the
 * reason: the two halves answer different questions, and letting what ran
 * under trust reorder what needs a human would blur the one property #93 says
 * the brief is worth building for — that the top item is reliably the thing
 * most worth looking at.
 */
export function rankBrief(
  state: SnapshotInput,
  digest?: TrustDigest,
): DailyBrief {
  const items: BriefItem[] = [];

  for (const escalation of state.escalations) {
    items.push({
      rank: BriefRank.Unacknowledged,
      headline: `Unacknowledged ${escalation.kind}: ${escalation.summary}`,
      why:
        'Raised and never acknowledged. The notification may have failed silently, ' +
        'which is indistinguishable from never having noticed.',
      ref: escalation.runId ?? escalation.id,
    });
  }

  for (const order of state.quarantinedWorkOrders) {
    items.push({
      rank: BriefRank.Quarantined,
      headline: `Quarantined: ${order.identity} (${order.repository}#${order.issueNumber})`,
      why:
        `Attempt ${order.attempt} exhausted the retry ceiling. Nothing clears quarantine ` +
        'except a human, so this stays parked indefinitely.',
      ref: order.identity,
    });
  }

  for (const run of state.attentionRuns) {
    if (run.status !== 'stalled') continue;
    items.push({
      rank: BriefRank.SilentRun,
      headline: `Silent run: ${run.workOrderIdentity} (${run.repository}#${run.issueNumber})`,
      why:
        run.attentionReason ??
        'The watchdog marked it stalled. It is spending nothing and finishing nothing.',
      ref: run.id,
    });
  }

  for (const run of state.recentRuns) {
    if (run.status !== 'failed') continue;
    items.push({
      rank: BriefRank.RecentFailure,
      headline: `Failed: ${run.workOrderIdentity} (${run.repository}#${run.issueNumber})`,
      why:
        run.stopReason ??
        run.attentionReason ??
        'Ended as failed. Nothing worsens until someone re-plans it.',
      ref: run.id,
    });
  }

  for (const order of state.queuedWorkOrders) {
    // The floor (#62) already refused zero criteria, so what reaches here is
    // an order that CLEARED the gate and is still thin. Ranked last because it
    // has cost nothing yet — which is also why it is the cheapest to fix.
    if (order.acceptanceCriteriaCount > 1) continue;
    items.push({
      rank: BriefRank.ThinSpec,
      headline: `Thin specification: ${order.identity} (${order.repository}#${order.issueNumber})`,
      why:
        `${order.acceptanceCriteriaCount} acceptance criteria, queued and not yet ` +
        'dispatched. Cheapest to fix now, most expensive after a failed run.',
      ref: order.identity,
    });
  }

  // A total order. `rank` first, then the order the snapshot supplied — which
  // is already "most starved first" inside each list, so two items of the same
  // rank keep that meaning rather than being shuffled.
  const ranked = items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => a.item.rank - b.item.rank || a.index - b.index)
    .map(({ item }) => item)
    .slice(0, MAX_BRIEF_ITEMS);

  return {
    items: ranked,
    quiet: ranked.length === 0,
    trustExecuted: digest?.executed ?? [],
    trustNotShown: digest?.notShown ?? 0,
    ...(digest ? { trustDigest: digest } : {}),
  };
}

/**
 * Render the brief.
 *
 * A quiet day produces a SHORT brief, not a padded one — #93's second
 * criterion. Padding a quiet day is how a daily email teaches its reader that
 * most of it can be skipped, and after that the loud day gets skipped too.
 */
export function composeBrief(brief: DailyBrief, state: SnapshotInput): string {
  const lines: string[] = [];

  lines.push(
    `Opifex daily brief — ${state.generatedAt.toISOString().slice(0, 10)}`,
  );
  lines.push('');

  if (brief.quiet) {
    lines.push(
      `Nothing needed you. ${state.totals.runsSucceededInWindow} run(s) succeeded, ` +
        `${state.totals.runsFailedInWindow} failed, ${state.totals.workOrdersQueued} queued.`,
    );
  } else {
    lines.push('Ranked by what needs you, most first:');
    lines.push('');
    brief.items.forEach((item, index) => {
      lines.push(`${index + 1}. ${item.headline}`);
      lines.push(`   ${item.why}`);
    });
    lines.push('');
    lines.push(
      `Totals: ${state.totals.runsRunning} running, ${state.totals.runsStalled} stalled, ` +
        `${state.totals.runsBlocked} blocked, ${state.totals.workOrdersQueued} queued.`,
    );
  }

  lines.push('');
  lines.push(...trustSection(brief));

  return lines.join('\n');
}

/**
 * The trust digest, as a section (ADR-0012).
 *
 * Rendered in full, or explicitly counted. The ranked items above are capped
 * because attention is scarce; this is not, because an omission here is an
 * action that happened without the operator and was not reported.
 */
export function trustSection(brief: DailyBrief): string[] {
  // #100's digest renders itself, because it knows about cost, headroom,
  // endings and anomalies — and because it owns the one-line quiet form, which
  // depends on facts (are there grants at all?) this function cannot see.
  if (brief.trustDigest) return renderTrustDigest(brief.trustDigest);

  if (brief.trustExecuted.length === 0 && brief.trustNotShown === 0) {
    return [
      'Ran under trust: nothing. No action class is promoted, so every action ' +
        'still went through a human.',
    ];
  }

  const lines = ['Ran under trust:'];
  for (const item of brief.trustExecuted) {
    lines.push(
      `- ${item.at} · ${item.actionClass} · ${item.summary} (${item.ref})`,
    );
  }
  if (brief.trustNotShown > 0) {
    lines.push(
      `- and ${brief.trustNotShown} more not listed here. This section is meant to be ` +
        'complete; a truncated one is an action that happened without you and was not reported.',
    );
  }
  return lines;
}
