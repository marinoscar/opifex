import { ALL_MIRROR_LABELS } from '../../github/labels/factory-labels';
import type { NormalizedIssue } from '../../github/read/github-read.types';
import type {
  DesiredIssueState,
  DesiredState,
  ObservedState,
} from '../projection/desired-state.types';
import type { ActionEvidence, ReconcileAction } from './actions.types';

/**
 * Compute the actions that would reconcile observed state to desired state.
 *
 * ## This engine cannot execute anything, by construction
 *
 * It takes data and returns data. There is no injected client, no adapter and
 * no callback — nothing it holds could perform a write even if a future change
 * asked it to. VISION §12 gates Phase 2 on running read-only for a week and
 * says why: *"it surfaces every wrong assumption about state transitions
 * before anything can write to a repository."* That only works if a complete,
 * reviewable action list can be produced by something with no capability to
 * act on it.
 *
 * ## Actions are data, not closures
 *
 * A closure can be executed but not reviewed, and review IS the deliverable of
 * the observation week. Returning plain objects means the same list can be
 * logged, diffed across ticks to spot flapping, and handed unchanged to the
 * executor that arrives in Phase 4.
 *
 * ## Deterministic ordering
 *
 * Actions come out in a fixed order — issues ascending, and within an issue a
 * fixed action order. Identical inputs must produce an identical list, or
 * diffing two ticks to find what changed becomes impossible and the log stops
 * being reviewable.
 */
export function computeActions(
  observed: ObservedState,
  desired: DesiredState,
): ReconcileAction[] {
  const issuesByNumber = new Map(
    observed.issues.map((issue) => [issue.number, issue]),
  );

  return [...desired.issues]
    .sort((a, b) => a.issueNumber - b.issueNumber)
    .flatMap((state) => {
      const issue = issuesByNumber.get(state.issueNumber);
      // A projected issue with no observed issue cannot happen — the
      // projection is built FROM the observation — but returning nothing is
      // safer than asserting inside a function whose whole value is that it
      // never throws during the observation week.
      return issue
        ? actionsForIssue(desired.repository, issue, state, observed)
        : [];
    });
}

function actionsForIssue(
  repository: string,
  issue: NormalizedIssue,
  desired: DesiredIssueState,
  observed: ObservedState,
): ReconcileAction[] {
  const workOrder = observed.workOrders
    .filter(
      (w) =>
        w.issueNumber === issue.number &&
        w.status !== 'superseded' &&
        w.status !== 'cancelled',
    )
    .sort((a, b) => b.attempt - a.attempt)[0];

  const evidence: ActionEvidence = {
    intent: desired.intent,
    inputLabels: [...desired.inputLabels],
    workOrderIdentity: workOrder?.identity ?? null,
    runStatus: workOrder?.run?.status ?? null,
    currentMirrorLabels: [...issue.observedMirrorLabels].sort(),
    desiredMirrorLabels: [...desired.desiredMirrorLabels].sort(),
  };

  const actions: ReconcileAction[] = [];
  const base = { repository, issueNumber: issue.number, evidence };

  // 1. The intent-bearing action, if the intent calls for one.
  switch (desired.intent) {
    case 'dispatch':
      actions.push({
        ...base,
        type:
          workOrder?.status === 'quarantined'
            ? 'release-quarantine'
            : 'dispatch',
        reason: desired.reason,
      });
      break;
    case 'quarantined':
      // Only when it is not ALREADY quarantined: re-quarantining every tick
      // would fill the log with a decision that was made once, and #50 has to
      // stay legible enough to review a week of.
      if (workOrder?.status !== 'quarantined') {
        actions.push({ ...base, type: 'quarantine', reason: desired.reason });
      }
      break;
    case 'hold':
      actions.push({ ...base, type: 'hold', reason: desired.reason });
      break;
    case 'running':
    case 'blocked':
    case 'review':
    case 'ignore':
      // Steady states. The mirror-label reconciliation below is the only
      // thing these produce, and an issue in a correct steady state with
      // correct labels produces no action at all — which is what makes a
      // quiet tick genuinely quiet.
      break;
  }

  // 2. Reconcile the mirror labels toward what the projection wants.
  actions.push(...mirrorLabelActions(base, issue, desired));

  return actions;
}

/**
 * Add what is missing, remove what is stale.
 *
 * The removal half is the part that is easy to skip and #48 calls out
 * explicitly: *"A stale mirror label from a previous run is removed, not just
 * added to."* Without it a work order that ran, blocked, then succeeded would
 * accumulate `factory/dispatched`, `factory/blocked` and `factory/review` all
 * at once, and the labels would stop meaning anything.
 *
 * Only labels in `ALL_MIRROR_LABELS` are ever removed. A `factory/` label
 * Opifex does not own — one a human invented — is left alone, because
 * deleting a label because we do not recognise it is the kind of destructive
 * surprise that makes an operator switch the whole thing off.
 */
function mirrorLabelActions(
  base: { repository: string; issueNumber: number; evidence: ActionEvidence },
  issue: NormalizedIssue,
  desired: DesiredIssueState,
): ReconcileAction[] {
  const current = new Set(issue.observedMirrorLabels);
  const wanted = new Set(desired.desiredMirrorLabels);
  const actions: ReconcileAction[] = [];

  // Sorted so the action list is stable across ticks.
  for (const label of [...wanted].sort()) {
    if (!current.has(label)) {
      actions.push({
        ...base,
        type: 'add-mirror-label',
        label,
        reason: `add ${label}: the issue is ${desired.intent} and the label is not present`,
      });
    }
  }

  for (const label of [...current].sort()) {
    if (wanted.has(label)) continue;
    if (!(ALL_MIRROR_LABELS as readonly string[]).includes(label)) continue;

    actions.push({
      ...base,
      type: 'remove-mirror-label',
      label,
      reason: `remove ${label}: stale, the issue is now ${desired.intent}`,
    });
  }

  return actions;
}
