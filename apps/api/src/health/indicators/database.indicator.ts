import { Injectable, Logger } from '@nestjs/common';
import {
  HealthIndicator,
  HealthIndicatorResult,
  HealthCheckError,
} from '@nestjs/terminus';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class DatabaseHealthIndicator extends HealthIndicator {
  private readonly logger = new Logger(DatabaseHealthIndicator.name);

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const startTime = Date.now();

    try {
      // One real round trip. Delegated to PrismaService rather than issuing
      // `SELECT 1` here, so this probe and the boot-time check in
      // `PrismaService.onModuleInit()` cannot drift apart about what
      // "connected" means — the divergence #161 is a case of.
      await this.prisma.verifyConnection();

      const responseTime = Date.now() - startTime;

      return this.getStatus(key, true, {
        responseTime: `${responseTime}ms`,
      });
    } catch (error) {
      const responseTime = Date.now() - startTime;

      this.logger.error('Database health check failed', error);

      throw new HealthCheckError(
        'Database check failed',
        this.getStatus(key, false, {
          message: error instanceof Error ? error.message : 'Unknown error',
          responseTime: `${responseTime}ms`,
        }),
      );
    }
  }
}
