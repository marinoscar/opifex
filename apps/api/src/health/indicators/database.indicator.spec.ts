import { Test, TestingModule } from '@nestjs/testing';
import { HealthCheckError } from '@nestjs/terminus';
import { DatabaseHealthIndicator } from './database.indicator';
import { PrismaService } from '../../prisma/prisma.service';

describe('DatabaseHealthIndicator', () => {
  let indicator: DatabaseHealthIndicator;
  let mockPrismaService: jest.Mocked<PrismaService>;

  beforeEach(async () => {
    // Only `verifyConnection` is stubbed: the indicator no longer issues its
    // own `SELECT 1`, it asks PrismaService — the single definition of
    // "reachable" shared with the boot check (#161). That the helper runs a
    // real query is asserted in prisma.service.spec.ts.
    mockPrismaService = {
      verifyConnection: jest.fn(),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DatabaseHealthIndicator,
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();

    indicator = module.get<DatabaseHealthIndicator>(DatabaseHealthIndicator);
  });

  describe('isHealthy', () => {
    it('should return "up" status when database connection succeeds', async () => {
      mockPrismaService.verifyConnection.mockResolvedValue(undefined);

      const result = await indicator.isHealthy('database');

      expect(result).toEqual({
        database: {
          status: 'up',
          responseTime: expect.stringMatching(/^\d+ms$/),
        },
      });
      expect(mockPrismaService.verifyConnection).toHaveBeenCalledTimes(1);
    });

    it('should throw HealthCheckError when database connection fails', async () => {
      const error = new Error('Connection refused');
      mockPrismaService.verifyConnection.mockRejectedValue(error);

      await expect(indicator.isHealthy('database')).rejects.toThrow(
        HealthCheckError,
      );
      await expect(indicator.isHealthy('database')).rejects.toThrow(
        'Database check failed',
      );
    });

    it('should return "down" status in error result when connection fails', async () => {
      const error = new Error('Connection timeout');
      mockPrismaService.verifyConnection.mockRejectedValue(error);

      try {
        await indicator.isHealthy('database');
        fail('Should have thrown HealthCheckError');
      } catch (e) {
        expect(e).toBeInstanceOf(HealthCheckError);
        const healthCheckError = e as HealthCheckError;
        expect(healthCheckError.causes).toEqual({
          database: {
            status: 'down',
            message: 'Connection timeout',
            responseTime: expect.stringMatching(/^\d+ms$/),
          },
        });
      }
    });

    it('should include response time in healthy status', async () => {
      mockPrismaService.verifyConnection.mockResolvedValue(undefined);

      const result = await indicator.isHealthy('database');

      expect(result.database.responseTime).toBeDefined();
      expect(result.database.responseTime).toMatch(/^\d+ms$/);

      // Response time should be a reasonable value (less than 5 seconds for a mock)
      const ms = parseInt(result.database.responseTime.replace('ms', ''));
      expect(ms).toBeGreaterThanOrEqual(0);
      expect(ms).toBeLessThan(5000);
    });

    it('should include response time in error status', async () => {
      const error = new Error('Database error');
      mockPrismaService.verifyConnection.mockRejectedValue(error);

      try {
        await indicator.isHealthy('database');
        fail('Should have thrown HealthCheckError');
      } catch (e) {
        const healthCheckError = e as HealthCheckError;
        expect(healthCheckError.causes.database.responseTime).toBeDefined();
        expect(healthCheckError.causes.database.responseTime).toMatch(
          /^\d+ms$/,
        );
      }
    });

    it('should use correct key name provided in parameter', async () => {
      mockPrismaService.verifyConnection.mockResolvedValue(undefined);

      const result = await indicator.isHealthy('postgres');

      expect(result).toHaveProperty('postgres');
      expect(result.postgres.status).toBe('up');
    });

    it('should handle unknown error types', async () => {
      mockPrismaService.verifyConnection.mockRejectedValue('String error');

      try {
        await indicator.isHealthy('database');
        fail('Should have thrown HealthCheckError');
      } catch (e) {
        const healthCheckError = e as HealthCheckError;
        expect(healthCheckError.causes.database.message).toBe('Unknown error');
      }
    });

    it('should handle null error', async () => {
      mockPrismaService.verifyConnection.mockRejectedValue(null);

      try {
        await indicator.isHealthy('database');
        fail('Should have thrown HealthCheckError');
      } catch (e) {
        const healthCheckError = e as HealthCheckError;
        expect(healthCheckError.causes.database.message).toBe('Unknown error');
      }
    });

    it('should verify the connection through PrismaService, not its own query', async () => {
      mockPrismaService.verifyConnection.mockResolvedValue(undefined);

      await indicator.isHealthy('database');

      // Readiness and the boot log must agree about what "connected" means,
      // so both go through the one helper rather than each running a query.
      expect(mockPrismaService.verifyConnection).toHaveBeenCalledTimes(1);
      expect(mockPrismaService.verifyConnection).toHaveBeenCalledWith();
    });

    it('should measure response time accurately', async () => {
      // Use fake timers so the elapsed time is driven by a virtual clock
      // instead of the host's wall-clock precision. Real timers made this
      // assertion flaky: `setTimeout(fn, 50)` does not guarantee >= 50ms of
      // *measured* elapsed time (Date.now() deltas can land at 49.x ms,
      // which `parseInt` floors to 49), so the query below simulates a slow
      // query deterministically.
      jest.useFakeTimers();

      try {
        mockPrismaService.verifyConnection.mockImplementation(
          (() =>
            new Promise<void>((resolve) => {
              setTimeout(() => resolve(), 50);
            })) as any,
        );

        const resultPromise = indicator.isHealthy('database');

        // Advance the virtual clock past the simulated query latency and
        // let the resulting microtasks (including the fake setTimeout
        // callback) flush before reading the result.
        await jest.advanceTimersByTimeAsync(50);

        const result = await resultPromise;

        expect(result.database.responseTime).toMatch(/^\d+ms$/);
        const ms = parseInt(result.database.responseTime.replace('ms', ''));
        expect(ms).toBeGreaterThanOrEqual(50);
      } finally {
        jest.useRealTimers();
      }
    });
  });
});
