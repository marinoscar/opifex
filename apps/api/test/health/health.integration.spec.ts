import request from 'supertest';
import {
  TestContext,
  createTestApp,
  closeTestApp,
} from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import {
  EXPECTED_PERMISSIONS,
  SeedIntegrityService,
} from '../../src/health/seed-integrity.service';

describe('Health Endpoints (Integration)', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });

    // The seed check caches a successful result for a minute (see
    // SeedIntegrityService). One app instance serves every test in this file,
    // so without this the first request's verdict would answer all of them.
    // Zero TTL makes each request re-read the doubled table.
    (context.app.get(SeedIntegrityService) as any).checkTtlMs = 0;
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(async () => {
    resetPrismaMock();
    setupBaseMocks();
    // `setupBaseMocks` seeds a handful of fixture permissions, which the seed
    // check would correctly read as a database missing most of what this build
    // enforces. Every test below except the drift ones wants a deployment that
    // was seeded properly.
    seedAllPermissions();
  });

  /** The permissions table as a correctly seeded deployment holds it. */
  function seedAllPermissions(): void {
    (context.prismaMock.permission.findMany as jest.Mock).mockResolvedValue(
      EXPECTED_PERMISSIONS.map((name) => ({ name })),
    );
  }

  /** The same table with `omit` never inserted — the #173 condition. */
  function seedAllPermissionsExcept(omit: string): void {
    (context.prismaMock.permission.findMany as jest.Mock).mockResolvedValue(
      EXPECTED_PERMISSIONS.filter((name) => name !== omit).map((name) => ({
        name,
      })),
    );
  }

  describe('GET /api/health', () => {
    it('should return 200 with overall health status', async () => {
      // Mock successful database query
      context.prismaMock.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);

      const response = await request(context.app.getHttpServer())
        .get('/api/health')
        .expect(200);

      expect(response.body.data).toMatchObject({
        status: 'ok',
        timestamp: expect.any(String),
      });
    });

    it('should return all health indicators', async () => {
      context.prismaMock.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);

      const response = await request(context.app.getHttpServer())
        .get('/api/health')
        .expect(200);

      expect(response.body.data.info).toBeDefined();
      expect(response.body.data.info.database).toBeDefined();
      expect(response.body.data.info.database.status).toBe('up');
    });

    it('should include response time in database indicator', async () => {
      context.prismaMock.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);

      const response = await request(context.app.getHttpServer())
        .get('/api/health')
        .expect(200);

      expect(response.body.data.info.database.responseTime).toBeDefined();
      expect(response.body.data.info.database.responseTime).toMatch(/^\d+ms$/);
    });

    it('should return 503 when database is down', async () => {
      context.prismaMock.$queryRaw.mockRejectedValue(
        new Error('Connection refused'),
      );

      const response = await request(context.app.getHttpServer())
        .get('/api/health')
        .expect(503);

      expect(response.body).toMatchObject({
        statusCode: 503,
        code: 'ERROR',
        timestamp: expect.any(String),
      });
    });

    it('should include error message when database check fails', async () => {
      context.prismaMock.$queryRaw.mockRejectedValue(
        new Error('Database connection timeout'),
      );

      const response = await request(context.app.getHttpServer())
        .get('/api/health')
        .expect(503);

      expect(response.body.message).toBeDefined();
    });

    it('should not require authentication', async () => {
      context.prismaMock.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);

      await request(context.app.getHttpServer()).get('/api/health').expect(200);
    });

    it('should include timestamp in response', async () => {
      context.prismaMock.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);

      const response = await request(context.app.getHttpServer())
        .get('/api/health')
        .expect(200);

      expect(response.body.data.timestamp).toBeDefined();
      const timestamp = new Date(response.body.data.timestamp);
      expect(timestamp.toISOString()).toBe(response.body.data.timestamp);
    });
  });

  describe('GET /api/health/live', () => {
    it('should return 200 when service is running', async () => {
      const response = await request(context.app.getHttpServer())
        .get('/api/health/live')
        .expect(200);

      expect(response.body.data).toMatchObject({
        status: 'ok',
        timestamp: expect.any(String),
      });
    });

    it('should return ok status regardless of database state', async () => {
      // Even with database down, liveness should pass
      context.prismaMock.$queryRaw.mockRejectedValue(
        new Error('Database is down'),
      );

      const response = await request(context.app.getHttpServer())
        .get('/api/health/live')
        .expect(200);

      expect(response.body.data.status).toBe('ok');
    });

    it('should be accessible without authentication', async () => {
      await request(context.app.getHttpServer())
        .get('/api/health/live')
        .expect(200);
    });

    it('should include valid timestamp', async () => {
      const response = await request(context.app.getHttpServer())
        .get('/api/health/live')
        .expect(200);

      expect(response.body.data.timestamp).toBeDefined();
      const timestamp = new Date(response.body.data.timestamp);
      expect(timestamp.toISOString()).toBe(response.body.data.timestamp);
    });

    it('should not check database connectivity', async () => {
      await request(context.app.getHttpServer())
        .get('/api/health/live')
        .expect(200);

      // Verify database was not queried
      expect(context.prismaMock.$queryRaw).not.toHaveBeenCalled();
    });

    it('should return quickly, doing no expensive work', async () => {
      // A tight wall-clock ceiling on a real HTTP round trip is inherently
      // flaky: shared CI runners get briefly loaded, and that's exactly
      // when a hard "< 100ms" style assertion fails even though nothing
      // is actually wrong. What actually matters is that the liveness
      // probe stays cheap by doing no I/O - which the adjacent
      // 'should not check database connectivity' test already asserts
      // directly. We keep a duration check here too, but only as a
      // generous smoke check against gross regressions (e.g. an
      // accidentally-added blocking call), not as a strict budget.
      const startTime = Date.now();

      await request(context.app.getHttpServer())
        .get('/api/health/live')
        .expect(200);

      const duration = Date.now() - startTime;
      expect(duration).toBeLessThan(2000);
      expect(context.prismaMock.$queryRaw).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/health/ready', () => {
    it('should return 200 when all dependencies healthy', async () => {
      context.prismaMock.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);

      const response = await request(context.app.getHttpServer())
        .get('/api/health/ready')
        .expect(200);

      expect(response.body.data).toMatchObject({
        status: 'ok',
        timestamp: expect.any(String),
      });
    });

    it('should include database status', async () => {
      context.prismaMock.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);

      const response = await request(context.app.getHttpServer())
        .get('/api/health/ready')
        .expect(200);

      expect(response.body.data.info).toBeDefined();
      expect(response.body.data.info.database).toBeDefined();
      expect(response.body.data.info.database.status).toBe('up');
    });

    it('should return 503 when database is unhealthy', async () => {
      context.prismaMock.$queryRaw.mockRejectedValue(
        new Error('Connection failed'),
      );

      const response = await request(context.app.getHttpServer())
        .get('/api/health/ready')
        .expect(503);

      expect(response.body.statusCode).toBe(503);
      expect(response.body.code).toBe('ERROR');
    });

    it('should be accessible without authentication', async () => {
      context.prismaMock.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);

      await request(context.app.getHttpServer())
        .get('/api/health/ready')
        .expect(200);
    });

    it('should verify database connectivity', async () => {
      context.prismaMock.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);

      await request(context.app.getHttpServer())
        .get('/api/health/ready')
        .expect(200);

      // Verify database was queried
      expect(context.prismaMock.$queryRaw).toHaveBeenCalled();
    });

    it('should include response time in database check', async () => {
      context.prismaMock.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);

      const response = await request(context.app.getHttpServer())
        .get('/api/health/ready')
        .expect(200);

      expect(response.body.data.info.database.responseTime).toBeDefined();
      expect(response.body.data.info.database.responseTime).toMatch(/^\d+ms$/);
    });

    it('should include timestamp in response', async () => {
      context.prismaMock.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);

      const response = await request(context.app.getHttpServer())
        .get('/api/health/ready')
        .expect(200);

      expect(response.body.data.timestamp).toBeDefined();
      const timestamp = new Date(response.body.data.timestamp);
      expect(timestamp.toISOString()).toBe(response.body.data.timestamp);
    });

    it('should include error details when database fails', async () => {
      context.prismaMock.$queryRaw.mockRejectedValue(
        new Error('Network timeout'),
      );

      const response = await request(context.app.getHttpServer())
        .get('/api/health/ready')
        .expect(503);

      expect(response.body.message).toBeDefined();
      expect(response.body.statusCode).toBe(503);
    });
  });

  describe('Public Access', () => {
    it('should allow GET /api/health without Authorization header', async () => {
      context.prismaMock.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);

      const response = await request(context.app.getHttpServer())
        .get('/api/health')
        .expect(200);

      expect(response.body.data.status).toBe('ok');
    });

    it('should allow GET /api/health/live without Authorization header', async () => {
      const response = await request(context.app.getHttpServer())
        .get('/api/health/live')
        .expect(200);

      expect(response.body.data.status).toBe('ok');
    });

    it('should allow GET /api/health/ready without Authorization header', async () => {
      context.prismaMock.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);

      const response = await request(context.app.getHttpServer())
        .get('/api/health/ready')
        .expect(200);

      expect(response.body.data.status).toBe('ok');
    });
  });

  describe('Error Scenarios', () => {
    it('should handle database timeout', async () => {
      context.prismaMock.$queryRaw.mockRejectedValue(
        new Error('Query timeout exceeded'),
      );

      const response = await request(context.app.getHttpServer())
        .get('/api/health')
        .expect(503);

      expect(response.body.statusCode).toBe(503);
      expect(response.body.message).toBeDefined();
    });

    it('should handle database connection pool exhaustion', async () => {
      context.prismaMock.$queryRaw.mockRejectedValue(
        new Error('Connection pool exhausted'),
      );

      const response = await request(context.app.getHttpServer())
        .get('/api/health/ready')
        .expect(503);

      expect(response.body.statusCode).toBe(503);
      expect(response.body.message).toBeDefined();
    });

    it('should handle generic database errors', async () => {
      context.prismaMock.$queryRaw.mockRejectedValue(
        new Error('Unexpected database error'),
      );

      const response = await request(context.app.getHttpServer())
        .get('/api/health/ready')
        .expect(503);

      expect(response.body.statusCode).toBe(503);
      expect(response.body.code).toBe('ERROR');
    });
  });

  describe('Response Format', () => {
    it('should return consistent format for healthy status', async () => {
      context.prismaMock.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);

      const response = await request(context.app.getHttpServer())
        .get('/api/health')
        .expect(200);

      expect(response.body.data).toMatchObject({
        status: 'ok',
        info: expect.any(Object),
        details: expect.any(Object),
        timestamp: expect.any(String),
      });
    });

    it('should return consistent format for unhealthy status', async () => {
      context.prismaMock.$queryRaw.mockRejectedValue(new Error('DB Error'));

      const response = await request(context.app.getHttpServer())
        .get('/api/health')
        .expect(503);

      expect(response.body).toMatchObject({
        statusCode: 503,
        code: 'ERROR',
        message: expect.any(String),
        timestamp: expect.any(String),
        path: expect.any(String),
      });
    });
  });

  describe('Seed drift (#173)', () => {
    it('reports the permission set on a readiness probe', async () => {
      context.prismaMock.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);

      const response = await request(context.app.getHttpServer())
        .get('/api/health/ready')
        .expect(200);

      expect(response.body.data.info.seed).toMatchObject({
        status: 'up',
        checked: true,
        expected: EXPECTED_PERMISSIONS.length,
        missing: 0,
      });
    });

    it('stays ready when a permission was never seeded, and says which', async () => {
      // The condition that made every cockpit endpoint 403 while readiness
      // answered ok. It must now be visible in the payload - and must still
      // not take the API out of service, because the API is what serves the
      // diagnosis and hosts the fix.
      context.prismaMock.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
      seedAllPermissionsExcept('runs:read');

      const response = await request(context.app.getHttpServer())
        .get('/api/health/ready')
        .expect(200);

      expect(response.body.data.status).toBe('ok');
      expect(response.body.data.info.seed.status).toBe('up');
      expect(response.body.data.info.seed.missingPermissions).toEqual([
        'runs:read',
      ]);
    });

    it('fails the full health check when a permission was never seeded', async () => {
      context.prismaMock.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
      seedAllPermissionsExcept('runs:read');

      const response = await request(context.app.getHttpServer())
        .get('/api/health')
        .expect(503);

      expect(response.body.statusCode).toBe(503);
    });

    it('passes the full health check on a correctly seeded database', async () => {
      context.prismaMock.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);

      const response = await request(context.app.getHttpServer())
        .get('/api/health')
        .expect(200);

      expect(response.body.data.info.seed).toMatchObject({
        status: 'up',
        missing: 0,
      });
    });
  });
});
