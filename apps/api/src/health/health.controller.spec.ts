import { Test, TestingModule } from '@nestjs/testing';
import { HealthCheckService, HealthCheckResult } from '@nestjs/terminus';
import { HealthController } from './health.controller';
import { DatabaseHealthIndicator } from './indicators/database.indicator';
import { SeedIntegrityIndicator } from './indicators/seed-integrity.indicator';

describe('HealthController', () => {
  let controller: HealthController;
  let mockHealthCheckService: jest.Mocked<HealthCheckService>;
  let mockDatabaseIndicator: jest.Mocked<DatabaseHealthIndicator>;
  let mockSeedIndicator: jest.Mocked<SeedIntegrityIndicator>;

  beforeEach(async () => {
    mockHealthCheckService = {
      check: jest.fn(),
    } as any;

    mockDatabaseIndicator = {
      isHealthy: jest.fn(),
    } as any;

    // Two methods, deliberately: the readiness probe calls the one that never
    // fails and the full check calls the one that does. Which endpoint calls
    // which is asserted below.
    mockSeedIndicator = {
      report: jest.fn(),
      isHealthy: jest.fn(),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: HealthCheckService, useValue: mockHealthCheckService },
        { provide: DatabaseHealthIndicator, useValue: mockDatabaseIndicator },
        { provide: SeedIntegrityIndicator, useValue: mockSeedIndicator },
      ],
    }).compile();

    controller = module.get<HealthController>(HealthController);
  });

  describe('liveness', () => {
    it('should return liveness status', () => {
      const result = controller.liveness();

      expect(result).toMatchObject({
        status: 'ok',
        timestamp: expect.any(String),
      });
    });

    it('should return valid ISO timestamp', () => {
      const result = controller.liveness();
      const timestamp = new Date(result.timestamp);

      expect(timestamp.toISOString()).toBe(result.timestamp);
    });
  });

  describe('readiness', () => {
    it('should call health check service with database indicator', async () => {
      const mockResult: HealthCheckResult = {
        status: 'ok',
        info: {
          database: {
            status: 'up',
          },
        },
        error: {},
        details: {
          database: {
            status: 'up',
          },
        },
      };

      mockHealthCheckService.check.mockResolvedValue(mockResult);

      const result = await controller.readiness();

      expect(mockHealthCheckService.check).toHaveBeenCalledWith([
        expect.any(Function),
        expect.any(Function),
      ]);
      expect(result).toMatchObject({
        status: 'ok',
        timestamp: expect.any(String),
      });
    });

    it('should return status "ok" when database is healthy', async () => {
      const mockResult: HealthCheckResult = {
        status: 'ok',
        info: {
          database: {
            status: 'up',
          },
        },
        error: {},
        details: {
          database: {
            status: 'up',
          },
        },
      };

      mockHealthCheckService.check.mockResolvedValue(mockResult);

      const result = await controller.readiness();

      expect(result.status).toBe('ok');
      expect(result.info?.database?.status).toBe('up');
    });

    it('should return status "error" when database is unhealthy', async () => {
      const mockResult: HealthCheckResult = {
        status: 'error',
        info: {},
        error: {
          database: {
            status: 'down',
            message: 'Connection refused',
          },
        },
        details: {
          database: {
            status: 'down',
            message: 'Connection refused',
          },
        },
      };

      mockHealthCheckService.check.mockResolvedValue(mockResult);

      const result = await controller.readiness();

      expect(result.status).toBe('error');
      expect(result.error?.database?.status).toBe('down');
    });

    it('should include timestamp in response', async () => {
      const mockResult: HealthCheckResult = {
        status: 'ok',
        info: {
          database: {
            status: 'up',
          },
        },
        error: {},
        details: {
          database: {
            status: 'up',
          },
        },
      };

      mockHealthCheckService.check.mockResolvedValue(mockResult);

      const result = await controller.readiness();

      expect(result.timestamp).toBeDefined();
      const timestamp = new Date(result.timestamp);
      expect(timestamp.toISOString()).toBe(result.timestamp);
    });

    it('asks the seed indicator to report, never to fail (#173)', async () => {
      const mockResult: HealthCheckResult = {
        status: 'ok',
        info: {},
        error: {},
        details: {},
      };

      mockHealthCheckService.check.mockImplementation(async (indicators) => {
        await Promise.all(indicators.map((indicator) => indicator()));
        return mockResult;
      });
      mockSeedIndicator.report.mockResolvedValue({ seed: { status: 'up' } });

      await controller.readiness();

      // Seed drift must not take the API out of service: readiness reports it
      // and stays up. See SeedIntegrityIndicator for the argument.
      expect(mockSeedIndicator.report).toHaveBeenCalledWith('seed');
      expect(mockSeedIndicator.isHealthy).not.toHaveBeenCalled();
    });
  });

  describe('fullHealth', () => {
    it('should call health check service with all indicators', async () => {
      const mockResult: HealthCheckResult = {
        status: 'ok',
        info: {
          database: {
            status: 'up',
          },
        },
        error: {},
        details: {
          database: {
            status: 'up',
          },
        },
      };

      mockHealthCheckService.check.mockResolvedValue(mockResult);

      const result = await controller.fullHealth();

      expect(mockHealthCheckService.check).toHaveBeenCalledWith([
        expect.any(Function),
        expect.any(Function),
      ]);
      expect(result).toMatchObject({
        status: 'ok',
        timestamp: expect.any(String),
      });
    });

    it('should return aggregated health status when all services healthy', async () => {
      const mockResult: HealthCheckResult = {
        status: 'ok',
        info: {
          database: {
            status: 'up',
          },
        },
        error: {},
        details: {
          database: {
            status: 'up',
          },
        },
      };

      mockHealthCheckService.check.mockResolvedValue(mockResult);

      const result = await controller.fullHealth();

      expect(result.status).toBe('ok');
      expect(result.info).toBeDefined();
    });

    it('should return aggregated health status when any service unhealthy', async () => {
      const mockResult: HealthCheckResult = {
        status: 'error',
        info: {},
        error: {
          database: {
            status: 'down',
            message: 'Database connection timeout',
          },
        },
        details: {
          database: {
            status: 'down',
            message: 'Database connection timeout',
          },
        },
      };

      mockHealthCheckService.check.mockResolvedValue(mockResult);

      const result = await controller.fullHealth();

      expect(result.status).toBe('error');
      expect(result.error).toBeDefined();
      expect(result.error?.database?.status).toBe('down');
    });

    it('should include timestamp in response', async () => {
      const mockResult: HealthCheckResult = {
        status: 'ok',
        info: {
          database: {
            status: 'up',
          },
        },
        error: {},
        details: {
          database: {
            status: 'up',
          },
        },
      };

      mockHealthCheckService.check.mockResolvedValue(mockResult);

      const result = await controller.fullHealth();

      expect(result.timestamp).toBeDefined();
      const timestamp = new Date(result.timestamp);
      expect(timestamp.toISOString()).toBe(result.timestamp);
    });

    it('should include all indicator details in response', async () => {
      const mockResult: HealthCheckResult = {
        status: 'ok',
        info: {
          database: {
            status: 'up',
            responseTime: '15ms',
          },
        },
        error: {},
        details: {
          database: {
            status: 'up',
            responseTime: '15ms',
          },
        },
      };

      mockHealthCheckService.check.mockResolvedValue(mockResult);

      const result = await controller.fullHealth();

      expect(result.info?.database).toMatchObject({
        status: 'up',
        responseTime: '15ms',
      });
    });

    it('asks the seed indicator for the strict verdict, so drift is a 503 (#173)', async () => {
      const mockResult: HealthCheckResult = {
        status: 'ok',
        info: {},
        error: {},
        details: {},
      };

      mockHealthCheckService.check.mockImplementation(async (indicators) => {
        await Promise.all(indicators.map((indicator) => indicator()));
        return mockResult;
      });
      mockSeedIndicator.isHealthy.mockResolvedValue({ seed: { status: 'up' } });

      await controller.fullHealth();

      // The check a redeploy verifies against: `curl -sf` must exit non-zero
      // when the database is behind the code.
      expect(mockSeedIndicator.isHealthy).toHaveBeenCalledWith('seed');
      expect(mockSeedIndicator.report).not.toHaveBeenCalled();
    });
  });
});
