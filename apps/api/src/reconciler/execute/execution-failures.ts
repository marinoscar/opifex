import type { TickExecutionFailure } from '../reconciler.types';
import type { ExecutionOutcome } from './mirror-label.executor';
import type { ResumeExecutionOutcome } from './resume.executor';
import type { SpecFeedbackOutcome } from './spec-feedback.executor';

/**
 * Normalization from the acting-phase executors onto one shape (#320).
 *
 * The executors report failures in the shape each has to hand — a whole
 * `ReconcileAction` for mirror labels and for resumes, a bare repository and
 * issue number for spec feedback — and none of them is readable without
 * knowing which executor produced it. The tick row holds one shape instead, so
 * an operator reading the log does not have to.
 *
 * Kept out of both executors on purpose: neither of them knows that a tick
 * log exists, and neither should learn. They report; `ReconcilerTask` is the
 * one component allowed to know where a report goes.
 */

/** Mirror-label failures, one entry each, in the order the executor found them. */
export function fromMirrorLabels(
  outcome: ExecutionOutcome,
): TickExecutionFailure[] {
  return outcome.failures.map((failure) => ({
    source: 'mirror-label' as const,
    actionType: failure.action.type,
    repository: failure.action.repository,
    issueNumber: failure.action.issueNumber,
    reason: failure.reason,
  }));
}

/**
 * Spec-feedback failures.
 *
 * `actionType` is the synthetic `post-spec-feedback`: this executor acts on a
 * rejected issue, which by definition never became a work order and so has no
 * computed action behind it. Naming the operation is more use to a reader than
 * an empty field would be.
 */
export function fromSpecFeedback(
  outcome: SpecFeedbackOutcome,
): TickExecutionFailure[] {
  return outcome.failures.map((failure) => ({
    source: 'spec-feedback' as const,
    actionType: 'post-spec-feedback',
    repository: failure.repository,
    issueNumber: failure.issueNumber,
    reason: failure.reason,
  }));
}

/**
 * Resume failures (#477).
 *
 * Only genuine failures reach here — a resume the spend ceiling, a hold or a
 * repository flag REFUSED is the system working, and recording it as an
 * execution failure would train an operator to ignore this list. What lands
 * here is a resume that killed the run or threw.
 */
export function fromResumes(
  outcome: ResumeExecutionOutcome,
): TickExecutionFailure[] {
  return outcome.failures.map((failure) => ({
    source: 'resume' as const,
    actionType: failure.action.type,
    repository: failure.action.repository,
    issueNumber: failure.action.issueNumber,
    reason: failure.reason,
  }));
}
