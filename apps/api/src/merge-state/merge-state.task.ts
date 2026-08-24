import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { MergeStateService } from './merge-state.service';

/**
 * Drives the merge-state sweep (#215).
 *
 * Every ten minutes, not every minute: a pull request's merge is not a latency
 * question the way a stalled run is, and VISION §11's shared quota means an
 * idle control plane should cost close to nothing. Metric 3 is read over days,
 * so ten minutes of staleness is invisible in it.
 *
 * Never throws. A sweep that failed leaves every row unsettled and the next
 * pass retries; a task that threw would take the scheduler's other work with it.
 */
@Injectable()
export class MergeStateTask {
  private readonly logger = new Logger(MergeStateTask.name);

  constructor(private readonly mergeState: MergeStateService) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async handleSweep(): Promise<void> {
    try {
      await this.mergeState.settleOpen();
    } catch (error) {
      this.logger.error(
        `Merge-state sweep failed; rows stay unsettled: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
