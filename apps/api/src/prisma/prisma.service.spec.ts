import { Logger } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * Exposes the protected retry schedule so the failure paths run instantly
 * instead of burning the real ~1.75s backoff. Nothing else is overridden —
 * the code under test is the shipped `onModuleInit`.
 */
class TestPrismaService extends PrismaService {
  constructor(delays: readonly number[] = []) {
    super();
    this.connectRetryDelaysMs = delays;
  }
}

describe('PrismaService', () => {
  let service: TestPrismaService;
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  /** Stubbed so no test needs a database; the pg pool is never touched. */
  const stub = (svc: PrismaService, queryRaw: jest.Mock) => {
    (svc as any).$connect = jest.fn().mockResolvedValue(undefined);
    (svc as any).$queryRaw = queryRaw;
  };

  beforeEach(() => {
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('verifyConnection', () => {
    it('issues a real SELECT 1 round trip', async () => {
      const queryRaw = jest.fn().mockResolvedValue([{ '?column?': 1 }]);
      service = new TestPrismaService();
      stub(service, queryRaw);

      await service.verifyConnection();

      expect(queryRaw).toHaveBeenCalledTimes(1);
      expect(queryRaw).toHaveBeenCalledWith(
        expect.arrayContaining([expect.stringContaining('SELECT 1')]),
      );
    });

    it('propagates the driver error so callers see the real cause', async () => {
      const queryRaw = jest
        .fn()
        .mockRejectedValue(
          new Error("Can't reach database server at 127.0.0.1:5432"),
        );
      service = new TestPrismaService();
      stub(service, queryRaw);

      await expect(service.verifyConnection()).rejects.toThrow(
        "Can't reach database server",
      );
    });
  });

  describe('onModuleInit', () => {
    it('logs the success line when the database answers', async () => {
      const queryRaw = jest.fn().mockResolvedValue([{ '?column?': 1 }]);
      service = new TestPrismaService();
      stub(service, queryRaw);

      await service.onModuleInit();

      expect(logSpy).toHaveBeenCalledWith('Database connected');
      expect(errorSpy).not.toHaveBeenCalled();
    });

    // The #161 regression itself: with the PrismaPg driver adapter the pool is
    // lazy, so `$connect()` resolves against a database that is stopped,
    // unroutable or rejecting credentials. A resolved `$connect()` must not be
    // enough to print the success line.
    it('does not log the success line when $connect() resolves but the query fails', async () => {
      const queryRaw = jest
        .fn()
        .mockRejectedValue(
          new Error("Can't reach database server at 127.0.0.1:5432"),
        );
      service = new TestPrismaService();
      stub(service, queryRaw);

      await service.onModuleInit();

      expect((service as any).$connect).toHaveBeenCalled();
      expect(logSpy).not.toHaveBeenCalledWith('Database connected');
    });

    it('logs an error naming the driver cause when the database is unreachable', async () => {
      const queryRaw = jest
        .fn()
        .mockRejectedValue(
          new Error('Authentication failed against the database server'),
        );
      service = new TestPrismaService();
      stub(service, queryRaw);

      await service.onModuleInit();

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const message = errorSpy.mock.calls[0][0] as string;
      expect(message).toContain('Database NOT reachable');
      expect(message).toContain(
        'Authentication failed against the database server',
      );
      expect(message).toContain('/api/health/ready');
    });

    // The decision recorded in the service's doc comment: report, do not
    // abort. A process that has exited cannot answer the readiness probe that
    // explains why it is unhealthy.
    it('does not throw when the database is unreachable', async () => {
      const queryRaw = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      service = new TestPrismaService();
      stub(service, queryRaw);

      await expect(service.onModuleInit()).resolves.toBeUndefined();
    });

    it('retries a boot-time race and logs success once the database answers', async () => {
      const queryRaw = jest
        .fn()
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockResolvedValue([{ '?column?': 1 }]);
      service = new TestPrismaService([0, 0, 0]);
      stub(service, queryRaw);

      await service.onModuleInit();

      expect(queryRaw).toHaveBeenCalledTimes(3);
      expect(logSpy).toHaveBeenCalledWith('Database connected');
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('gives up after the bounded schedule rather than retrying forever', async () => {
      const queryRaw = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      service = new TestPrismaService([0, 0, 0]);
      stub(service, queryRaw);

      await service.onModuleInit();

      // Three delays means four attempts, then a report.
      expect(queryRaw).toHaveBeenCalledTimes(4);
      expect(errorSpy).toHaveBeenCalledTimes(1);
    });

    it('handles a non-Error rejection without losing the message', async () => {
      const queryRaw = jest.fn().mockRejectedValue('socket hang up');
      service = new TestPrismaService();
      stub(service, queryRaw);

      await service.onModuleInit();

      expect(errorSpy.mock.calls[0][0]).toContain('socket hang up');
    });
  });
});
