import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';

import { DailyBriefService } from './daily-brief.service';

/**
 * Sends the daily brief once a day (#93).
 *
 * ## Why 08:00 and not midnight
 *
 * The brief is read at the start of a working day, and one composed at
 * midnight describes a day that ended eight hours before anybody looks at it —
 * so the top item would be ranked against a factory that has since moved. This
 * runs in the server's timezone deliberately: an operator configures the
 * container's TZ, and a brief that arrives at a fixed UTC hour is wrong for
 * everyone not in London.
 *
 * ## Gated on the supervisor switch
 *
 * The brief needs no model — the ranking is deterministic — but it is
 * supervisor output and lands in the decision log, so it follows the same
 * switch. A deployment that has not turned the supervisor on has not asked for
 * a daily email either.
 */
@Injectable()
export class DailyBriefTask {
  private readonly logger = new Logger(DailyBriefTask.name);

  constructor(
    private readonly brief: DailyBriefService,
    private readonly config: ConfigService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_8AM)
  async handleDailyBrief(): Promise<void> {
    if (this.config.get<boolean>('supervisor.enabled') !== true) return;

    try {
      const result = await this.brief.send();
      this.logger.log(
        `Daily brief ${result.proposalId ? 'recorded' : 'NOT recorded'}; ` +
          `${result.delivered ? 'delivered' : 'not delivered'}`,
      );
    } catch (error) {
      // Unreachable by contract; kept because "never throws" is a claim about
      // code somebody else will edit.
      this.logger.error(
        `Daily brief threw, which it is not supposed to: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
