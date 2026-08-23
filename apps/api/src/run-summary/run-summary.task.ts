import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { RunSummaryService } from './run-summary.service';

/**
 * Drives the run-summary sweep (#67).
 *
 * Every minute rather than daily, unlike the cleanup tasks it copies its shape
 * from: a summary is the record a human reads when they come to look at what
 * happened, and one that arrives tomorrow has missed the moment the pull
 * request was opened. The sweep is cheap when there is nothing owed — one
 * indexed query returning no rows.
 *
 * Never throws. A summary that could not be posted stays owed, and the next
 * pass tries again; a task that threw would take the scheduler's other work
 * with it for the sake of a comment.
 */
@Injectable()
export class RunSummaryTask {
  private readonly logger = new Logger(RunSummaryTask.name);

  constructor(private readonly summaries: RunSummaryService) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async handleSweep(): Promise<void> {
    try {
      await this.summaries.postOwed();
    } catch (error) {
      this.logger.error(
        `Run-summary sweep failed; summaries stay owed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
