import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import {
  HealthCheck,
  HealthCheckService,
  HealthCheckResult,
} from '@nestjs/terminus';
import { Public } from '../auth/decorators/public.decorator';
import { DatabaseHealthIndicator } from './indicators/database.indicator';
import { FleetIndicator } from './indicators/fleet.indicator';
import { SeedIntegrityIndicator } from './indicators/seed-integrity.indicator';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: DatabaseHealthIndicator,
    private readonly seed: SeedIntegrityIndicator,
    private readonly fleet: FleetIndicator,
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
      'between the permissions this build enforces and the rows behind them, ' +
      'and the state of the runner fleet. Neither makes the API unready: it ' +
      'serves everything not gated on a missing permission, an empty fleet ' +
      'stops dispatch and nothing else, and both fixes run inside this ' +
      'container. Use GET /api/health for a check that fails on them.',
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
            fleet: {
              type: 'object',
              description:
                'The runner fleet as routing sees it (#277). `status` is ' +
                'always `up` here — `routable` of zero means dispatch has ' +
                'nothing to route to and every work order queues, and ' +
                '`enabled` of zero means an operator switched them off, ' +
                'which is a choice rather than a fault.',
              properties: {
                status: { type: 'string', example: 'up' },
                checked: { type: 'boolean', example: true },
                registered: { type: 'number', example: 1 },
                routable: { type: 'number', example: 1 },
                enabled: { type: 'number', example: 1 },
                dispatchable: { type: 'number', example: 1 },
                runners: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      key: { type: 'string', example: 'claude-code-local' },
                      version: { type: 'string', example: '2.0.1' },
                      enabled: { type: 'boolean', example: true },
                      available: { type: 'boolean', example: true },
                      unavailableReason: { type: 'string' },
                      maxConcurrency: { type: 'number', example: 2 },
                    },
                  },
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
      // Same reasoning, same shape: an empty fleet is reported here and fails
      // nothing. See FleetIndicator for why readiness must not go red over a
      // condition whose remedy runs inside the container it would take down.
      () => this.fleet.report('fleet'),
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
      'permissions this build enforces (a deployment whose seed was never ' +
      're-run), or when no runner is routable at all (a deployment where ' +
      'registration never converged, so nothing can be dispatched). A runner ' +
      'an operator has DISABLED is reported and does not fail this check. ' +
      'This is the check a redeploy should verify against, because `curl ' +
      '-sf` exits non-zero on it.',
  })
  @ApiResponse({ status: 200, description: 'All checks passed' })
  @ApiResponse({
    status: 503,
    description:
      'One or more checks failed — the database is unreachable, its ' +
      'permission set does not match the running code (`error.seed`), or no ' +
      'runner is registered and routable (`error.fleet`).',
  })
  async fullHealth(): Promise<HealthCheckResult & { timestamp: string }> {
    const result = await this.health.check([
      () => this.db.isHealthy('database'),
      // Unlike readiness, this one fails on seed drift.
      () => this.seed.isHealthy('seed'),
      // Also unlike readiness: a fleet routing cannot see is a deployment
      // whose code and database disagree, since registration is
      // unconditional. Not gated on DISPATCH_ENABLED — this asks whether the
      // deployment is correct, not whether work is being lost right now.
      () => this.fleet.isHealthy('fleet'),
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
