import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { GitHubWriteService } from '../github/write/github-write.service';
import { PrismaService } from '../prisma/prisma.service';
import { DecisionLogService } from '../supervisor/decision-log/decision-log.service';
import { composeRunSummary, type RunSummaryFacts } from './run-summary';

/**
 * Posts the VISION §5 run summary for every concluded run (#67).
 *
 * ## A sweep, not a hook on ingestion
 *
 * Ingestion is the hot path a runner POSTs into. Doing a GitHub write inside it
 * would put network latency and a second failure mode in front of the event
 * stream, and a post that failed there would simply be lost — while #67 asks
 * that "every completed run posts exactly one summary".
 *
 * A sweep over `summaryPostedAt IS NULL` is idempotent by construction and
 * retries for free: a run whose post failed is still owed one on the next pass.
 * That is the same shape the reconciler uses, for the same reason.
 *
 * ## Pull request, falling back to the issue
 *
 * #67 is explicit that "a run that fails before producing a PR still records
 * its summary as a comment on its issue — the same content, falling back to the
 * issue when no PR exists". A run that died before opening anything is exactly
 * the run whose story is least reconstructible later, so it is the one that can
 * least afford to have nowhere to put it.
 */
@Injectable()
export class RunSummaryService {
  private readonly logger = new Logger(RunSummaryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly writes: GitHubWriteService,
    private readonly config: ConfigService,
    /**
     * Read-only access to the decision log, for the supervisor's diagnosis
     * (#92).
     *
     * The dependency runs THIS WAY on purpose. The run summary reads what the
     * supervisor proposed; the supervisor cannot reach the run summary, and
     * `SupervisorModule` imports nothing that could post a comment. Reversing
     * it would give a proposal a path to GitHub, which is the whole thing #90
     * makes structurally impossible.
     */
    private readonly decisions: DecisionLogService,
  ) {}

  /**
   * Post everything owed, oldest first.
   *
   * Bounded per pass: a backlog should drain over several sweeps rather than
   * spend the whole GitHub budget in one, and the ordering means the oldest
   * unposted summary is never starved by newer ones.
   */
  async postOwed(limit = 25): Promise<{ posted: number; failed: number }> {
    const owed = await this.prisma.run.findMany({
      where: {
        summaryPostedAt: null,
        // Only concluded runs have a story to tell. A live one would produce a
        // summary that stops mid-sentence and could never be corrected — the
        // comment is a record, not a status board.
        status: { in: ['succeeded', 'failed', 'quarantined'] },
      },
      orderBy: { endedAt: 'asc' },
      take: limit,
      select: {
        id: true,
        status: true,
        startedAt: true,
        endedAt: true,
        costUsd: true,
        tokensInput: true,
        tokensOutput: true,
        attentionReason: true,
        pullRequestNumber: true,
        runnerKey: true,
        runner: { select: { version: true } },
        workOrder: {
          select: {
            identity: true,
            attempt: true,
            issueNumber: true,
            repository: { select: { owner: true, name: true } },
          },
        },
      },
    });

    let posted = 0;
    let failed = 0;

    for (const run of owed) {
      try {
        await this.postOne(run);
        posted += 1;
      } catch (error) {
        // One run's summary failing must not stop the rest. The row keeps its
        // null, so the next sweep tries again.
        failed += 1;
        this.logger.warn(
          `Could not post the run summary for ${run.id}; it stays owed: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (posted > 0 || failed > 0) {
      this.logger.log(`Run summaries: ${posted} posted, ${failed} still owed`);
    }
    return { posted, failed };
  }

  private async postOne(run: OwedRun): Promise<void> {
    const repo = {
      owner: run.workOrder.repository.owner,
      name: run.workOrder.repository.name,
    };

    const facts: RunSummaryFacts = {
      runId: run.id,
      workOrderIdentity: run.workOrder.identity,
      attempt: run.workOrder.attempt,
      retryCeiling: this.config.get<number>('dispatch.retryCeiling') ?? 3,
      runnerKey: run.runnerKey,
      runnerVersion: run.runner.version,
      status: run.status,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      costUsd: run.costUsd === null ? null : Number(run.costUsd),
      tokensInput: run.tokensInput,
      tokensOutput: run.tokensOutput,
      attentionReason: run.attentionReason,
      diagnosis: await this.diagnosisFor(run.id),
    };

    const body = composeRunSummary(facts);

    // The pull request when there is one, the issue when there is not. Both are
    // issue-comment writes to GitHub; only the number differs.
    const target = run.pullRequestNumber ?? run.workOrder.issueNumber;
    const result = await this.writes.postRunSummary(repo, target, body);

    // Stamped even when the write was a no-op because writes are disabled.
    // During the observation week nothing reaches GitHub, and a sweep that
    // retried forever would grow an unbounded backlog and re-log it every pass.
    // The row records that the summary was composed and offered; whether it
    // landed is the write layer's record to keep.
    await this.prisma.run.update({
      where: { id: run.id },
      data: { summaryPostedAt: new Date() },
    });

    this.logger.log(
      `Run summary for ${run.workOrder.identity} ${
        result.performed ? 'posted to' : 'composed for'
      } ${repo.owner}/${repo.name}#${target}`,
    );
  }

  /**
   * The supervisor's latest diagnosis of this run, or null.
   *
   * NEVER throws into the caller. #92: "absent or failed diagnosis leaves the
   * run summary otherwise intact" — a decision log that is unreachable must
   * cost the summary its hypothesis and nothing else, because the deterministic
   * record is the part that matters and it is already complete.
   */
  private async diagnosisFor(
    runId: string,
  ): Promise<RunSummaryFacts['diagnosis']> {
    try {
      const match = await this.decisions.latestProposalFor(
        'run',
        runId,
        'run-diagnosis',
      );
      if (!match) return null;

      return { text: match.reasoning, proposalId: match.id };
    } catch (error) {
      this.logger.warn(
        `Could not read a supervisor diagnosis for ${runId}; the summary goes ` +
          `out without one: ${
            error instanceof Error ? error.message : String(error)
          }`,
      );
      return null;
    }
  }
}

/** The shape `postOwed` selects. Named so `postOne` can be read on its own. */
interface OwedRun {
  id: string;
  /**
   * Prisma's `RunStatus`, not narrowed to the three the query selects.
   *
   * Narrowing here would be a second, weaker statement of what the `where`
   * clause already guarantees, and the two would have to be kept in step by
   * hand. The composer accepts the full union and says something sensible for
   * every member of it.
   */
  status: RunSummaryFacts['status'];
  startedAt: Date;
  endedAt: Date | null;
  costUsd: unknown;
  tokensInput: number | null;
  tokensOutput: number | null;
  attentionReason: string | null;
  pullRequestNumber: number | null;
  runnerKey: string;
  runner: { version: string | null };
  workOrder: {
    identity: string;
    attempt: number;
    issueNumber: number;
    repository: { owner: string; name: string };
  };
}
