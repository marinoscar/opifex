import type { ReconcileAction } from './diff/actions.types';
import type { DesiredState } from './projection/desired-state.types';
import type { RejectedIssue } from '../work-orders/work-order-projection.service';

/**
 * An issue whose spec the generator refused, and where to say so.
 *
 * Carried off the tick rather than acted on inside it, for the same reason
 * actions are: the component that DECIDES an issue is unbuildable must not be
 * the one that comments on it. `ReconcilerTask` is where computing meets
 * acting, and it is the only place that may post.
 */
export interface TickRejection extends RejectedIssue {
  repository: { id: string; owner: string; name: string };
  /** Whether this repository has opted in to receiving spec feedback. */
  feedbackEnabled: boolean;
}

/**
 * The settings one tick computes against, read once before it begins.
 *
 * ## The invariant is the old one; the scope is not
 *
 * `ReconcilerService` used to read these in its CONSTRUCTOR, and the reason it
 * gave was right about what it was protecting: the projection is pure and
 * takes them as inputs, so a value that changed underneath a tick would make
 * two identical observations produce different desired states. That invariant
 * is kept here in full — **one tick's computation must never see two different
 * values for the same key.**
 *
 * What changed is the scope that invariant was given. "At construction" freezes
 * a value for the entire life of the process — every tick from boot to restart,
 * not just one — which is strictly stronger than the argument needs: nothing
 * requires `retryCeiling` to agree between tick 100 and tick 101, only within
 * the computation of tick 100. It is also exactly the promise that makes a
 * value impossible to edit at runtime, since one that can only change at boot
 * cannot be changed without one (ADR-0018 §4, which supersedes the scope and
 * keeps the argument).
 *
 * The shape is the one `DispatchService.decide` already uses for its clock:
 *
 * > The one clock reading on this path. `decideDispatch` is pure and has no
 * > now of its own, so every time comparison the decision depends on happens
 * > here, against this instant, and the policy receives already-settled facts.
 * > — `dispatch.service.ts:83-86`
 */
export interface TickSettings {
  /**
   * Attempts a work order gets before quarantine (#66).
   *
   * `RunSummaryService.postOne` reads the same key, live, on every call. While
   * this was frozen at construction the two could disagree for as long as the
   * process stayed up — the summary rendering "1 of 7" against a ceiling the
   * quarantine logic still held at 3. Reading it per tick bounds that
   * disagreement to one tick interval, which is the whole benefit tick-scoping
   * buys over freezing it at boot.
   */
  retryCeiling: number;
  /** GitHub budget held back for the operator's own use (VISION §11, #40). */
  rateLimitReserve: number;
  /**
   * Whether GitHub writes were permitted for the window this tick ran in.
   *
   * Recorded, never READ by the tick: this service cannot write, which is the
   * property VISION §12's observation week rests on. It is on the record
   * because the record IS that week's deliverable rather than a debugging aid,
   * and a tick that cannot state the mode it ran under produces evidence that
   * has to be corroborated from somewhere else — a container log, a `.env`
   * file as it stood at the time — to mean anything. With it, `actionsExecuted:
   * 0` next to `writesEnabled: false` is a self-contained statement; without
   * it, the zero could as easily mean the switch was on and there was nothing
   * to do.
   */
  writesEnabled: boolean;
}

/**
 * What one tick did, recorded whether or not it found anything to do.
 *
 * #45 requires duration and outcome be recorded so tick latency is measurable —
 * VISION §13 says to add webhooks only when tick latency *demonstrably* hurts,
 * and "demonstrably" needs a number. #50 persists these; this is the shape.
 */
