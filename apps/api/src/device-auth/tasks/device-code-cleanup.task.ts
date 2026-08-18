import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DeviceAuthService } from '../device-auth.service';

/**
 * Scheduled task to clean up expired device codes
 * Runs daily at 2 AM
 */
@Injectable()
export class DeviceCodeCleanupTask {
  private readonly logger = new Logger(DeviceCodeCleanupTask.name);

  constructor(private readonly deviceAuthService: DeviceAuthService) {}

  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async handleCleanup() {
    this.logger.log('Starting device code cleanup task');

    try {
      const count = await this.deviceAuthService.cleanupExpiredCodes();
      this.logger.log(`Device code cleanup completed: ${count} records removed`);
    } catch (error) {
      this.logger.error('Error during device code cleanup', error);
    }
  }
}
