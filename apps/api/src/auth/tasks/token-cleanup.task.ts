import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AuthService } from '../auth.service';
import { PatService } from '../../pat/pat.service';

@Injectable()
export class TokenCleanupTask {
  private readonly logger = new Logger(TokenCleanupTask.name);

  constructor(
    private readonly authService: AuthService,
    private readonly patService: PatService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async handleCron() {
    this.logger.log('Running token cleanup task');

    const refreshCount = await this.authService.cleanupExpiredTokens();
    this.logger.log(`Refresh token cleanup completed: ${refreshCount} tokens removed`);

    const patCount = await this.patService.cleanupExpiredTokens();
    this.logger.log(`PAT cleanup completed: ${patCount} tokens removed`);
  }
}
