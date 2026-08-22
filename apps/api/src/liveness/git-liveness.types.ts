import type { RunEventPayload } from '../run-events/run-event.types';

/**
 * One work order's git-visible state, as the watcher needs it.
 *
 * Deliberately plain data with no Prisma types, for the same reason the
 * projection is (#46): the derivation below must be a pure function so it can
 * be tested against fixtures, and so #51-style offline tests stay possible.
 */
export interface WatchedRun {
  runId: string;
  workOrderIdentity: string;
  repository: { owner: string; name: string };
  /** `factory/312-a3f91c2-a1`. */
  branch: string;
  /** The pinned base commit. A commit AT base is not progress. */
  baseCommit: string;
  /** When the run started, for the case where nothing has happened at all. */
  startedAt: Date;
  /** The head commit Opifex last saw, or null if it has seen none. */
  lastKnownHeadCommit: string | null;
  /** Whether Opifex already knows a pull request exists. */
  pullRequestUrl: string | null;
}

/** What git says happened, gathered by the watcher before deriving anything. */
export interface GitObservation {
  run: WatchedRun;
  /** Commits on the run's branch, newest first. Empty if the branch is bare. */
  commits: {
    sha: string;
    message: string;
    authoredAt: Date;
  }[];
  /** The pull request from this branch, if one is open or merged. */
  pullRequest: {
    number: number;
    url: string;
    state: 'open' | 'closed';
    merged: boolean;
    headSha: string;
    updatedAt: Date;
  } | null;
  /** CI verdicts on the head commit, from both of GitHub's systems (#41). */
  checks: {
    name: string;
    status: 'queued' | 'in_progress' | 'completed';
    conclusion: string | null;
    completedAt: Date | null;
  }[];
}

/**
 * What the watcher concluded, alongside the events it will emit.
 *
 * `signals` is separate from `events` because not every observation is worth
 * an event — a branch that has not moved since the last tick is a real
 * observation and emitting a `run.progress` for it would be a lie.
 */
export interface GitLivenessResult {
  runId: string;
  /** Events to persist, all tagged `git-derived`. */
  events: RunEventPayload[];
  /**
   * The most recent moment git shows ANY activity for this run, or null when
   * git shows none at all.
   *
   * This is the number #54's silent detection uses for a runner that streams
   * nothing. Null is a real answer and means "no git evidence of life", not
   * "alive" — a distinction #54 has to preserve.
   */
  lastActivityAt: Date | null;
  /** One line, for the tick log. */
  summary: string;
}
