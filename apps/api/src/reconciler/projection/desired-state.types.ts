import type { InputLabel } from '../../github/labels/factory-labels';
import type { NormalizedIssue } from '../../github/read/github-read.types';

/**
 * Everything one tick observed, as plain data.
 *
 * Assembled by the tick BEFORE the projection runs, so the projection itself
 * performs no I/O — which is what makes it deterministic, unit-testable
 * against fixtures, and safe to run during the observation week when nothing
 * may have side effects (#46).
 */
export interface ObservedState {
  repository: ObservedRepository;
  /** Open issues, mirror labels already stripped by the read adapter (#41). */
  issues: NormalizedIssue[];
  /** Opifex's own execution state for this repository. */
  workOrders: ObservedWorkOrder[];
  /**
   * Issue numbers where a HUMAN currently has `factory:clear-quarantine` on.
   *
   * Resolved during observation rather than inside the projection, because
   * answering it needs the issue timeline (#41) — an I/O call the projection
   * is not allowed to make. VISION §8 puts clearing quarantine on the
   * never-trustable list, so "a human applied it" is the load-bearing fact,
   * not "the label is present".
   */
  humanClearedQuarantine: ReadonlySet<number>;
  /**
   * How many attempts a work order gets before quarantine (#66).
   *
   * Handed in rather than read from config here, because the projection
   * performs no I/O and reads no globals — #46 calls that "the requirement,
   * not a style preference". A ceiling read inside would make the function's
   * output depend on ambient state and take the observation week's ability to
   * validate the logic with it.
   */
  retryCeiling: number;
}

export interface ObservedRepository {
  id: string;
  owner: string;
  name: string;
  observeEnabled: boolean;
  dispatchEnabled: boolean;
  budgetCeilingUsd: number | null;
}

/** A work order as the projection needs to see it. */
export interface ObservedWorkOrder {
  id: string;
  identity: string;
  issueNumber: number;
  attempt: number;
  status: WorkOrderStatusLike;
  /** The live run, if one exists. */
  run: ObservedRun | null;
}

export interface ObservedRun {
  id: string;
  status: RunStatusLike;
  /** Cumulative spend, or null when the runner reports no cost at all. */
  costUsd: number | null;
  /** Set once the run has opened a pull request. */
  pullRequestUrl: string | null;
  /**
   * CI's verdict on the pull request's head commit (#107).
   *
   * Resolved during observation, because answering it needs a GitHub read and
   * the projection performs no I/O. Null when the run has no pull request to
   * ask about.
   */
  checks: CheckVerdict | null;
}

/**
 * What CI says, reduced to the only question the gate asks.
 *
 * `pending` covers both "a check is still running" and "no check has reported
 * yet", and those are deliberately the same answer. They are indistinguishable
 * from the checks list alone — a repository with no CI configured and one whose
 * Actions have not started yet both report nothing — and of the two ways to be
 * wrong, surfacing a pull request whose CI had not started is the one #107
 * exists to prevent. The cost of the other is a tick or two of delay, and a
 * reason string in the log saying exactly what is being waited for.
 */
export type CheckVerdict = 'passing' | 'failing' | 'pending';

/**
 * The Prisma enums, restated as string unions.
 *
 * Deliberately NOT imported from `@prisma/client`. The projection is a pure
 * function over plain data, and importing the generated client would make it
 * impossible to build a fixture without a database in scope — exactly the
 * coupling that would stop #51 from exercising whole ticks offline.
 *
 * `desired-state.spec.ts` pins these against the real Prisma enums, so the
 * decoupling cannot silently drift into a lie.
 */
export type WorkOrderStatusLike =
  | 'pending'
  | 'queued'
  | 'held'
  | 'dispatched'
  | 'succeeded'
  | 'failed'
  | 'quarantined'
  | 'superseded'
  | 'cancelled';

export type RunStatusLike =
  'running' | 'succeeded' | 'stalled' | 'blocked' | 'failed' | 'quarantined';

// ---------------------------------------------------------------------------
// The projection
// ---------------------------------------------------------------------------

/**
 * What SHOULD be true for one issue, computed from scratch.
 *
 * "From scratch" is the defining property (#46): the projection never consults
 * what the previous tick decided. That is what separates a reconciler from a
 * queue, and what makes VISION §4's promise true — *you can always fix the
 * factory by editing GitHub* — because a human's edit is simply part of the
 * input on the very next tick, with nothing to reset or replay.
 */
export interface DesiredIssueState {
  issueNumber: number;
  /** What the factory should be doing about this issue. */
  intent: IssueIntent;
  /**
   * Why, naming the specific observed inputs.
   *
   * Carried on the projection and not only on the actions (#47), because an
   * issue whose intent is `ignore` produces NO action — and "why is Opifex
   * doing nothing about #312" is the question the observation week most needs
   * answered.
   */
  reason: string;
  /** Input labels observed on the issue, for the record. */
  inputLabels: InputLabel[];
  /** The mirror labels that should be present, given the intent. */
  desiredMirrorLabels: string[];
}

/**
 * What the factory should be doing about an issue.
 *
 * `ignore` and `hold` are separate on purpose. Both produce no dispatch, but
 * they mean opposite things: `hold` is a human's explicit brake and must be
 * visible as such, while `ignore` means the issue was never a candidate. An
 * operator reviewing the week's log needs to tell "I stopped this" apart from
 * "the factory never wanted it".
 */
export type IssueIntent =
  /** Not a candidate — no `factory:ready`, or already resolved. */
  | 'ignore'
  /** A human applied `factory:hold`. Dominates everything. */
  | 'hold'
  /** Should be dispatched: authorized, no live run, within budget. */
  | 'dispatch'
  /** A run is live; leave it alone. */
  | 'running'
  /** Parked with a reset time; the watchdog resumes it. */
  | 'blocked'
  /** Needs a human; cannot clear itself (VISION §8). */
  | 'quarantined'
  /** Work finished; a pull request is awaiting review. */
  | 'review'
  /**
   * A pull request exists but CI has not gone green on it yet (#107).
   *
   * Deliberately NOT `review`. VISION §10: "a factory producing pull requests
   * faster than they can be reviewed is negative value. Green CI is a hard gate
   * before any PR is surfaced for human review." Review attention is the
   * scarcest thing in the system, and spending it on work whose checks have not
   * passed is spending it on work that is not ready.
   */
  | 'awaiting-checks';

export interface DesiredState {
  repository: string;
  issues: DesiredIssueState[];
}
