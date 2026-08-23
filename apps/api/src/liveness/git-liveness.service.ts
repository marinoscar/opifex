import { Injectable, Logger } from '@nestjs/common';

import { GitHubReadService } from '../github/read/github-read.service';
import { PrismaService } from '../prisma/prisma.service';
import { FactoryMetrics } from '../telemetry/factory-metrics.service';
import {
  toPrismaEventSource,
  toPrismaEventType,
  type RunEventPayload,
} from '../run-events/run-event.types';
import { deriveGitLiveness } from './git-liveness';
import type { GitObservation, WatchedRun } from './git-liveness.types';

export interface LivenessSweepResult {
  runsWatched: number;
  eventsRecorded: number;
  /** Events derived but already known — the idempotency path working. */
  eventsAlreadyKnown: number;
  disagreements: LivenessDisagreement[];
  failures: { run: string; reason: string }[];
}

/**
 * A run where git and the runner tell different stories.
 *
 * #52 requires these be "visible rather than silently reconciled", and that is
 * the whole reason the git watcher exists before the streaming path: if the
 * two sources never disagreed, one of them would be redundant. A disagreement
 * is evidence about the runner seam — the thing VISION §9 says building only
 * the streaming path would leave untested for six months.
 *
 * Nothing here decides who is right. #54 does that, using the runner's
 * declared capabilities.
 */
export interface LivenessDisagreement {
  runId: string;
  workOrderIdentity: string;
  kind:
    /** Git shows commits; the runner has reported nothing for far longer. */
    | 'git-ahead-of-runner'
    /** The runner reports progress; git shows nothing on the branch at all. */
    | 'runner-ahead-of-git'
    /** Git shows a pull request; the runner never said it completed. */
    | 'git-completed-runner-silent';
  detail: string;
}

/**
 * Derives liveness from git for every live run, and records what it finds.
 *
 * VISION §9 calls this one of two *independent* liveness sources. Independence
 * is the property that matters: it works for every coding agent that exists or
 * will exist, including one that streams nothing, which is why #52 insists it
 * be built and merged before the streaming ingestion path in #53.
 */
@Injectable()
export class GitLivenessService {
  private readonly logger = new Logger(GitLivenessService.name);

