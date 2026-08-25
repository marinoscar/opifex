import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import {
  HealthCheck,
  HealthCheckService,
  HealthCheckResult,
} from '@nestjs/terminus';
import { Public } from '../auth/decorators/public.decorator';
import { DatabaseHealthIndicator } from './indicators/database.indicator';
import { SeedIntegrityIndicator } from './indicators/seed-integrity.indicator';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: DatabaseHealthIndicator,
    private readonly seed: SeedIntegrityIndicator,
  ) {}

  @Get('live')
  @Public()
  @ApiOperation({
    summary: 'Liveness probe',
    description:
      'Checks if the application process is running. Used by orchestrators to detect hung processes.',
  })
  @ApiResponse({
    status: 200,
    description: 'Application is alive',
    schema: {
      type: 'object',
      properties: {
        status: { type: 'string', example: 'ok' },
        timestamp: { type: 'string', format: 'date-time' },
      },
    },
  })
  liveness() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }

  @Get('ready')
  @Public()
  @HealthCheck()
  @ApiOperation({
    summary: 'Readiness probe',
    description:
      'Checks if the application is ready to receive traffic. Includes a real ' +
      'database round trip, and reports — without failing on — seed drift ' +
      'between the permissions this build enforces and the rows behind them. ' +
      'Seed drift does not make the API unready: it serves everything not ' +
      'gated on a missing permission, and the fix runs inside this container. ' +
      'Use GET /api/health for a check that fails on it.',
  })
  @ApiResponse({
    status: 200,
    description: 'Application is ready',
    schema: {
      type: 'object',
      properties: {
        status: { type: 'string', example: 'ok' },
        info: {
          type: 'object',
          properties: {
            database: {
              type: 'object',
              properties: {
                status: { type: 'string', example: 'up' },
              },
            },
            seed: {
              type: 'object',
              description:
                'Permission set as seeded. `status` is always `up` here — ' +
                '`missing` greater than zero means the database is behind the ' +
                'code and `npm run prisma:seed` has not been run.',
              properties: {
                status: { type: 'string', example: 'up' },
                checked: { type: 'boolean', example: true },
                expected: { type: 'number', example: 29 },
                missing: { type: 'number', example: 0 },
                missingPermissions: {
                  type: 'array',
                  items: { type: 'string' },
                  example: [],
                },
              },
            },
          },
        },
        timestamp: { type: 'string', format: 'date-time' },
      },
    },
  })
  @ApiResponse({
    status: 503,
    description: 'Application is not ready',
    schema: {
      type: 'object',
      properties: {
        status: { type: 'string', example: 'error' },
        error: {
          type: 'object',
          properties: {
            database: {
              type: 'object',
              properties: {
                status: { type: 'string', example: 'down' },
                message: { type: 'string' },
              },
            },
          },
        },
        timestamp: { type: 'string', format: 'date-time' },
      },
    },
  })
  async readiness(): Promise<HealthCheckResult & { timestamp: string }> {
    const result = await this.health.check([
      () => this.db.isHealthy('database'),
      // `report`, not `isHealthy`: seed drift is reported here and fails
      // nothing. See SeedIntegrityIndicator for why the probe orchestration
      // consumes must not be the one that goes red over it.
      () => this.seed.report('seed'),
    ]);

    return {
      ...result,
      timestamp: new Date().toISOString(),
    };
  }

  @Get()
  @Public()
  @HealthCheck()
  @ApiOperation({
    summary: 'Full health check',
    description:
      'Comprehensive health check including all dependencies. Stricter than ' +
      'the readiness probe: it also fails (503) when the database is missing ' +
      'permissions this build enforces, which is a deployment whose seed was ' +
      'never re-run. This is the check a redeploy should verify against, ' +
      'because `curl -sf` exits non-zero on it.',
  })
  @ApiResponse({ status: 200, description: 'All checks passed' })
  @ApiResponse({
    status: 503,
    description:
      'One or more checks failed — the database is unreachable, or its ' +
      'permission set does not match the running code (`error.seed`).',
  })
  async fullHealth(): Promise<HealthCheckResult & { timestamp: string }> {
    const result = await this.health.check([
      () => this.db.isHealthy('database'),
      // Unlike readiness, this one fails on seed drift.
      () => this.seed.isHealthy('seed'),
      // Add more indicators here as needed:
      // () => this.redis.isHealthy('redis'),
      // () => this.external.isHealthy('external-api'),
    ]);

    return {
      ...result,
      timestamp: new Date().toISOString(),
    };
  }
}
