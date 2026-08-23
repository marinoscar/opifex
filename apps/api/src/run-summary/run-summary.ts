/**
 * The VISION §5 run summary, composed (#67).
 *
 * > Commits and PRs land in GitHub naturally. **What the agent did and why it
 * > stopped does not** — unless deliberately written there. The run summary PR
 * > comment exists precisely to close that gap. It is the join point between
 * > the human-readable record and the telemetry store.
 *
 * VISION §1's second motivation is the reason it has to be written at the time:
 * lost hours can be recovered by working faster; **lost provenance cannot be
 * recovered at all.** Three weeks later the diff shows what changed and nothing
 * shows why the run stopped where it did.
 *
 * ## The format is a contract, not decoration
 *
 * #67 asks for it to be "stable enough to parse later, per VISION §5's
 * knowledge-graph ambition". So the marker carries the identifiers as
 * attributes — a later extractor reads them without parsing prose or a table —
 * and the table below is for the human. Changing a row label is safe; changing
 * the marker is a breaking change to anything that has already indexed it.
 */

/** Everything the summary states, gathered by the caller. */
export interface RunSummaryFacts {
  runId: string;
  workOrderIdentity: string;
  attempt: number;
  retryCeiling: number;
  runnerKey: string;
  runnerVersion: string | null;
  status:
    'succeeded' | 'failed' | 'stalled' | 'quarantined' | 'blocked' | 'running';
  startedAt: Date;
  endedAt: Date | null;
  costUsd: number | null;
  tokensInput: number | null;
  tokensOutput: number | null;
  /** The run's `attentionReason` — the closest thing to "why it stopped". */
  attentionReason: string | null;
}

/** The HTML comment that makes a summary findable and re-findable. */
export const RUN_SUMMARY_MARKER = '<!-- opifex:run-summary';

/**
 * Why the run stopped, in one line.
 *
 * #67: "'Why it stopped' is the field that carries the value. Succeeded, killed
 * for silence, killed for looping, budget exceeded, timed out, quarantined
 * after N attempts — each is a different story, and none is reconstructible
 * from the diff three weeks later."
 *
 * The specific stories arrive as `attentionReason`, written by whichever
 * mechanism stopped the run — the watchdog, the budget sweep, the deadline
 * sweep. This does not re-derive them; re-deriving would produce a second
 * opinion about a fact already recorded, and the two would eventually differ.
 */
export function whyItStopped(facts: RunSummaryFacts): string {
  if (facts.attentionReason) return facts.attentionReason;
  if (facts.status === 'succeeded') {
    return 'Completed: the runner reported success.';
  }
  // A failed run should always carry a reason — `run.failed` requires one in
  // the schema. Saying so plainly beats an empty cell that reads as "no reason
  // was needed".
  return `Ended as ${facts.status} with no reason recorded.`;
}

/** `1h 04m 12s`, or `—` when the run never concluded. */
export function formatDuration(startedAt: Date, endedAt: Date | null): string {
  if (!endedAt) return '—';

  const totalSeconds = Math.max(
    0,
    Math.round((endedAt.getTime() - startedAt.getTime()) / 1000),
  );
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const pad = (n: number) => String(n).padStart(2, '0');
  return hours > 0
    ? `${hours}h ${pad(minutes)}m ${pad(seconds)}s`
    : `${minutes}m ${pad(seconds)}s`;
}

/**
 * Cost, preserving the difference between unknown and zero.
 *
 * VISION §6 makes cost reporting a declared capability, so a runner that cannot
 * report cost must not be shown as one that spent nothing.
 */
export function formatCost(costUsd: number | null): string {
  return costUsd === null ? 'not reported' : `$${costUsd.toFixed(4)}`;
}

export function composeRunSummary(facts: RunSummaryFacts): string {
  const runner = facts.runnerVersion
    ? `\`${facts.runnerKey}@${facts.runnerVersion}\``
    : `\`${facts.runnerKey}\``;

  const tokens =
    facts.tokensInput === null && facts.tokensOutput === null
      ? 'not reported'
      : `${facts.tokensInput ?? 0} in / ${facts.tokensOutput ?? 0} out`;

  const outcome = facts.status === 'succeeded' ? 'succeeded' : facts.status;

  return [
    // Identifiers as attributes: an extractor reads these without parsing the
    // table, and the run id is what resolves the full event stream in the
    // telemetry store.
    `${RUN_SUMMARY_MARKER} run=${facts.runId} work-order=${facts.workOrderIdentity} attempt=${facts.attempt} -->`,
    `**Run ${outcome}** — \`${facts.workOrderIdentity}\``,
    '',
    '| | |',
    '| --- | --- |',
    `| **Why it stopped** | ${whyItStopped(facts)} |`,
    `| **Runner** | ${runner} |`,
    `| **Attempt** | ${facts.attempt} of ${facts.retryCeiling} |`,
    `| **Duration** | ${formatDuration(facts.startedAt, facts.endedAt)} |`,
    `| **Cost** | ${formatCost(facts.costUsd)} |`,
    `| **Tokens** | ${tokens} |`,
    '',
    `Run \`${facts.runId}\` — its full event stream, one span per turn and per`,
    'tool call, is in the telemetry store.',
  ].join('\n');
}
