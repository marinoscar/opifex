import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { OperatorSettingsService } from '../../settings/operator-settings/operator-settings.service';
import { ReconcileLogService } from './reconcile-log.service';

/**
 * Enforces the tick log's retention policy.
 *
 * #50 requires retention "from day one", and the reason is arithmetic: a tick
 * a minute is ~1,440 rows a day and the table has no natural ceiling. A policy
 * added later is a policy applied to a table already too large to prune
 * comfortably.
 *
 * Follows the pattern of the three existing cleanup tasks (`auth/tasks`,
 * `device-auth/tasks`, `storage/tasks`) — a daily `@Cron`, no new
 * infrastructure.
 */
@Injectable()
export class ReconcileLogCleanupTask {
  private readonly logger = new Logger(ReconcileLogCleanupTask.name);

  constructor(
    private readonly settings: OperatorSettingsService,
    private readonly log: ReconcileLogService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async handleCleanup(): Promise<void> {
    const days = this.settings.get('reconciler.logRetentionDays');

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    try {
      const deleted = await this.log.prune(cutoff);
      if (deleted > 0) {
        this.logger.log(
          `Pruned ${deleted} reconcile ticks older than ${days} days (before ${cutoff.toISOString()})`,
        );
      }
    } catch (error) {
      // Logged, not thrown: a failed prune is a disk-space problem for
      // tomorrow, while an exception out of a scheduled handler is a problem
      // right now.
      this.logger.error(
        `Failed to prune the reconcile log: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