export interface TickRecord {
  /**
   * The id of the log row this tick was written to, once it has been written.
   *
   * Stamped on by `ReconcilerService` after `ReconcileLogService.record`, so
   * that `ReconcilerTask` can go back and record what the tick ACTUALLY
   * executed — a number that does not exist yet when the row is created,
   * because the executors have not run (#317). Undefined when the row could
   * not be written at all; the log service swallows that failure on purpose.
   */
  id?: string;
  startedAt: Date;
  finishedAt: Date;
  durationMs: number;
  outcome: TickOutcome;
  /** Repositories observed this tick. */
  repositoriesObserved: number;
  /** Repositories that failed to observe, with the reason. */
  failures: TickFailure[];
  /**
   * True when every GitHub read this tick was answered from the ETag cache —
   * the tick cost no rate-limit budget at all. Worth recording because it is
   * the number that says whether polling is affordable (#40).
   */
  allFromCache: boolean;
  /** Rate-limit budget remaining when the tick finished, if known. */
  rateLimitRemaining: number | null;
  /**
   * The settings this tick computed against, read once before it began.
   *
   * Part of the record and not of the service, so that reviewing a tick answers
   * "what was it configured to do" from the tick itself. See {@link
   * TickSettings} for why the unit of coherence is one tick.
   */
  settings: TickSettings;
  /**
   * What the tick computed SHOULD be true, one entry per repository observed.
   *
   * Carried on the record because it is the deliverable of VISION §12's
   * observation week, not a debugging aid: reviewing what the reconciler
   * concluded, before it could act on any of it, is the whole point of the
   * week. #50 persists these.
   */
  projections: DesiredState[];
  /**
   * Work orders this tick created, across every repository.
   *
   * A count rather than the documents: the rows are the record, and copying
   * them onto the tick log would duplicate an authorization document into a
   * second place it could drift from.
   */
  workOrdersCreated: number;
  /**
   * Issues whose spec was rejected, for the task to report once each.
   *
   * VISION §10 makes spec quality the throughput ceiling — *the factory cannot
   * be better than what it is told to build* — so a rejection is a message to
   * a human, not a log line, and it has to survive the tick to become one.
   */
  rejections: TickRejection[];
  /**
   * What the tick decided to do — and, during the observation week, did NOT do.
   *
   * VISION §12: "Every tick records what it observed, what it computed, and
   * what it would have done." This is the third of those, and reviewing it is
   * how the week's exit criterion is met.
   */
  actions: ReconcileAction[];
}

export type TickOutcome =
  /** Ran to completion. */
  | 'completed'
  /** Another tick held the lease. Expected, not a fault. */
  | 'skipped-locked'
  /** The reconciler is switched off. */
  | 'skipped-disabled'
  /**
   * Stopped early because the GitHub budget ran out.
   *
   * A distinct outcome rather than a failure: the tick behaved correctly, and
   * conflating it with an error would make a healthy rate-limited system look
   * broken in the log the observation week is reviewed from.
   */
  | 'skipped-rate-limited'
  /** At least one repository failed to observe. */
  | 'partial'
  /** The tick itself threw. */
  | 'failed';

export interface TickFailure {
  repository: string;
  reason: string;
}

/**
 * One thing that went wrong in the ACTING phase, normalized (#320).
 *
 * Distinct from {@link TickFailure} above, which is observation-only: a
 * repository that could not be READ. This is a repository that was written to,
 * or should have been, and something came back wrong.
 *
 * The two executors that produce these return different shapes —
 * `MirrorLabelExecutor` carries the whole `ReconcileAction`, `SpecFeedbackExecutor`
 * carries a repository and an issue number and no action at all — so this is
 * the intersection: what BOTH can actually supply, which is also the minimum
 * #47 asks of evidence. Which action, which target, what error, answerable
 * from the tick row without opening a container log.
 *
 * Persisted on `reconcile_ticks.execution_failures`, where the null/`[]`
 * distinction lives: null means no acting-phase executor ran at all this tick,
 * `[]` means one ran and reported nothing wrong. Read the doc comment on the
 * Prisma model before changing either.
 */
export interface TickExecutionFailure {
  /** Which executor reported it. */
  source: 'mirror-label' | 'spec-feedback';
  /**
   * What was being attempted.
   *
   * The `ReconcileAction['type']` for a mirror-label failure. Spec feedback
   * acts on a REJECTION rather than on a computed action, so it reports the
   * synthetic `post-spec-feedback` — a reader needs to know what was tried,
   * and leaving the field empty for half the entries would cost more than
   * naming an operation that has no action type behind it.
   */
  actionType: string;
  /** `owner/name`, the same format both executors already use. */
  repository: string;
  issueNumber: number;
  /**
   * Why it failed, as the executor saw it.
   *
   * NOT always a GitHub error. `MirrorLabelExecutor` reports `label action
   * carried no label` here — a diff-engine bug it cannot distinguish from a
   * refused write from where it stands. Read this before concluding GitHub
   * said no.
   */
  reason: string;
}
