import {
  RUN_EVENT_SCHEMA_VERSION,
  type RunEventPayload,
} from '../run-events/run-event.types';
import type { GitLivenessResult, GitObservation } from './git-liveness.types';

/**
 * Derive liveness from git alone.
 *
 * ## Why this exists before the streaming path
 *
 * VISION §9 gives an unusual instruction and its reason in one breath:
 *
 * > **Build the git watcher first, even though the v1 runner does not need
 * > it.** Running both in parallel is the only real test that the runner
 * > abstraction holds. Building only the streaming path guarantees
 * > discovering, six months later, that the seam was fictional.
 *
 * The v1 runner streams richly, so nothing here is needed for it to work.
 * That is exactly the point: this path is what proves a runner with no event
 * stream at all is still supervisable, and it can only prove that if it is
 * built while the alternative is not yet available to lean on.
 *
 * ## Pure, like the projection
 *
 * No I/O. The caller gathers the observation and hands it in, so this is
 * deterministic and testable against fixtures.
 *
 * ## Every event is tagged `git-derived`, never `runner-reported`
 *
 * These are INFERENCES. A commit landing means someone committed; it does not
 * mean the runner said it made progress. VISION §9 forbids the masquerade, and
 * #54 depends on the distinction to apply the right threshold — a git-derived
 * signal arrives on a poll interval, so judging it on the seconds-scale
 * threshold a streaming runner earns would kill healthy runs constantly.
 */
export function deriveGitLiveness(
  observation: GitObservation,
): GitLivenessResult {
  const { run } = observation;
  const events: RunEventPayload[] = [];

  // Commits AFTER the pinned base. A branch sitting at base has produced
  // nothing, and counting the base commit as progress would report every
  // freshly-created branch as alive.
  const progressCommits = observation.commits.filter(
    (commit) => !isSameCommit(commit.sha, run.baseCommit),
  );

  for (const commit of progressCommits) {
    // Skipped once already seen. Without this the watcher re-emits the same
    // commit every tick and a stalled run looks permanently alive — the exact
    // failure mode #54 exists to catch, introduced by its own liveness source.
    if (
      run.lastKnownHeadCommit &&
      isAtOrBefore(commit.sha, run.lastKnownHeadCommit, observation.commits)
    ) {
      continue;
    }

    events.push({
      schemaVersion: RUN_EVENT_SCHEMA_VERSION,
      // Deterministic, so a re-observation of the same commit produces the
      // same id and ingestion deduplicates it rather than storing it twice.
      eventId: `git:${run.repository.owner}/${run.repository.name}:commit:${commit.sha}`,
      runId: run.runId,
      workOrderId: run.workOrderIdentity,
      type: 'run.progress',
      source: 'git-derived',
      occurredAt: commit.authoredAt.toISOString(),
      summary: `Commit ${commit.sha.slice(0, 7)} landed on ${run.branch}: ${firstLine(commit.message)}`,
    });
  }

  // A pull request is the run's output, so its appearance is completion in the
  // only sense git can see. Emitted once — `pullRequestUrl` already being
  // known means a previous tick emitted it.
  const pr = observation.pullRequest;
  if (pr && !run.pullRequestUrl) {
    events.push({
      schemaVersion: RUN_EVENT_SCHEMA_VERSION,
      eventId: `git:${run.repository.owner}/${run.repository.name}:pr:${pr.number}:opened`,
      runId: run.runId,
      workOrderId: run.workOrderIdentity,
      type: 'run.completed',
      source: 'git-derived',
      occurredAt: pr.updatedAt.toISOString(),
      summary: `Pull request #${pr.number} opened from ${run.branch}`,
      result: {
        branch: run.branch,
        headCommit: pr.headSha,
        pullRequestUrl: pr.url,
      },
    });
  }

  return {
    runId: run.runId,
    events,
    lastActivityAt: latestActivity(observation),
    summary: describe(observation, progressCommits.length, events.length),
  };
}

/**
 * The most recent moment git shows any activity.
 *
 * CI counts. A long test suite running on the head commit is evidence the run
 * produced something worth testing, and treating a repository whose CI is
 * mid-flight as silent would kill runs during their slowest legitimate phase.
 *
 * Returns null when git shows nothing at all — which is NOT the same as
 * "alive", and #54 must not treat it as such.
 */
function latestActivity(observation: GitObservation): Date | null {
  const moments: Date[] = [];

  for (const commit of observation.commits) {
    if (!isSameCommit(commit.sha, observation.run.baseCommit)) {
      moments.push(commit.authoredAt);
    }
  }
  if (observation.pullRequest) {
    moments.push(observation.pullRequest.updatedAt);
  }
  for (const check of observation.checks) {
    // An in-flight check has no completion time but is itself activity, so it
    // counts as of now rather than not counting at all.
    moments.push(check.completedAt ?? new Date());
  }

  if (moments.length === 0) return null;
  return moments.reduce((latest, m) => (m > latest ? m : latest));
}

function describe(
  observation: GitObservation,
  progressCommits: number,
  emitted: number,
): string {
  if (progressCommits === 0 && !observation.pullRequest) {
    return `no git activity on ${observation.run.branch} since it was created`;
  }
  const parts = [`${progressCommits} commit(s) past base`];
  if (observation.pullRequest) {
    parts.push(`pull request #${observation.pullRequest.number}`);
  }
  if (observation.checks.length > 0) {
    parts.push(`${observation.checks.length} check(s)`);
  }
  return `${parts.join(', ')}; ${emitted} new event(s)`;
}

function firstLine(message: string): string {
  return message.split('\n')[0].slice(0, 120);
}

/**
 * GitHub returns full 40-character SHAs; a work order's identity carries a
 * 7-character prefix. Comparing them naively would make a branch at base look
 * like a branch that had moved.
 */
function isSameCommit(a: string, b: string): boolean {
  const shortest = Math.min(a.length, b.length);
  return shortest >= 7 && a.slice(0, shortest) === b.slice(0, shortest);
}

/**
 * Whether `sha` is the last-known head or older than it.
 *
 * Uses the commit list's own order — GitHub returns newest first — rather than
 * timestamps. Commit dates can be rewritten, duplicated across a rebase, or
 * simply wrong; the list order is what the repository actually reports.
 */
function isAtOrBefore(
  sha: string,
  lastKnownHead: string,
  newestFirst: { sha: string }[],
): boolean {
  const index = newestFirst.findIndex((c) => isSameCommit(c.sha, sha));
  const headIndex = newestFirst.findIndex((c) =>
    isSameCommit(c.sha, lastKnownHead),
  );

  // A last-known head that is no longer in the list means the branch was
  // rewritten. Treat every commit as new: re-emitting is recoverable, while
  // skipping means the run looks silent until the next commit.
  if (headIndex === -1) return false;
  return index >= headIndex;
}
