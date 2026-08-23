/**
 * What arrives on the phone.
 *
 * VISION §8 sets the bar exactly: *"one tap from a phone, with enough context
 * to decide — what, why, blast radius, and what happens if ignored."* Those
 * four are fields here rather than prose, because prose is what gets trimmed
 * first when someone is writing a notification in a hurry, and the field that
 * always survives is the one that says least.
 */
export interface NotificationPayload {
  /** The escalation this is about, for the receipt and the deep link. */
  escalationId: string;
  /**
   * The capability token the device posts back to confirm delivery.
   *
   * Unguessable, and it is the ONLY credential the receipt endpoint needs. A
   * service worker has no session and no bearer token; requiring one would
   * mean either no receipts or a token stored where a service worker can read
   * it, and this is neither.
   */
  receiptId: string;

  /** Notification title. Short enough for a lock screen. */
  title: string;
  /** WHAT happened. */
  body: string;

  /** WHY it happened, naming the observed numbers. */
  why: string;
  /** BLAST RADIUS: what else is affected. */
  blastRadius: string;
  /** What happens IF IGNORED. The field that decides whether to get up. */
  ifIgnored: string;

  /** Deep link into the cockpit, for the one tap. */
  url: string;
  /** Escalation kind, so the device can group or style it. */
  kind: string;
  /** ISO-8601, so a notification delivered late says so. */
  raisedAt: string;
}

export interface EscalationForNotification {
  id: string;
  kind: string;
  summary: string;
  detail: string | null;
  raisedAt: Date;
  progressStoppedAt: Date | null;
  run: {
    workOrder: {
      identity: string;
      issueNumber: number;
      repository: { owner: string; name: string };
    };
  } | null;
}

/**
 * Consequence by kind: blast radius, and what happens if nobody acts.
 *
 * Written per kind rather than generated, because the honest answer differs.
 * A stalled run is burning nothing and simply not finishing; a run over
 * budget is spending money right now. A single generic sentence would have to
 * be vague enough to cover both, and a notification that cannot distinguish
 * "this can wait until morning" from "this is costing money" fails the only
 * test that matters at 2am.
 */
const CONSEQUENCES: Record<string, { blastRadius: string; ifIgnored: string }> =
  {
    run_stalled: {
      blastRadius:
        'One run. Its work order stays open and nothing downstream of it proceeds.',
      ifIgnored:
        'The run stays stopped. No spend, no damage — just no progress, indefinitely. ' +
        'This is the four-hours-dead case: safe to leave until morning, wasteful to leave until Monday.',
    },
    run_looping: {
      blastRadius:
        'One run, still consuming tokens on a repeating action that is not progressing.',
      ifIgnored:
        'Spend continues with no output. Re-running it unchanged would loop again — the work ' +
        'order needs decomposing, which is a decision only you can make right now.',
    },
    run_failed: {
      blastRadius:
        'One run, ended. Its branch and any commits it made are intact.',
      ifIgnored:
        'Nothing worsens. The work order simply never completes until someone re-plans it.',
    },
    quarantined: {
      blastRadius:
        'One work order, and every retry of it. Opifex will not touch it again without you.',
      ifIgnored:
        'It stays parked forever. Quarantine is deliberate — VISION §8 makes a human the only ' +
        'way out — so nothing clears this on its own.',
    },
    budget_exceeded: {
      blastRadius:
        'One run stopped at its ceiling. Spend has already happened.',
      ifIgnored:
        'No further spend: the ceiling held. The work is incomplete until you raise the ceiling ' +
        'or split the work order.',
    },
    system: {
      blastRadius:
        'The control plane itself. Detection and dispatch may be degraded across every repository.',
      ifIgnored:
        'Opifex may stop noticing that runs have gone quiet — which is the failure it exists to ' +
        'prevent, now invisible.',
    },
  };

const UNKNOWN_CONSEQUENCE = {
  blastRadius: 'Unknown — this escalation kind has no recorded consequence.',
  ifIgnored:
    'Unknown. Treat as urgent: an escalation nobody can characterise is worse than one that ' +
    'can be, not better.',
};

export function buildPayload(
  escalation: EscalationForNotification,
  receiptId: string,
  appUrl: string,
): NotificationPayload {
  const consequence = CONSEQUENCES[escalation.kind] ?? UNKNOWN_CONSEQUENCE;
  const workOrder = escalation.run?.workOrder;

  return {
    escalationId: escalation.id,
    receiptId,
    title: titleFor(escalation.kind),
    body: escalation.summary,
    // The detail already names the numbers that produced the decision (#47:
    // "the reason is not a log message"). Passing it through unchanged is the
    // point — a summarised reason is one the operator cannot check.
    why: escalation.detail ?? escalation.summary,
    blastRadius: consequence.blastRadius,
    ifIgnored: consequence.ifIgnored,
    // Straight to the run, not to a dashboard the operator then has to
    // navigate. VISION §8's "one tap" is a literal requirement.
    url: workOrder
      ? `${appUrl}/runs?issue=${workOrder.repository.owner}/${workOrder.repository.name}%23${workOrder.issueNumber}`
      : `${appUrl}/escalations`,
    kind: escalation.kind,
    raisedAt: escalation.raisedAt.toISOString(),
  };
}

function titleFor(kind: string): string {
  switch (kind) {
    case 'run_stalled':
      return 'Run stalled';
    case 'run_looping':
      return 'Run looping';
    case 'run_failed':
      return 'Run failed';
    case 'quarantined':
      return 'Work order quarantined';
    case 'budget_exceeded':
      return 'Budget ceiling hit';
    case 'system':
      return 'Opifex needs attention';
    default:
      return 'Opifex escalation';
  }
}

/**
 * Every kind the payload builder knows how to characterise.
 *
 * Exported so a spec can pin it against the Prisma enum: a kind added to the
 * schema and missed here would notify with "Unknown", which is exactly the
 * kind of degradation that survives review because it still works.
 */
export const CHARACTERISED_KINDS = Object.keys(CONSEQUENCES);
