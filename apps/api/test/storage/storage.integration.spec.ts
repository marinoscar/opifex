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
  createMockAdminUser,
  authHeader,
} from '../helpers/auth-mock.helper';
import { STORAGE_PROVIDER } from '../../src/storage/providers/storage-provider.interface';
import { createMockStorageProvider } from '../mocks/storage-provider.mock';

describe('Storage Integration', () => {
  let context: TestContext;
  let mockStorageProvider: ReturnType<typeof createMockStorageProvider>;

  const mockStorageObjectId = '550e8400-e29b-41d4-a716-446655440000'; // Valid UUID

  const mockStorageObject = {
    id: mockStorageObjectId,
    name: 'test-file.pdf',
    size: BigInt(1024000),
    mimeType: 'application/pdf',
    storageKey: 'uploads/123456/uuid-123.pdf',
    storageProvider: 's3',
    bucket: 'test-bucket',
    status: 'ready',
    s3UploadId: null,
    uploadedById: 'user-123',
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeAll(async () => {
    mockStorageProvider = createMockStorageProvider();
    context = await createTestApp({ useMockDatabase: true });

    // Override storage provider with mock
    const storageProviderToken = context.module.get(STORAGE_PROVIDER, { strict: false });
    if (storageProviderToken) {
      Object.assign(storageProviderToken, mockStorageProvider);
    }
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(async () => {
    resetPrismaMock();
    setupBaseMocks();
    jest.clearAllMocks();
  });

  describe('POST /api/storage/objects/upload/init', () => {
    it('should initialize upload for authenticated user', async () => {
      const user = await createMockTestUser(context);

      const dto = {
        name: 'test.pdf',
        size: 52428800, // 50MB
        mimeType: 'application/pdf',
      };

      mockStorageProvider.initMultipartUpload.mockResolvedValue({
        uploadId: 'upload-123',
        key: 'uploads/123/uuid.pdf',
      });
      mockStorageProvider.getBucket.mockReturnValue('test-bucket');

      context.prismaMock.storageObject.create.mockResolvedValue({
        ...mockStorageObject,
        id: 'new-obj-id',
        name: dto.name,
        size: BigInt(dto.size),
        status: 'pending',
        s3UploadId: 'upload-123',
        uploadedById: user.id,
      });

      const response = await request(context.app.getHttpServer())
        .post('/api/storage/objects/upload/init')
        .set(authHeader(user.accessToken))
        .send(dto)
        .expect(201);

      expect(response.body.data).toMatchObject({
        objectId: 'new-obj-id',
        uploadId: 'upload-123',
        partSize: expect.any(Number),
        totalParts: expect.any(Number),
        presignedUrls: expect.any(Array),
      });
    });

    it('should return 401 for unauthenticated request', async () => {
      await request(context.app.getHttpServer())
        .post('/api/storage/objects/upload/init')
        .send({
          name: 'test.pdf',
          size: 1024000,
          mimeType: 'application/pdf',
        })
        .expect(401);
    });

    it('should validate request body', async () => {
      const user = await createMockTestUser(context);

      await request(context.app.getHttpServer())
        .post('/api/storage/objects/upload/init')
        .set(authHeader(user.accessToken))
        .send({
          // Missing required fields
          name: 'test.pdf',
        })
        .expect(400);
    });
  });

  describe('GET /api/storage/objects/:id/upload/status', () => {
    it('should return upload status', async () => {
      const user = await createMockTestUser(context);

      const chunks = [
        { partNumber: 1, size: BigInt(10485760), eTag: 'etag1' },
        { partNumber: 2, size: BigInt(10485760), eTag: 'etag2' },
      ];

      context.prismaMock.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        uploadedById: user.id,
        status: 'pending',
        chunks,
      });

      const response = await request(context.app.getHttpServer())
        .get(`/api/storage/objects/${mockStorageObjectId}/upload/status`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data).toMatchObject({
        objectId: mockStorageObjectId,
        status: 'pending',
        uploadedParts: expect.any(Array),
        totalParts: expect.any(Number),
      });
    });

    it('should return 404 for non-existent object', async () => {
      const user = await createMockTestUser(context);

      context.prismaMock.storageObject.findUnique.mockResolvedValue(null);

      await request(context.app.getHttpServer())
        .get('/api/storage/objects/550e8400-e29b-41d4-a716-446655440001/upload/status')
        .set(authHeader(user.accessToken))
        .expect(404);
    });

    it('should return 403 for non-owner', async () => {
      const user = await createMockTestUser(context);
      const otherUserId = 'other-user-456';

      context.prismaMock.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        uploadedById: otherUserId,
        chunks: [],
      });

      await request(context.app.getHttpServer())
        .get(`/api/storage/objects/${mockStorageObjectId}/upload/status`)
        .set(authHeader(user.accessToken))
        .expect(403);
    });
  });

  describe('POST /api/storage/objects/:id/upload/complete', () => {
    it('should complete upload', async () => {
      const user = await createMockTestUser(context);

      const dto = {
        parts: [
          { partNumber: 1, eTag: 'etag1' },
          { partNumber: 2, eTag: 'etag2' },
        ],
      };

      context.prismaMock.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        uploadedById: user.id,
        status: 'pending',
        s3UploadId: 'upload-123',
        chunks: [],
      });
      context.prismaMock.storageObjectChunk.upsert.mockResolvedValue({});
      mockStorageProvider.completeMultipartUpload.mockResolvedValue({
        key: 'key',
        bucket: 'bucket',
        location: 's3://bucket/key',
      });
      context.prismaMock.storageObject.update.mockResolvedValue({
        ...mockStorageObject,
        uploadedById: user.id,
        status: 'processing',
      });
      context.prismaMock.auditEvent.create.mockResolvedValue({});

      const response = await request(context.app.getHttpServer())
        .post(`/api/storage/objects/${mockStorageObjectId}/upload/complete`)
        .set(authHeader(user.accessToken))
        .send(dto)
        .expect(201);

      expect(response.body.data).toMatchObject({
        id: mockStorageObjectId,
        status: 'processing',
      });
    });

    it('should return 404 for non-existent object', async () => {
      const user = await createMockTestUser(context);

      context.prismaMock.storageObject.findUnique.mockResolvedValue(null);

      await request(context.app.getHttpServer())
        .post('/api/storage/objects/550e8400-e29b-41d4-a716-446655440001/upload/complete')
        .set(authHeader(user.accessToken))
        .send({
          parts: [{ partNumber: 1, eTag: 'etag1' }],
        })
        .expect(404);
    });

    it('should validate parts array', async () => {
      const user = await createMockTestUser(context);

      await request(context.app.getHttpServer())
        .post(`/api/storage/objects/${mockStorageObjectId}/upload/complete`)
        .set(authHeader(user.accessToken))
        .send({
          parts: 'invalid', // Should be array
        })
        .expect(400);
    });
  });

  describe('DELETE /api/storage/objects/:id/upload/abort', () => {
    it('should abort upload', async () => {
      const user = await createMockTestUser(context);

      context.prismaMock.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        uploadedById: user.id,
        s3UploadId: 'upload-123',
      });
      mockStorageProvider.abortMultipartUpload.mockResolvedValue(undefined);
      context.prismaMock.storageObject.delete.mockResolvedValue({});
      context.prismaMock.auditEvent.create.mockResolvedValue({});

      await request(context.app.getHttpServer())
        .delete(`/api/storage/objects/${mockStorageObjectId}/upload/abort`)
        .set(authHeader(user.accessToken))
        .expect(200); // Note: Controller returns void but Fastify may default to 200
    });

    it('should return 404 for non-existent object', async () => {
      const user = await createMockTestUser(context);

      context.prismaMock.storageObject.findUnique.mockResolvedValue(null);

      await request(context.app.getHttpServer())
        .delete('/api/storage/objects/550e8400-e29b-41d4-a716-446655440001/upload/abort')
        .set(authHeader(user.accessToken))
        .expect(404);
    });
  });

  describe('GET /api/storage/objects', () => {
    it('should list user\'s objects', async () => {
      const user = await createMockTestUser(context);

      const mockObjects = [
        { ...mockStorageObject, id: 'obj-1', uploadedById: user.id },
        { ...mockStorageObject, id: 'obj-2', uploadedById: user.id },
      ];

      context.prismaMock.storageObject.findMany.mockResolvedValue(mockObjects);
      context.prismaMock.storageObject.count.mockResolvedValue(2);

      const response = await request(context.app.getHttpServer())
        .get('/api/storage/objects')
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data.items).toHaveLength(2);
      expect(response.body.data.meta).toMatchObject({
        page: 1,
        pageSize: 20,
        totalItems: 2,
        totalPages: 1,
      });
    });

    it('should support pagination', async () => {
      const user = await createMockTestUser(context);

      context.prismaMock.storageObject.findMany.mockResolvedValue([]);
      context.prismaMock.storageObject.count.mockResolvedValue(50);

      const response = await request(context.app.getHttpServer())
        .get('/api/storage/objects?page=2&pageSize=10')
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data.meta).toMatchObject({
        page: 2,
        pageSize: 10,
        totalItems: 50,
        totalPages: 5,
      });
    });

    it('should filter by status', async () => {
      const user = await createMockTestUser(context);

      context.prismaMock.storageObject.findMany.mockResolvedValue([
        { ...mockStorageObject, uploadedById: user.id, status: 'ready' },
      ]);
      context.prismaMock.storageObject.count.mockResolvedValue(1);

      const response = await request(context.app.getHttpServer())
        .get('/api/storage/objects?status=ready')
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data.items).toHaveLength(1);
    });
  });

  describe('GET /api/storage/objects/:id', () => {
    it('should return object metadata', async () => {
      const user = await createMockTestUser(context);

      context.prismaMock.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        uploadedById: user.id,
      });

      const response = await request(context.app.getHttpServer())
        .get(`/api/storage/objects/${mockStorageObjectId}`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data).toMatchObject({
        id: mockStorageObjectId,
        name: mockStorageObject.name,
        mimeType: mockStorageObject.mimeType,
      });
    });

    it('should return 404 for non-existent object', async () => {
      const user = await createMockTestUser(context);

      context.prismaMock.storageObject.findUnique.mockResolvedValue(null);

      await request(context.app.getHttpServer())
        .get('/api/storage/objects/550e8400-e29b-41d4-a716-446655440001')
        .set(authHeader(user.accessToken))
        .expect(404);
    });
  });

  describe('GET /api/storage/objects/:id/download', () => {
    it('should return signed download URL', async () => {
      const user = await createMockTestUser(context);

      context.prismaMock.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        uploadedById: user.id,
        status: 'ready',
      });
      mockStorageProvider.getSignedDownloadUrl.mockResolvedValue(
        'https://signed-url.com/download',
      );

      const response = await request(context.app.getHttpServer())
        .get(`/api/storage/objects/${mockStorageObjectId}/download`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data).toMatchObject({
        url: 'https://signed-url.com/download',
        expiresIn: expect.any(Number),
      });
    });

    it('should return 400 for non-ready objects', async () => {
      const user = await createMockTestUser(context);

      context.prismaMock.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        uploadedById: user.id,
        status: 'processing',
      });

      await request(context.app.getHttpServer())
        .get(`/api/storage/objects/${mockStorageObjectId}/download`)
        .set(authHeader(user.accessToken))
        .expect(400);
    });
  });

  describe('DELETE /api/storage/objects/:id', () => {
    it('should delete object', async () => {
      const user = await createMockTestUser(context);

      context.prismaMock.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        uploadedById: user.id,
      });
      mockStorageProvider.delete.mockResolvedValue(undefined);
      context.prismaMock.storageObject.delete.mockResolvedValue({});
      context.prismaMock.auditEvent.create.mockResolvedValue({});

      await request(context.app.getHttpServer())
        .delete(`/api/storage/objects/${mockStorageObjectId}`)
        .set(authHeader(user.accessToken))
        .expect(204);
    });

    it('should return 404 for non-existent object', async () => {
      const user = await createMockTestUser(context);

      context.prismaMock.storageObject.findUnique.mockResolvedValue(null);

      await request(context.app.getHttpServer())
        .delete('/api/storage/objects/550e8400-e29b-41d4-a716-446655440001')
        .set(authHeader(user.accessToken))
        .expect(404);
    });
  });

  describe('PATCH /api/storage/objects/:id/metadata', () => {
    it('should update metadata', async () => {
      const user = await createMockTestUser(context);

      const newMetadata = {
        custom: 'value',
        tags: ['tag1', 'tag2'],
      };

      context.prismaMock.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        uploadedById: user.id,
        metadata: { existing: 'data' },
      });
      context.prismaMock.storageObject.update.mockResolvedValue({
        ...mockStorageObject,
        uploadedById: user.id,
        metadata: { existing: 'data', ...newMetadata },
      });
      context.prismaMock.auditEvent.create.mockResolvedValue({});

      const response = await request(context.app.getHttpServer())
        .patch(`/api/storage/objects/${mockStorageObjectId}/metadata`)
        .set(authHeader(user.accessToken))
        .send({ metadata: newMetadata })
        .expect(200);

      expect(response.body.data.metadata).toMatchObject({
        existing: 'data',
        custom: 'value',
      });
    });

    it('should merge with existing metadata', async () => {
      const user = await createMockTestUser(context);

      context.prismaMock.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        uploadedById: user.id,
        metadata: { key1: 'value1' },
      });
      context.prismaMock.storageObject.update.mockResolvedValue({
        ...mockStorageObject,
        uploadedById: user.id,
        metadata: { key1: 'value1', key2: 'value2' },
      });
      context.prismaMock.auditEvent.create.mockResolvedValue({});

      await request(context.app.getHttpServer())
        .patch(`/api/storage/objects/${mockStorageObjectId}/metadata`)
        .set(authHeader(user.accessToken))
        .send({ metadata: { key2: 'value2' } })
        .expect(200);
    });
  });

  describe('Authentication', () => {
    it('should require authentication for all endpoints', async () => {
      // Test key endpoints without auth
      await request(context.app.getHttpServer())
        .get('/api/storage/objects')
        .expect(401);

      await request(context.app.getHttpServer())
        .post('/api/storage/objects/upload/init')
        .send({
          name: 'test.pdf',
          size: 1024000,
          mimeType: 'application/pdf',
        })
        .expect(401);

      await request(context.app.getHttpServer())
        .get(`/api/storage/objects/${mockStorageObjectId}`)
        .expect(401);

      await request(context.app.getHttpServer())
        .delete(`/api/storage/objects/${mockStorageObjectId}`)
        .expect(401);
    });
  });

  describe('Ownership validation', () => {
    it('should enforce ownership across all operations', async () => {
      const user = await createMockTestUser(context);
      const otherUserId = 'other-user-456';

      // Mock object owned by another user
      const otherUserObject = {
        ...mockStorageObject,
        uploadedById: otherUserId,
      };

      context.prismaMock.storageObject.findUnique.mockResolvedValue(otherUserObject);

      // Test various endpoints
      await request(context.app.getHttpServer())
        .get(`/api/storage/objects/${mockStorageObjectId}`)
        .set(authHeader(user.accessToken))
        .expect(403);

      await request(context.app.getHttpServer())
        .get(`/api/storage/objects/${mockStorageObjectId}/download`)
        .set(authHeader(user.accessToken))
        .expect(403);

      await request(context.app.getHttpServer())
        .delete(`/api/storage/objects/${mockStorageObjectId}`)
        .set(authHeader(user.accessToken))
        .expect(403);

      await request(context.app.getHttpServer())
        .patch(`/api/storage/objects/${mockStorageObjectId}/metadata`)
        .set(authHeader(user.accessToken))
        .send({ metadata: { key: 'value' } })
        .expect(403);
    });
  });
});
