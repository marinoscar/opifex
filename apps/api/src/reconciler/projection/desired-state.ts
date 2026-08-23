import {
  INPUT_LABELS,
  MIRROR_LABELS,
  isMirrorLabel,
} from '../../github/labels/factory-labels';
import type { NormalizedIssue } from '../../github/read/github-read.types';
import type {
  DesiredIssueState,
  DesiredState,
  ObservedState,
  ObservedWorkOrder,
} from './desired-state.types';

/**
 * Compute what should be true, from scratch.
 *
 * ## This function performs no I/O, and that is a requirement
 *
 * #46 is explicit that pure is "the requirement, not a style preference — it
 * is what makes the diff engine testable and what lets the observation week
 * validate the logic without any side effects existing." Everything it needs
 * was gathered by the tick beforehand and handed in as `ObservedState`.
 *
 * ## It never consults the previous tick
 *
 * A reconciler is defined by answering "what should be true right now?"
 * independently of what it last did. VISION §4: a pure queue "drifts the
 * moment a human intervenes and never recovers", while a reconciler treats
 * manual intervention as a first-class input. Caching any part of this — even
 * as an optimization — reintroduces exactly that drift through the back door.
 *
 * ## Precedence
 *
 * Evaluated in a fixed order, and the order is the design:
 *
 *   1. `factory:hold`     — the emergency brake. Unconditional.
 *   2. quarantine         — only a human clears it (VISION §8).
 *   3. live run state     — running / blocked / review.
 *   4. `factory:ready`    — authorizes a dispatch.
 *   5. otherwise          — ignore.
 *
 * Hold is first because VISION §4 promises "Put `factory:hold` on an issue and
 * it stops." A brake that is checked after anything else is a brake with
 * conditions, and an operator cannot rely on it.
 */
export function projectDesiredState(observed: ObservedState): DesiredState {
  const byIssue = groupWorkOrdersByIssue(observed.workOrders);

  return {
    repository: `${observed.repository.owner}/${observed.repository.name}`,
    issues: observed.issues.map((issue) =>
      projectIssue(issue, byIssue.get(issue.number) ?? null, observed),
    ),
  };
}

