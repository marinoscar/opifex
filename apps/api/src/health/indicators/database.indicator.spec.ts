import { Test, TestingModule } from '@nestjs/testing';
import { HealthCheckError } from '@nestjs/terminus';
import { DatabaseHealthIndicator } from './database.indicator';
import { PrismaService } from '../../prisma/prisma.service';

describe('DatabaseHealthIndicator', () => {
  let indicator: DatabaseHealthIndicator;
  let mockPrismaService: jest.Mocked<PrismaService>;

  beforeEach(async () => {
    mockPrismaService = {
      $queryRaw: jest.fn(),
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
      mockPrismaService.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);

      const result = await indicator.isHealthy('database');

      expect(result).toEqual({
        database: {
          status: 'up',
          responseTime: expect.stringMatching(/^\d+ms$/),
        },
      });
      expect(mockPrismaService.$queryRaw).toHaveBeenCalledWith(
        expect.arrayContaining([expect.stringContaining('SELECT 1')]),
      );
    });

    it('should throw HealthCheckError when database connection fails', async () => {
      const error = new Error('Connection refused');
      mockPrismaService.$queryRaw.mockRejectedValue(error);

      await expect(indicator.isHealthy('database')).rejects.toThrow(
        HealthCheckError,
      );
      await expect(indicator.isHealthy('database')).rejects.toThrow(
        'Database check failed',
      );
    });

    it('should return "down" status in error result when connection fails', async () => {
      const error = new Error('Connection timeout');
      mockPrismaService.$queryRaw.mockRejectedValue(error);

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
      mockPrismaService.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);

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
      mockPrismaService.$queryRaw.mockRejectedValue(error);

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
      mockPrismaService.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);

      const result = await indicator.isHealthy('postgres');

      expect(result).toHaveProperty('postgres');
      expect(result.postgres.status).toBe('up');
    });

    it('should handle unknown error types', async () => {
      mockPrismaService.$queryRaw.mockRejectedValue('String error');

      try {
        await indicator.isHealthy('database');
        fail('Should have thrown HealthCheckError');
      } catch (e) {
        const healthCheckError = e as HealthCheckError;
        expect(healthCheckError.causes.database.message).toBe('Unknown error');
      }
    });

    it('should handle null error', async () => {
      mockPrismaService.$queryRaw.mockRejectedValue(null);

      try {
        await indicator.isHealthy('database');
        fail('Should have thrown HealthCheckError');
      } catch (e) {
        const healthCheckError = e as HealthCheckError;
        expect(healthCheckError.causes.database.message).toBe('Unknown error');
      }
    });

    it('should execute database query with proper SQL', async () => {
      mockPrismaService.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);

      await indicator.isHealthy('database');

      // Verify the SQL query is correct
      expect(mockPrismaService.$queryRaw).toHaveBeenCalledTimes(1);
      const callArgs = mockPrismaService.$queryRaw.mock.calls[0][0];
      expect(callArgs).toEqual(expect.arrayContaining([expect.any(String)]));
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
        mockPrismaService.$queryRaw.mockImplementation(
          (() =>
            new Promise((resolve) => {
              setTimeout(() => resolve([{ '?column?': 1 }]), 50);
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
