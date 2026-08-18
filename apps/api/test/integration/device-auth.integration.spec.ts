import request from 'supertest';
import {
  TestContext,
  createTestApp,
  closeTestApp,
} from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import {
  createMockTestUser,
  authHeader,
} from '../helpers/auth-mock.helper';
import { DeviceCodeStatus } from '@prisma/client';

describe('Device Auth Controller (Integration)', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(async () => {
    resetPrismaMock();
    setupBaseMocks();
  });

  describe('POST /api/auth/device/code', () => {
    it('should generate device code successfully (public endpoint)', async () => {
      const mockDeviceCode = {
        id: 'device-code-1',
        deviceCode: 'hashed-device-code',
        userCode: 'ABCD-1234',
        userId: null,
        status: DeviceCodeStatus.pending,
        clientInfo: {},
        scopes: [],
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      context.prismaMock.deviceCode.create.mockResolvedValue(mockDeviceCode);

      const response = await request(context.app.getHttpServer())
        .post('/api/auth/device/code')
        .send({})
        .expect(200);

      expect(response.body.data).toHaveProperty('deviceCode');
      expect(response.body.data).toHaveProperty('userCode');
      expect(response.body.data).toHaveProperty('verificationUri');
      expect(response.body.data).toHaveProperty('verificationUriComplete');
      expect(response.body.data).toHaveProperty('expiresIn');
      expect(response.body.data).toHaveProperty('interval');
    });
  });

  describe('POST /api/auth/device/token', () => {
    it('should require deviceCode in request body', async () => {
      // Test validation - missing deviceCode should return 400
      await request(context.app.getHttpServer())
        .post('/api/auth/device/token')
        .send({})
        .expect(400);
    });
  });

  describe('GET /api/auth/device/activate', () => {
    it('should require authentication', async () => {
      await request(context.app.getHttpServer())
        .get('/api/auth/device/activate')
        .expect(401);
    });

    it('should return verification URI when authenticated', async () => {
      const user = await createMockTestUser(context);

      const response = await request(context.app.getHttpServer())
        .get('/api/auth/device/activate')
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data).toHaveProperty('verificationUri');
    });
  });

  describe('POST /api/auth/device/authorize', () => {
    it('should require authentication', async () => {
      await request(context.app.getHttpServer())
        .post('/api/auth/device/authorize')
        .send({ userCode: 'ABCD-1234', approve: true })
        .expect(401);
    });

    it('should validate request body format', async () => {
      const user = await createMockTestUser(context);

      // Missing fields
      await request(context.app.getHttpServer())
        .post('/api/auth/device/authorize')
        .set(authHeader(user.accessToken))
        .send({})
        .expect(400);

      // Invalid user code format
      await request(context.app.getHttpServer())
        .post('/api/auth/device/authorize')
        .set(authHeader(user.accessToken))
        .send({ userCode: 'invalid', approve: true })
        .expect(400);
    });
  });

  describe('GET /api/auth/device/sessions', () => {
    it('should require authentication', async () => {
      await request(context.app.getHttpServer())
        .get('/api/auth/device/sessions')
        .expect(401);
    });

    it('should return paginated sessions for authenticated user', async () => {
      const user = await createMockTestUser(context);

      context.prismaMock.deviceCode.findMany.mockResolvedValue([]);
      context.prismaMock.deviceCode.count.mockResolvedValue(0);

      const response = await request(context.app.getHttpServer())
        .get('/api/auth/device/sessions')
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data).toMatchObject({
        sessions: [],
        total: 0,
        page: 1,
        limit: 10,
      });
    });
  });

  describe('DELETE /api/auth/device/sessions/:id', () => {
    it('should require authentication', async () => {
      await request(context.app.getHttpServer())
        .delete('/api/auth/device/sessions/some-id')
        .expect(401);
    });

    it('should return 404 for non-existent session', async () => {
      const user = await createMockTestUser(context);

      context.prismaMock.deviceCode.findUnique.mockResolvedValue(null);

      await request(context.app.getHttpServer())
        .delete('/api/auth/device/sessions/non-existent')
        .set(authHeader(user.accessToken))
        .expect(404);
    });
  });
});
