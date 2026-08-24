import {
  DEFAULT_SNAPSHOT_LIMITS,
  type RenderedSnapshot,
  type SnapshotEscalation,
  type SnapshotInput,
  type SnapshotLimits,
  type SnapshotRun,
  type SnapshotSpecRejection,
  type SnapshotWorkOrder,
  type TruncationNote,
} from './snapshot.types';

/**
 * Render Postgres state into the bounded text the supervisor reasons over
 * (#88).
 *
 * ## Pure, and why that is the requirement rather than a preference
 *
 * No clock, no client, no I/O. Every time-dependent value is derived from
 * `input.generatedAt`, which the caller supplies. #90 stores the rendered text
 * beside the proposal it produced, and the first question when reviewing a
 * proposal is "what did it actually know?" — a renderer that read the clock
 * would answer that question differently every time it was asked, which is the
 * same as not answering it.
 *
 * ## Bounded, and truncation that is loud
 *
 * Every list is capped per section (`SnapshotLimits`) and a dropped row is
 * ANNOUNCED in the output: `… 12 more not shown (of 27)`. This matters more
 * than it looks. A snapshot silently cut to fit produces confident wrong
 * answers rather than errors — the model does not know it is looking at a
 * partial factory, so it reasons about the part it can see as if that were all
 * of it. Saying so in the text lets the model hedge, and storing the
 * `truncatedSections` list lets a reviewer see the bias afterwards.
 *
 * ## Deterministic ordering
 *
 * Sorting is done by the CALLER (the service issues ordered queries), and this
 * function preserves the order it is given. What the renderer guarantees is
 * that identical input produces identical output — no map iteration over
 * object keys, no locale-dependent formatting, no floating-point rendering
 * that varies by platform.
 */
export function renderSnapshot(
  input: SnapshotInput,
  limits: SnapshotLimits = DEFAULT_SNAPSHOT_LIMITS,
): RenderedSnapshot {
  const notes: TruncationNote[] = [];
  const lines: string[] = [];

  lines.push('# Factory snapshot');
  lines.push('');
  lines.push(`Generated at: ${iso(input.generatedAt)}`);
  lines.push(`Window: last ${input.windowDays} day(s)`);
  lines.push('');

  lines.push('## Totals');
  lines.push('');
  const t = input.totals;
  lines.push(
    `Runs: ${t.runsRunning} running, ${t.runsStalled} stalled, ${t.runsBlocked} blocked`,
  );
  lines.push(
    `Runs in window: ${t.runsSucceededInWindow} succeeded, ${t.runsFailedInWindow} failed`,
  );
  lines.push(
    `Work orders: ${t.workOrdersQueued} queued, ${t.workOrdersHeld} held, ${t.workOrdersQuarantined} quarantined`,
  );
  lines.push(`Escalations outstanding: ${t.escalationsOutstanding}`);
  lines.push('');

  section(
    lines,
    notes,
    'Runs needing attention',
    input.attentionRuns,
    limits.attentionRuns,
    (run) => runLines(run, input.generatedAt, limits.textField),
    'No run currently needs attention.',
  );

  section(
    lines,
    notes,
    'Recently concluded runs',
    input.recentRuns,
    limits.recentRuns,
    (run) => runLines(run, input.generatedAt, limits.textField),
    'No run concluded in the window.',
  );

  section(
    lines,
    notes,
    'Queued work orders',
    input.queuedWorkOrders,
    limits.queuedWorkOrders,
    (wo) => workOrderLines(wo, input.generatedAt, limits.textField),
    'The queue is empty.',
  );

  section(
    lines,
    notes,
    'Quarantined work orders',
    input.quarantinedWorkOrders,
    limits.quarantinedWorkOrders,
    (wo) => workOrderLines(wo, input.generatedAt, limits.textField),
    'Nothing is quarantined.',
  );

  section(
    lines,
    notes,
    'Outstanding escalations',
    input.escalations,
    limits.escalations,
    (esc) => escalationLines(esc, input.generatedAt, limits.textField),
    'No escalation is outstanding.',
  );

  section(
    lines,
    notes,
    'Issues the spec gate rejected',
    input.specRejections,
    limits.specRejections,
    (rejection) =>
      rejectionLines(rejection, input.generatedAt, limits.textField),
    'No issue was turned away for a bad specification.',
  );

  if (notes.length > 0) {
    lines.push('## Truncation');
    lines.push('');
    lines.push(
      'This snapshot does not show the whole factory. Sections below dropped rows:',
    );
    for (const note of notes) {
      lines.push(`- ${note.section}: showing ${note.shown} of ${note.total}`);
    }
    lines.push('');
  }

  const text = lines.join('\n').trimEnd() + '\n';

  return {
    text,
    truncated: notes.length > 0,
    truncatedSections: notes,
    characters: text.length,
  };
}