  /**
   * How far a runner's own reporting may lag git before it is worth noticing.
   *
   * Not a failure threshold — #54 owns those. This is only about when a
   * divergence is interesting enough to record.
   */
  private static readonly DISAGREEMENT_LAG_MS = 15 * 60_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly github: GitHubReadService,
    private readonly metrics: FactoryMetrics,
  ) {}

  async sweep(): Promise<LivenessSweepResult> {
    const runs = await this.loadWatchedRuns();
    const result: LivenessSweepResult = {
      runsWatched: runs.length,
      eventsRecorded: 0,
      eventsAlreadyKnown: 0,
      disagreements: [],
      failures: [],
    };

    for (const run of runs) {
      try {
        const observation = await this.observe(run.watched);
        const derived = deriveGitLiveness(observation);

        for (const event of derived.events) {
          const isNew = await this.record(event, run.watched.workOrderIdentity);
          if (isNew) {
            result.eventsRecorded += 1;
          } else {
            result.eventsAlreadyKnown += 1;
          }
        }

        await this.updateRun(
          run.watched.runId,
          derived.lastActivityAt,
          observation,
        );

        const disagreement = this.compare(
          run,
          derived.lastActivityAt,
          observation,
        );
        if (disagreement) result.disagreements.push(disagreement);
      } catch (error) {
        result.failures.push({
          run: run.watched.workOrderIdentity,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (result.disagreements.length > 0) {
      // Logged rather than reconciled. See `LivenessDisagreement`.
      for (const d of result.disagreements) {
        this.logger.warn(
          `Liveness disagreement on ${d.workOrderIdentity} (${d.kind}): ${d.detail}`,
        );
      }
    }

    return result;
  }

  /**
   * Gather what git says. The only I/O in this file's derivation path.
   *
   * Three reads per run, which is why this sweeps only LIVE runs — a finished
   * run's branch cannot tell us anything we still need.
   */
  private async observe(run: WatchedRun): Promise<GitObservation> {
    const repo = run.repository;

    const commits = await this.github.listCommits(repo, {
      branch: run.branch,
      maxPages: 2,
    });
    const pulls = await this.github.listPullRequests(repo, {
      state: 'all',
      head: `${repo.owner}:${run.branch}`,
    });
    const pull = pulls[0] ?? null;

    // Checks only when there is a head to check. Asking about a commit that
    // does not exist spends a request to be told nothing.
    const headSha = pull?.headSha ?? commits[0]?.sha;
    const checks = headSha ? await this.github.listChecks(repo, headSha) : [];

    return {
      run,
      commits: commits.map((c) => ({
        sha: c.sha,
        message: c.message,
        authoredAt: c.authoredAt,
      })),
      pullRequest: pull
        ? {
            number: pull.number,
            url: pull.url,
            state: pull.state,
            merged: pull.merged,
            headSha: pull.headSha,
            updatedAt: pull.updatedAt,
          }
        : null,
      checks: checks.map((c) => ({
        name: c.name,
        status: c.status,
        conclusion: c.conclusion,
        completedAt: c.completedAt,
      })),
    };
  }

  /**
   * Persist one event, or recognise it as already known.
   *
   * Returns true when it was new. The unique constraint on
   * `(runId, externalId)` is what makes this idempotent — the watcher
   * re-derives the same commit event on every tick, and a conflict is the
   * expected outcome rather than an error.
   */
  private async record(
    event: RunEventPayload,
    workOrderIdentity: string,
  ): Promise<boolean> {
    // The same span-per-event treatment runner-reported ingestion gets. Both
    // liveness sources land in the ONE work order trace (VISION §9), which is
    // the point of deriving the trace id from the identity: this runs on a
    // reconciler tick and shares no call stack with the runner's HTTP post.
    const emitted = this.metrics.recordRunEvent({
      workOrderIdentity,
      type: event.type,
      source: event.source,
      occurredAt: new Date(event.occurredAt),
      summary: event.summary ?? null,
    });

    const created = await this.prisma.runEvent.createMany({
      data: [
        {
          runId: event.runId,
          externalId: event.eventId,
          type: toPrismaEventType(event.type) as never,
          source: toPrismaEventSource(event.source) as never,
          occurredAt: new Date(event.occurredAt),
          summary: event.summary ?? '',
          traceId: emitted.traceId,
          spanId: emitted.spanId,
          payload: JSON.parse(JSON.stringify(event)),
        },
      ],
      // The idempotency, expressed where the database can enforce it rather
      // than as a read-then-write that two ticks could interleave.
      skipDuplicates: true,
    });

    return created.count > 0;
  }

  private async updateRun(
    runId: string,
    lastActivityAt: Date | null,
    observation: GitObservation,
  ): Promise<void> {
    const head =
      observation.pullRequest?.headSha ?? observation.commits[0]?.sha ?? null;

    await this.prisma.run.update({
      where: { id: runId },
      data: {
        // Only ever moved FORWARD. Git-derived activity is one of two sources,
        // and letting an older git observation overwrite a newer runner event
        // would make a live run look stale — manufacturing the silence #54 is
        // watching for.
        ...(lastActivityAt &&
        lastActivityAt > (observation.run.startedAt ?? new Date(0))
          ? { lastEventAt: lastActivityAt }
          : {}),
        ...(head ? { headCommit: head } : {}),
        ...(observation.pullRequest && !observation.run.pullRequestUrl
          ? {
              pullRequestUrl: observation.pullRequest.url,
              pullRequestNumber: observation.pullRequest.number,
            }
          : {}),
      },
    });
  }

  /**
   * Notice when the two sources disagree. Never reconcile them.
   */
  private compare(
    run: { watched: WatchedRun; lastRunnerEventAt: Date | null },
    gitActivityAt: Date | null,
    observation: GitObservation,
  ): LivenessDisagreement | null {
    const base = {
      runId: run.watched.runId,
      workOrderIdentity: run.watched.workOrderIdentity,
    };

    if (observation.pullRequest && !run.lastRunnerEventAt) {
      return {
        ...base,
        kind: 'git-completed-runner-silent',
        detail:
          `pull request #${observation.pullRequest.number} exists but the runner has reported ` +
          `nothing at all`,
      };
    }

    if (gitActivityAt && run.lastRunnerEventAt) {
      const lag = gitActivityAt.getTime() - run.lastRunnerEventAt.getTime();
      if (lag > GitLivenessService.DISAGREEMENT_LAG_MS) {
        return {
          ...base,
          kind: 'git-ahead-of-runner',
          detail:
            `git shows activity at ${gitActivityAt.toISOString()} but the runner last reported ` +
            `at ${run.lastRunnerEventAt.toISOString()} (${Math.round(lag / 60_000)} minutes behind)`,
        };
      }
    }

    if (!gitActivityAt && run.lastRunnerEventAt) {
      const age = Date.now() - run.lastRunnerEventAt.getTime();
      if (age < GitLivenessService.DISAGREEMENT_LAG_MS) {
        return {
          ...base,
          kind: 'runner-ahead-of-git',
          detail:
            `the runner reported at ${run.lastRunnerEventAt.toISOString()} but ${run.watched.branch} ` +
            `has no commits past base`,
        };
      }
    }

    return null;
  }

  /**
   * Live runs only, with what is needed to watch them.
   *
   * `stalled` is included: it has not been killed yet, and a commit landing is
   * exactly the evidence that would show the watchdog was wrong about it.
   */
  private async loadWatchedRuns(): Promise<
    { watched: WatchedRun; lastRunnerEventAt: Date | null }[]
  > {
    const runs = await this.prisma.run.findMany({
      where: { status: { in: ['running', 'stalled', 'blocked'] } },
      select: {
        id: true,
        startedAt: true,
        headCommit: true,
        pullRequestUrl: true,
        workOrder: {
          select: {
            identity: true,
            branch: true,
            baseCommit: true,
            repository: { select: { owner: true, name: true } },
          },
        },
        events: {
          // The newest RUNNER-reported event, for the disagreement check. Git
          // events are excluded deliberately: comparing git against itself
          // would report no disagreement no matter what the runner did.
          where: { source: 'runner' },
          orderBy: { occurredAt: 'desc' },
          take: 1,
          select: { occurredAt: true },
        },
      },
    });

    return runs.map((run) => ({
      watched: {
        runId: run.id,
        workOrderIdentity: run.workOrder.identity,
        repository: run.workOrder.repository,
        branch: run.workOrder.branch,
        baseCommit: run.workOrder.baseCommit,
        startedAt: run.startedAt,
        lastKnownHeadCommit: run.headCommit,
        pullRequestUrl: run.pullRequestUrl,
      },
      lastRunnerEventAt: run.events[0]?.occurredAt ?? null,
    }));
  }
}
