import { Injectable, Logger } from '@nestjs/common';

import { GitHubReadService } from '../github/read/github-read.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Records what became of each run's pull request (#215).
 *
 * ## Why this exists
 *
 * Two of VISION §10's six metrics were `NOT_MEASURED` for one reason —
 * `metrics.service.ts` said plainly that "merge state is not tracked anywhere".
 * One of them, first-pass acceptance, is the metric VISION §10 says decides the
 * roadmap: *"if first-pass acceptance is low, adding throughput actively makes
 * life worse."* A metric that decides whether to scale or stop cannot stay
 * unmeasured when nothing external is blocking it.
 *
 * ## Merged, closed and open are three facts
 *
 * A pull request closed WITHOUT merging is not one awaiting review. Folding
 * those together would make first-pass acceptance look better than it is, which
 * is the one direction a roadmap metric must not be wrong in.
 *
 * ## A sweep, in the shape of the run-summary sweep
 *
 * Off the hot path, idempotent, and retrying for free: a run whose PR read
 * failed keeps its null and is asked again next pass. The query IS the null.
 */
@Injectable()
export class MergeStateService {
  private readonly logger = new Logger(MergeStateService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly github: GitHubReadService,
  ) {}

  /**
   * Settle every run whose pull request has reached a terminal state.
   *
   * Bounded per pass: a backlog drains over several sweeps rather than spending
   * the whole GitHub budget in one, and VISION §11's shared quota means an idle
   * control plane must cost close to nothing.
   */
  async settleOpen(
    limit = 25,
  ): Promise<{ settled: number; stillOpen: number }> {
    const candidates = await this.prisma.run.findMany({
      where: {
        pullRequestNumber: { not: null },
        // Null is "open, or never read". Both want asking again; a settled run
        // never does, which is what makes this idempotent.
        pullRequestState: null,
      },
      orderBy: { startedAt: 'asc' },
      take: limit,
      select: {
        id: true,
        pullRequestNumber: true,
        workOrder: {
          select: { repository: { select: { owner: true, name: true } } },
        },
      },
    });

    let settled = 0;
    let stillOpen = 0;

    for (const run of candidates) {
      try {
        const pull = await this.github.getPullRequest(
          {
            owner: run.workOrder.repository.owner,
            name: run.workOrder.repository.name,
          },
          run.pullRequestNumber!,
        );

        if (pull.state !== 'closed') {
          // Still open. Left null deliberately so the next sweep asks again —
          // recording "open" would need a third enum value that only ever means
          // "ask me later", which the null already says.
          stillOpen += 1;
          continue;
        }

        await this.prisma.run.update({
          where: { id: run.id },
          data: {
            pullRequestState: pull.merged ? 'merged' : 'closed',
            // Only when merged. GitHub reports a merged PR as closed, so
            // `merged` is the discriminator and `mergedAt` follows it.
            pullRequestMergedAt: pull.merged ? pull.mergedAt : null,
          },
        });
        settled += 1;
      } catch (error) {
        // One run's read failing must not stop the sweep, and the row keeps its
        // null so the next pass retries.
        this.logger.warn(
          `Could not read the pull request for run ${run.id}; it stays unsettled: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (settled > 0) {
      this.logger.log(
        `Merge state: ${settled} settled, ${stillOpen} still open`,
      );
    }
    return { settled, stillOpen };
  }
}