/**
 * Emit one capped section.
 *
 * The truncation line goes INSIDE the section as well as into the summary at
 * the end. A model that reads only as far as the queue should still learn the
 * queue was cut, rather than having to reach a footer to find out.
 */
function section<T>(
  lines: string[],
  notes: TruncationNote[],
  title: string,
  items: readonly T[],
  cap: number,
  render: (item: T) => string[],
  emptyMessage: string,
): void {
  lines.push(`## ${title}`);
  lines.push('');

  if (items.length === 0) {
    lines.push(emptyMessage);
    lines.push('');
    return;
  }

  const shown = items.slice(0, Math.max(0, cap));
  for (const item of shown) {
    for (const line of render(item)) lines.push(line);
  }

  if (items.length > shown.length) {
    const dropped = items.length - shown.length;
    lines.push(`… ${dropped} more not shown (of ${items.length}).`);
    notes.push({ section: title, shown: shown.length, total: items.length });
  }

  lines.push('');
}

function runLines(run: SnapshotRun, now: Date, textCap: number): string[] {
  const out: string[] = [];
  out.push(
    `- run ${run.id} · ${run.repository}#${run.issueNumber} · ${run.status} · runner ${run.runnerKey}`,
  );
  out.push(
    `  work order: ${run.workOrderIdentity} (attempt ${run.attemptCount})`,
  );
  if (run.issueTitle) out.push(`  title: ${clip(run.issueTitle, textCap)}`);
  out.push(
    `  started ${age(run.startedAt, now)} ago; ` +
      (run.endedAt ? `ended ${age(run.endedAt, now)} ago` : 'not ended'),
  );
  out.push(
    `  last event: ${run.lastEventAt ? `${age(run.lastEventAt, now)} ago` : 'none received'}`,
  );
  // "unknown" and "$0.00" are different facts (VISION §6), so they render
  // differently. Collapsing them would let the supervisor propose a budget
  // action against a runner that never reported a cost in its life.
  out.push(
    `  cost: ${run.costUsd === null ? 'not reported' : usd(run.costUsd)}`,
  );
  if (run.attentionReason)
    out.push(`  attention: ${clip(run.attentionReason, textCap)}`);
  if (run.stopReason) out.push(`  stopped: ${clip(run.stopReason, textCap)}`);
  if (run.pullRequestNumber !== null) {
    out.push(
      `  pull request: #${run.pullRequestNumber} (${run.pullRequestState ?? 'open'})`,
    );
  }
  return out;
}

function workOrderLines(
  wo: SnapshotWorkOrder,
  now: Date,
  textCap: number,
): string[] {
  const out: string[] = [];
  out.push(
    `- ${wo.identity} · ${wo.repository}#${wo.issueNumber} · ${wo.status} · attempt ${wo.attempt}`,
  );
  if (wo.issueTitle) out.push(`  title: ${clip(wo.issueTitle, textCap)}`);
  out.push(
    `  acceptance criteria: ${wo.acceptanceCriteriaCount}; created ${age(wo.createdAt, now)} ago`,
  );
  return out;
}

function rejectionLines(
  rejection: SnapshotSpecRejection,
  now: Date,
  textCap: number,
): string[] {
  return [
    `- ${rejection.repository}#${rejection.issueNumber} · rejected ${age(rejection.rejectedAt, now)} ago`,
    `  told the author: ${clip(rejection.message, textCap)}`,
  ];
}

function escalationLines(
  esc: SnapshotEscalation,
  now: Date,
  textCap: number,
): string[] {
  return [
    `- ${esc.kind} · ${esc.status} · raised ${age(esc.raisedAt, now)} ago`,
    `  ${clip(esc.summary, textCap)}`,
    `  run: ${esc.runId ?? 'none (system escalation)'}`,
  ];
}

/**
 * An age, coarsened deliberately.
 *
 * Whole minutes below an hour, then one decimal of hours, then one decimal of
 * days. Second-level precision would make two snapshots of an unchanged
 * factory differ in every line, which defeats the point of storing them for
 * comparison — and no supervisor proposal turns on whether a run has been
 * silent for 41 or 42 seconds.
 */
export function age(then: Date, now: Date): string {
  const ms = now.getTime() - then.getTime();
  if (ms < 0) return 'in the future';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = ms / 3_600_000;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

/**
 * Clip a free-text field, and SAY it was clipped.
 *
 * A stop reason cut mid-sentence with no marker reads as a complete thought
 * that happens to be strange, and the supervisor will diagnose the strangeness
 * rather than the failure.
 */
export function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(0, max - 1))}… [clipped, ${flat.length} chars]`;
}

/** Fixed two decimals, so the same cost always renders the same string. */
function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}

/** ISO 8601 in UTC. No locale, no timezone drift between environments. */
function iso(date: Date): string {
  return date.toISOString();
}
