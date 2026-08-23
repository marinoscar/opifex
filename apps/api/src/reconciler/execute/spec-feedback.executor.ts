import { Injectable, Logger } from '@nestjs/common';

import { GitHubWriteService } from '../../github/write/github-write.service';
import { PrismaService } from '../../prisma/prisma.service';
import type { TickRejection } from '../reconciler.types';

export interface SpecFeedbackOutcome {
  /** Comments actually posted. */
  posted: number;
  /** Rejections the author has already been told about, unchanged. */
  alreadyTold: number;
  /** Rejections in a repository that has not opted in to feedback. */
  suppressed: number;
  failures: { issueNumber: number; repository: string; reason: string }[];
}

/**
 * Tells an issue author why the factory refused to build their issue.
 *
 * ## Why this exists at all
 *
 * VISION §10: spec quality is the throughput ceiling — *the factory cannot be
 * better than what it is told to build.* An issue whose acceptance criteria
 * are "TBD" or "it works nicely" is the normal case, not an exception, and the
 * only useful response is to tell the person who wrote it. A rejection that
 * goes to a log is a rejection nobody acts on, and the issue sits `factory:
 * ready` forever while the operator wonders why nothing happens.
 *
 * ## Why it is here and not in the projection
 *
 * Same line #48 drew: `ReconcilerService` computes, `ReconcilerTask` acts, and
 * this is on the acting side. The component that DECIDES an issue is
 * unbuildable is structurally incapable of commenting on it.
 *
 * ## Once per issue, not once per tick
 *
 * The reconciler recomputes from scratch every 60 seconds, so the same
 * rejection is recomputed every 60 seconds. A naive version would bury the
 * issue under the feedback meant to help it — #155 names this as the thing to
 * get right rather than discover.
 *
 * The check is a row, not a read of the issue's comments. Reading comments
 * would cost a GitHub request per rejected issue per tick, forever, against
 * the budget VISION §11 reserves for the operator's own interactive use.
 *
 * **Keyed on the body digest**, so an author who reads the feedback, edits the
 * body and gets it wrong again is told again. Keyed on the issue number alone
 * they would be met with silence — the worst possible answer to somebody doing
 * exactly what was asked.
 *
 * ## An ordinary comment, deliberately
 *
 * Posted through `postGeneralComment`, which is `WriteAction.PostComment`:
 * irreversible and gated. It is NOT claimed as pre-authorized record-writing.
 * That carve-out is for the records VISION mandates be posted unattended, and
 * stretching it to cover feedback — however useful — is how a carve-out
 * becomes a loophole. It carries no `<!-- opifex:… -->` marker for the same
 * reason: a marker on an ordinary comment would make it look like a record.
 */
@Injectable()
export class SpecFeedbackExecutor {
  private readonly logger = new Logger(SpecFeedbackExecutor.name);

  constructor(
    private readonly writes: GitHubWriteService,
    private readonly prisma: PrismaService,
  ) {}

  async report(rejections: TickRejection[]): Promise<SpecFeedbackOutcome> {
    const outcome: SpecFeedbackOutcome = {
      posted: 0,
      alreadyTold: 0,
      suppressed: 0,
      failures: [],
    };

    for (const rejection of rejections) {
      const name = `${rejection.repository.owner}/${rejection.repository.name}`;

      if (!rejection.feedbackEnabled) {
        outcome.suppressed += 1;
        this.logger.debug(
          `[spec feedback off] ${name}#${rejection.issueNumber}: ${rejection.message}`,
        );
        continue;
      }

      try {
        const handled = await this.reportOne(rejection);
        if (handled) outcome.posted += 1;
        else outcome.alreadyTold += 1;
      } catch (error) {
        // One issue does not stop the others, and does not fail the tick.
        // A comment that cannot be posted now is posted on a later tick,
        // because the row is only written once the post succeeds.
        outcome.failures.push({
          issueNumber: rejection.issueNumber,
          repository: name,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (outcome.posted > 0 || outcome.failures.length > 0) {
      this.logger.log(
        `Spec feedback: ${outcome.posted} posted, ${outcome.alreadyTold} already told, ` +
          `${outcome.suppressed} suppressed, ${outcome.failures.length} failed`,
      );
    }

    return outcome;
  }

  /** Returns true when a comment was posted, false when it was unnecessary. */
  private async reportOne(rejection: TickRejection): Promise<boolean> {
    const told = await this.prisma.issueSpecRejection.findUnique({
      where: {
        repositoryId_issueNumber: {
          repositoryId: rejection.repository.id,
          issueNumber: rejection.issueNumber,
        },
      },
      select: { bodyDigest: true },
    });

    if (told?.bodyDigest === rejection.bodyDigest) return false;

    const result = await this.writes.postGeneralComment(
      { owner: rejection.repository.owner, name: rejection.repository.name },
      rejection.issueNumber,
      body(rejection),
    );

    // Nothing is recorded when the global kill switch suppressed the write.
    // This table records what was SAID, not what was found — so turning
    // `GITHUB_WRITES_ENABLED` on later delivers the feedback instead of
    // swallowing it on the strength of a tick that never spoke.
    if (!result.performed) return false;

    await this.prisma.issueSpecRejection.upsert({
      where: {
        repositoryId_issueNumber: {
          repositoryId: rejection.repository.id,
          issueNumber: rejection.issueNumber,
        },
      },
      create: {
        repositoryId: rejection.repository.id,
        issueNumber: rejection.issueNumber,
        bodyDigest: rejection.bodyDigest,
        message: rejection.message,
        commentUrl: result.url,
        commentedAt: new Date(),
      },
      update: {
        bodyDigest: rejection.bodyDigest,
        message: rejection.message,
        commentUrl: result.url,
        commentedAt: new Date(),
      },
    });

    return true;
  }
}

/**
 * The comment, as the author reads it.
 *
 * Says what is wrong, what to do, and what happens next — in that order,
 * because an author who reads only the first line should still know whether
 * they need to act. It deliberately does not restate the whole issue back:
 * the problems are the message.
 */
function body(rejection: TickRejection): string {
  return [
    `**This issue is marked \`factory:ready\`, but its spec is not buildable yet.**`,
    '',
    rejection.message,
    '',
    'Nothing has been dispatched and nothing was changed. Edit the issue and the ' +
      'next reconciler pass will pick it up — no label change is needed.',
  ].join('\n');
}