function projectIssue(
  issue: NormalizedIssue,
  workOrder: ObservedWorkOrder | null,
  observed: ObservedState,
): DesiredIssueState {
  const inputLabels = issue.inputLabels;
  const held = inputLabels.includes(INPUT_LABELS.HOLD);
  const ready = inputLabels.includes(INPUT_LABELS.READY);

  const base = { issueNumber: issue.number, inputLabels };

  // 1. HOLD — unconditional, checked before anything else.
  if (held) {
    return {
      ...base,
      intent: 'hold',
      reason: `held: a human applied ${INPUT_LABELS.HOLD}`,
      desiredMirrorLabels: [],
    };
  }

  // 2. QUARANTINE — VISION §8: it cannot clear its own quarantine.
  if (workOrder?.status === 'quarantined') {
    // The label being PRESENT is not enough. `humanClearedQuarantine` was
    // resolved from the issue timeline during observation precisely because
    // an agent could otherwise apply the label to release itself.
    if (observed.humanClearedQuarantine.has(issue.number)) {
      return {
        ...base,
        intent: 'dispatch',
        reason:
          `dispatch: quarantine on ${workOrder.identity} cleared by a human applying ` +
          `${INPUT_LABELS.CLEAR_QUARANTINE}`,
        desiredMirrorLabels: [MIRROR_LABELS.DISPATCHED],
      };
    }

    const claimed = inputLabels.includes(INPUT_LABELS.CLEAR_QUARANTINE);
    return {
      ...base,
      intent: 'quarantined',
      reason: claimed
        ? `quarantined: ${workOrder.identity} carries ${INPUT_LABELS.CLEAR_QUARANTINE} but no human applied it`
        : `quarantined: ${workOrder.identity} awaits a human`,
      desiredMirrorLabels: [MIRROR_LABELS.QUARANTINE],
    };
  }

  // 3. LIVE RUN STATE — a run in flight is not a dispatch candidate.
  const run = workOrder?.run ?? null;
  if (run) {
    if (run.status === 'running' || run.status === 'stalled') {
      return {
        ...base,
        intent: 'running',
        reason: `running: ${workOrder!.identity} has a live run (${run.status})`,
        desiredMirrorLabels: [MIRROR_LABELS.DISPATCHED],
      };
    }
    if (run.status === 'blocked') {
      return {
        ...base,
        intent: 'blocked',
        reason: `blocked: ${workOrder!.identity} is parked and resumes without a human`,
        desiredMirrorLabels: [MIRROR_LABELS.BLOCKED],
      };
    }
    if (run.status === 'succeeded' && run.pullRequestUrl) {
      return {
        ...base,
        intent: 'review',
        reason: `review: ${workOrder!.identity} opened ${run.pullRequestUrl}`,
        desiredMirrorLabels: [MIRROR_LABELS.REVIEW],
      };
    }
  }

  // 4. READY — the only path to a dispatch.
  if (ready) {
    if (!observed.repository.dispatchEnabled) {
      // Not a hold and not an error: the repository is being observed but has
      // not been released for dispatch yet (VISION §12's per-repository exit
      // from the observation week).
      return {
        ...base,
        intent: 'ignore',
        reason: `ignored: ${INPUT_LABELS.READY} is set but dispatch is disabled for this repository`,
        desiredMirrorLabels: [],
      };
    }

    const spent = totalSpend(workOrder);
    const ceiling = observed.repository.budgetCeilingUsd;
    if (ceiling !== null && spent !== null && spent >= ceiling) {
      return {
        ...base,
        intent: 'quarantined',
        reason: `quarantined: spend ${spent} has reached the repository ceiling ${ceiling}`,
        desiredMirrorLabels: [MIRROR_LABELS.QUARANTINE],
      };
    }

    return {
      ...base,
      intent: 'dispatch',
      reason: workOrder
        ? `dispatch: ${INPUT_LABELS.READY} is set and ${workOrder.identity} has no live run`
        : `dispatch: ${INPUT_LABELS.READY} is set and no work order exists yet`,
      desiredMirrorLabels: [MIRROR_LABELS.DISPATCHED],
    };
  }

  // 5. Nothing asked for this issue.
  return {
    ...base,
    intent: 'ignore',
    reason: `ignored: no ${INPUT_LABELS.READY} label`,
    desiredMirrorLabels: [],
  };
}

/**
 * The newest work order per issue.
 *
 * Newest by attempt, because abandon-and-re-run (VISION §3.4) leaves the
 * earlier attempts in place as `superseded` — counting them is how success
 * metric 4 works, but the CURRENT state of an issue is its latest attempt.
 */
function groupWorkOrdersByIssue(
  workOrders: ObservedWorkOrder[],
): Map<number, ObservedWorkOrder> {
  const byIssue = new Map<number, ObservedWorkOrder>();

  for (const workOrder of workOrders) {
    if (workOrder.status === 'superseded' || workOrder.status === 'cancelled')
      continue;

    const existing = byIssue.get(workOrder.issueNumber);
    if (!existing || workOrder.attempt > existing.attempt) {
      byIssue.set(workOrder.issueNumber, workOrder);
    }
  }

  return byIssue;
}

/**
 * What this work order has spent, or null when the runner reports no cost.
 *
 * Null and zero are different (VISION §6 makes cost reporting a declared
 * capability), so an unknown spend must not read as "nothing spent" and
 * silently pass a budget check.
 */
function totalSpend(workOrder: ObservedWorkOrder | null): number | null {
  return workOrder?.run?.costUsd ?? null;
}

/**
 * Guard for the invariant #48 must not violate.
 *
 * VISION §3.3: mirror labels are written by Opifex and never read as truth.
 * The read adapter already strips them (#41), so this should never fire — it
 * exists so that if a future change routes an unfiltered issue in here, the
 * failure is loud and immediate rather than a feedback loop where the control
 * plane reads its own output as input.
 */
export function assertNoMirrorLabelsObserved(issues: NormalizedIssue[]): void {
  for (const issue of issues) {
    const leaked = issue.labels.filter((label) => isMirrorLabel(label.name));
    if (leaked.length > 0) {
      throw new Error(
        `Mirror labels reached the projection for issue #${issue.number}: ` +
          `${leaked.map((l) => l.name).join(', ')}. VISION §3.3 forbids reading them as truth.`,
      );
    }
  }
}
