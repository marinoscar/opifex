import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { Readable } from 'node:stream';

import { ObjectsService } from './objects.service';
import { PrismaService } from '../../prisma/prisma.service';
import { STORAGE_PROVIDER } from '../providers/storage-provider.interface';
import {
  createMockPrismaService,
  MockPrismaService,
} from '../../../test/mocks/prisma.mock';
import { createMockStorageProvider } from '../../../test/mocks/storage-provider.mock';
import { OBJECT_UPLOADED_EVENT } from '../processing/events/object-uploaded.event';

describe('ObjectsService', () => {
  let service: ObjectsService;
  let mockPrisma: MockPrismaService;
  let mockStorageProvider: ReturnType<typeof createMockStorageProvider>;
  let mockConfig: jest.Mocked<ConfigService>;
  let mockEventEmitter: jest.Mocked<EventEmitter2>;

  const testUserId = 'user-123';
  const otherUserId = 'user-456';

  const mockStorageObject = {
    id: 'obj-123',
    name: 'test-file.pdf',
    size: BigInt(1024000),
    mimeType: 'application/pdf',
    storageKey: 'uploads/123456/uuid-123.pdf',
    storageProvider: 's3',
    bucket: 'test-bucket',
    status: 'ready',
    s3UploadId: null,
    uploadedById: testUserId,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
    mockStorageProvider = createMockStorageProvider();
    mockConfig = {
      get: jest.fn(),
    } as any;
    mockEventEmitter = {
      emit: jest.fn(),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ObjectsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: STORAGE_PROVIDER, useValue: mockStorageProvider },
        { provide: ConfigService, useValue: mockConfig },
        { provide: EventEmitter2, useValue: mockEventEmitter },
      ],
    }).compile();

    service = module.get<ObjectsService>(ObjectsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('initUpload', () => {
    it('should create object record and return presigned URLs', async () => {
      const dto = {
        name: 'test.pdf',
        size: 52428800, // 50MB
        mimeType: 'application/pdf',
      };

      mockConfig.get.mockReturnValue(10485760); // 10MB part size
      mockStorageProvider.initMultipartUpload.mockResolvedValue({
        uploadId: 'upload-123',
        key: 'uploads/123/uuid.pdf',
      });
      mockStorageProvider.getBucket.mockReturnValue('test-bucket');
      mockPrisma.storageObject.create.mockResolvedValue({
        ...mockStorageObject,
        id: 'new-obj-id',
        name: dto.name,
        size: BigInt(dto.size),
        status: 'pending',
        s3UploadId: 'upload-123',
      } as any);

      const result = await service.initUpload(dto, testUserId);

      expect(result.objectId).toBe('new-obj-id');
      expect(result.uploadId).toBe('upload-123');
      expect(result.partSize).toBe(10485760);
      expect(result.totalParts).toBe(5); // 50MB / 10MB
      expect(result.presignedUrls).toHaveLength(5); // First batch up to 10
      expect(mockStorageProvider.initMultipartUpload).toHaveBeenCalled();
      expect(mockPrisma.storageObject.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            name: dto.name,
            size: BigInt(dto.size),
            mimeType: dto.mimeType,
            status: 'pending',
            s3UploadId: 'upload-123',
            uploadedById: testUserId,
          }),
        }),
      );
    });

    it('should calculate correct part count for large files', async () => {
      const dto = {
        name: 'large.zip',
        size: 104857600, // 100MB
        mimeType: 'application/zip',
      };

      mockConfig.get.mockReturnValue(10485760); // 10MB part size
      mockStorageProvider.initMultipartUpload.mockResolvedValue({
        uploadId: 'upload-456',
        key: 'uploads/456/uuid.zip',
      });
      mockStorageProvider.getBucket.mockReturnValue('test-bucket');
      mockPrisma.storageObject.create.mockResolvedValue({
        ...mockStorageObject,
        id: 'new-obj-id',
      } as any);

      const result = await service.initUpload(dto, testUserId);

      expect(result.totalParts).toBe(10); // 100MB / 10MB
      expect(result.presignedUrls).toHaveLength(10); // First batch of 10
    });

    it('should generate unique storage key with timestamp and UUID', async () => {
      const dto = {
        name: 'test.pdf',
        size: 10485760,
        mimeType: 'application/pdf',
      };

      mockConfig.get.mockReturnValue(10485760);
      mockStorageProvider.initMultipartUpload.mockResolvedValue({
        uploadId: 'upload-789',
        key: 'test-key',
      });
      mockStorageProvider.getBucket.mockReturnValue('test-bucket');
      mockPrisma.storageObject.create.mockResolvedValue({
        ...mockStorageObject,
      } as any);

      await service.initUpload(dto, testUserId);

      expect(mockPrisma.storageObject.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            storageKey: expect.stringMatching(
              /^uploads\/\d+\/[a-f0-9-]+\.pdf$/,
            ),
          }),
        }),
      );
    });

    it('should throw BadRequestException for files exceeding 10,000 parts', async () => {
      const dto = {
        name: 'huge.dat',
        size: 524288000000, // 500GB
        mimeType: 'application/octet-stream',
      };

      mockConfig.get.mockReturnValue(10485760); // 10MB part size
      // 500GB / 10MB = 50,000 parts > 10,000 limit

      await expect(service.initUpload(dto, testUserId)).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.initUpload(dto, testUserId)).rejects.toThrow(
        'File too large for multipart upload',
      );
    });

    it('should call storage provider initMultipartUpload', async () => {
      const dto = {
        name: 'test.pdf',
        size: 10485760,
        mimeType: 'application/pdf',
      };

      mockConfig.get.mockReturnValue(10485760);
      mockStorageProvider.initMultipartUpload.mockResolvedValue({
        uploadId: 'upload-123',
        key: 'test-key',
      });
      mockStorageProvider.getBucket.mockReturnValue('test-bucket');
      mockPrisma.storageObject.create.mockResolvedValue({
        ...mockStorageObject,
      } as any);

      await service.initUpload(dto, testUserId);

      expect(mockStorageProvider.initMultipartUpload).toHaveBeenCalledWith(
        expect.stringMatching(/^uploads\//),
        expect.objectContaining({
          mimeType: dto.mimeType,
        }),
      );
    });
  });

  describe('getUploadStatus', () => {
    it('should return upload status with chunk info', async () => {
      const chunks = [
        { partNumber: 1, size: BigInt(10485760), eTag: 'etag1' },
        { partNumber: 2, size: BigInt(10485760), eTag: 'etag2' },
        { partNumber: 3, size: BigInt(5242880), eTag: 'etag3' },
      ];

      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        status: 'pending',
        size: BigInt(26214400), // ~25MB - matches totalBytes expectation
        chunks,
      } as any);
      mockConfig.get.mockReturnValue(10485760); // 10MB part size

      const result = await service.getUploadStatus(
        mockStorageObject.id,
        testUserId,
      );

      expect(result.objectId).toBe(mockStorageObject.id);
      expect(result.status).toBe('pending');
      expect(result.uploadedParts).toEqual([1, 2, 3]);
      expect(result.totalParts).toBe(3);
      expect(result.uploadedBytes).toBe('26214400');
      expect(result.totalBytes).toBe('26214400'); // Updated to match mock size
    });

    it('should throw NotFoundException for non-existent object', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue(null);

      await expect(
        service.getUploadStatus('non-existent', testUserId),
      ).rejects.toThrow(NotFoundException);
      await expect(
        service.getUploadStatus('non-existent', testUserId),
      ).rejects.toThrow('Upload not found');
    });

    it('should throw ForbiddenException for non-owner', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        uploadedById: otherUserId,
        chunks: [],
      } as any);

      await expect(
        service.getUploadStatus(mockStorageObject.id, testUserId),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        service.getUploadStatus(mockStorageObject.id, testUserId),
      ).rejects.toThrow('You do not own this upload');
    });
  });

  describe('completeUpload', () => {
    it('should complete multipart upload and update status', async () => {
      const dto = {
        parts: [
          { partNumber: 1, eTag: 'etag1' },
          { partNumber: 2, eTag: 'etag2' },
        ],
      };

      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        status: 'pending',
        s3UploadId: 'upload-123',
        chunks: [],
      } as any);
      mockPrisma.storageObjectChunk.upsert.mockResolvedValue({} as any);
      mockStorageProvider.completeMultipartUpload.mockResolvedValue({
        key: mockStorageObject.storageKey,
        bucket: 'test-bucket',
        location: 's3://test-bucket/key',
        eTag: 'final-etag',
      });
      mockPrisma.storageObject.update.mockResolvedValue({
        ...mockStorageObject,
        status: 'processing',
      } as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      const result = await service.completeUpload(
        mockStorageObject.id,
        dto,
        testUserId,
      );

      expect(result.status).toBe('processing');
      expect(mockStorageProvider.completeMultipartUpload).toHaveBeenCalledWith(
        mockStorageObject.storageKey,
        'upload-123',
        dto.parts,
      );
      expect(mockPrisma.storageObject.update).toHaveBeenCalledWith({
        where: { id: mockStorageObject.id },
        data: { status: 'processing' },
      });
    });

    it('should emit ObjectUploadedEvent', async () => {
      const dto = {
        parts: [{ partNumber: 1, eTag: 'etag1' }],
      };

      const updatedObject = {
        ...mockStorageObject,
        status: 'processing',
      };

      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        s3UploadId: 'upload-123',
        chunks: [],
      } as any);
      mockPrisma.storageObjectChunk.upsert.mockResolvedValue({} as any);
      mockStorageProvider.completeMultipartUpload.mockResolvedValue({
        key: 'key',
        bucket: 'bucket',
        location: 's3://bucket/key',
      });
      mockPrisma.storageObject.update.mockResolvedValue(updatedObject as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      await service.completeUpload(mockStorageObject.id, dto, testUserId);

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        OBJECT_UPLOADED_EVENT,
        expect.objectContaining({
          object: updatedObject,
        }),
      );
    });

    it('should create audit event', async () => {
      const dto = {
        parts: [{ partNumber: 1, eTag: 'etag1' }],
      };

      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        s3UploadId: 'upload-123',
        chunks: [],
      } as any);
      mockPrisma.storageObjectChunk.upsert.mockResolvedValue({} as any);
      mockStorageProvider.completeMultipartUpload.mockResolvedValue({
        key: 'key',
        bucket: 'bucket',
        location: 's3://bucket/key',
      });
      mockPrisma.storageObject.update.mockResolvedValue({
        ...mockStorageObject,
        status: 'processing',
      } as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      await service.completeUpload(mockStorageObject.id, dto, testUserId);

      expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          actorUserId: testUserId,
          action: 'storage:upload:complete',
          targetType: 'storage_object',
          targetId: mockStorageObject.id,
          meta: expect.objectContaining({
            partsCount: 1,
          }),
        }),
      });
    });

    it('should throw NotFoundException for non-existent object', async () => {
      const dto = {
        parts: [{ partNumber: 1, eTag: 'etag1' }],
      };

      mockPrisma.storageObject.findUnique.mockResolvedValue(null);

      await expect(
        service.completeUpload('non-existent', dto, testUserId),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw ForbiddenException for non-owner', async () => {
      const dto = {
        parts: [{ partNumber: 1, eTag: 'etag1' }],
      };

      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        uploadedById: otherUserId,
        s3UploadId: 'upload-123',
        chunks: [],
      } as any);

      await expect(
        service.completeUpload(mockStorageObject.id, dto, testUserId),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw BadRequestException when uploadId is missing', async () => {
      const dto = {
        parts: [{ partNumber: 1, eTag: 'etag1' }],
      };

      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        s3UploadId: null,
        chunks: [],
      } as any);

      await expect(
        service.completeUpload(mockStorageObject.id, dto, testUserId),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.completeUpload(mockStorageObject.id, dto, testUserId),
      ).rejects.toThrow('Upload ID not found');
    });
  });

  describe('abortUpload', () => {
    it('should abort upload and delete records', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        s3UploadId: 'upload-123',
      } as any);
      mockStorageProvider.abortMultipartUpload.mockResolvedValue(undefined);
      mockPrisma.storageObject.delete.mockResolvedValue({} as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      await service.abortUpload(mockStorageObject.id, testUserId);

      expect(mockStorageProvider.abortMultipartUpload).toHaveBeenCalledWith(
        mockStorageObject.storageKey,
        'upload-123',
      );
      expect(mockPrisma.storageObject.delete).toHaveBeenCalledWith({
        where: { id: mockStorageObject.id },
      });
    });

    it('should call storage provider abortMultipartUpload', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        s3UploadId: 'upload-123',
      } as any);
      mockStorageProvider.abortMultipartUpload.mockResolvedValue(undefined);
      mockPrisma.storageObject.delete.mockResolvedValue({} as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      await service.abortUpload(mockStorageObject.id, testUserId);

      expect(mockStorageProvider.abortMultipartUpload).toHaveBeenCalledWith(
        mockStorageObject.storageKey,
        'upload-123',
      );
    });

    it('should create audit event', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        s3UploadId: 'upload-123',
      } as any);
      mockStorageProvider.abortMultipartUpload.mockResolvedValue(undefined);
      mockPrisma.storageObject.delete.mockResolvedValue({} as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      await service.abortUpload(mockStorageObject.id, testUserId);

      expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          actorUserId: testUserId,
          action: 'storage:upload:abort',
          targetType: 'storage_object',
          targetId: mockStorageObject.id,
        }),
      });
    });

    it('should throw NotFoundException for non-existent object', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue(null);

      await expect(
        service.abortUpload('non-existent', testUserId),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw ForbiddenException for non-owner', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        uploadedById: otherUserId,
        s3UploadId: 'upload-123',
      } as any);

      await expect(
        service.abortUpload(mockStorageObject.id, testUserId),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('simpleUpload', () => {
    it('should upload file and create record', async () => {
      const file = {
        filename: 'test.txt',
        mimetype: 'text/plain',
        file: Readable.from(['test content']),
      };

      mockStorageProvider.upload.mockResolvedValue({
        key: 'uploads/123/uuid.txt',
        bucket: 'test-bucket',
        location: 's3://test-bucket/uploads/123/uuid.txt',
        eTag: 'etag123',
      });
      mockPrisma.storageObject.create.mockResolvedValue({
        ...mockStorageObject,
        name: file.filename,
        mimeType: file.mimetype,
        status: 'processing',
      } as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      const result = await service.simpleUpload(file, testUserId);

      expect(result.name).toBe(file.filename);
      expect(result.mimeType).toBe(file.mimetype);
      expect(result.status).toBe('processing');
      expect(mockStorageProvider.upload).toHaveBeenCalled();
    });

    it('should emit ObjectUploadedEvent', async () => {
      const file = {
        filename: 'test.txt',
        mimetype: 'text/plain',
        file: Readable.from(['test content']),
      };

      const createdObject = {
        ...mockStorageObject,
        status: 'processing',
      };

      mockStorageProvider.upload.mockResolvedValue({
        key: 'key',
        bucket: 'bucket',
        location: 's3://bucket/key',
      });
      mockPrisma.storageObject.create.mockResolvedValue(createdObject as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      await service.simpleUpload(file, testUserId);

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        OBJECT_UPLOADED_EVENT,
        expect.objectContaining({
          object: createdObject,
        }),
      );
    });

    it('should create audit event', async () => {
      const file = {
        filename: 'test.txt',
        mimetype: 'text/plain',
        file: Readable.from(['test content']),
      };

      mockStorageProvider.upload.mockResolvedValue({
        key: 'key',
        bucket: 'bucket',
        location: 's3://bucket/key',
      });
      mockPrisma.storageObject.create.mockResolvedValue({
        ...mockStorageObject,
        id: 'new-id',
      } as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      await service.simpleUpload(file, testUserId);

      expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          actorUserId: testUserId,
          action: 'storage:upload:complete',
          targetType: 'storage_object',
          targetId: 'new-id',
          meta: expect.objectContaining({
            uploadType: 'simple',
          }),
        }),
      });
    });
  });

  describe('list', () => {
    it('should return paginated results', async () => {
      const query = {
        page: 1,
        pageSize: 20,
        sortBy: 'createdAt' as const,
        sortOrder: 'desc' as const,
      };

      const mockObjects = [
        { ...mockStorageObject, id: 'obj-1' },
        { ...mockStorageObject, id: 'obj-2' },
      ];

      mockPrisma.storageObject.findMany.mockResolvedValue(mockObjects as any);
      mockPrisma.storageObject.count.mockResolvedValue(2);

      const result = await service.list(query, testUserId);

      expect(result.items).toHaveLength(2);
      expect(result.meta.page).toBe(1);
      expect(result.meta.pageSize).toBe(20);
      expect(result.meta.totalItems).toBe(2);
      expect(result.meta.totalPages).toBe(1);
    });

    it('should filter by status', async () => {
      const query = {
        page: 1,
        pageSize: 20,
        status: 'ready' as const,
        sortBy: 'createdAt' as const,
        sortOrder: 'desc' as const,
      };

      mockPrisma.storageObject.findMany.mockResolvedValue([
        mockStorageObject,
      ] as any);
      mockPrisma.storageObject.count.mockResolvedValue(1);

      await service.list(query, testUserId);

      expect(mockPrisma.storageObject.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: 'ready',
          }),
        }),
      );
    });

    it('should sort by specified field', async () => {
      const query = {
        page: 1,
        pageSize: 20,
        sortBy: 'name' as const,
        sortOrder: 'asc' as const,
      };

      mockPrisma.storageObject.findMany.mockResolvedValue([]);
      mockPrisma.storageObject.count.mockResolvedValue(0);

      await service.list(query, testUserId);

      expect(mockPrisma.storageObject.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: { name: 'asc' },
        }),
      );
    });
  });

  describe('getById', () => {
    it('should return object metadata', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue(
        mockStorageObject as any,
      );

      const result = await service.getById(mockStorageObject.id, testUserId);

      expect(result.id).toBe(mockStorageObject.id);
      expect(result.name).toBe(mockStorageObject.name);
    });

    it('should throw NotFoundException for non-existent object', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue(null);

      await expect(service.getById('non-existent', testUserId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw ForbiddenException for non-owner', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        uploadedById: otherUserId,
      } as any);

      await expect(
        service.getById(mockStorageObject.id, testUserId),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('getDownloadUrl', () => {
    it('should return signed URL for ready objects', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        status: 'ready',
      } as any);
      mockConfig.get.mockReturnValue(3600);
      mockStorageProvider.getSignedDownloadUrl.mockResolvedValue(
        'https://signed-url.com/download',
      );

      const result = await service.getDownloadUrl(
        mockStorageObject.id,
        testUserId,
      );

      expect(result.url).toBe('https://signed-url.com/download');
      expect(result.expiresIn).toBe(3600);
      expect(mockStorageProvider.getSignedDownloadUrl).toHaveBeenCalledWith(
        mockStorageObject.storageKey,
        { expiresIn: 3600 },
      );
    });

    it('should throw BadRequestException for non-ready objects', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        status: 'processing',
      } as any);

      await expect(
        service.getDownloadUrl(mockStorageObject.id, testUserId),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.getDownloadUrl(mockStorageObject.id, testUserId),
      ).rejects.toThrow('Object is not ready for download');
    });
  });

  describe('delete', () => {
    it('should delete from storage and database', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue(
        mockStorageObject as any,
      );
      mockStorageProvider.delete.mockResolvedValue(undefined);
      mockPrisma.storageObject.delete.mockResolvedValue({} as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      await service.delete(mockStorageObject.id, testUserId);

      expect(mockStorageProvider.delete).toHaveBeenCalledWith(
        mockStorageObject.storageKey,
      );
      expect(mockPrisma.storageObject.delete).toHaveBeenCalledWith({
        where: { id: mockStorageObject.id },
      });
    });

    it('should create audit event', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue(
        mockStorageObject as any,
      );
      mockStorageProvider.delete.mockResolvedValue(undefined);
      mockPrisma.storageObject.delete.mockResolvedValue({} as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      await service.delete(mockStorageObject.id, testUserId);

      expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          actorUserId: testUserId,
          action: 'storage:object:delete',
          targetType: 'storage_object',
          targetId: mockStorageObject.id,
        }),
      });
    });
  });

  describe('updateMetadata', () => {
    it('should merge metadata and update record', async () => {
      const existingMetadata = { key1: 'value1' };
      const newMetadata = { key2: 'value2' };

      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        metadata: existingMetadata,
      } as any);
      mockPrisma.storageObject.update.mockResolvedValue({
        ...mockStorageObject,
        metadata: { ...existingMetadata, ...newMetadata },
      } as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      await service.updateMetadata(
        mockStorageObject.id,
        { metadata: newMetadata },
        testUserId,
      );

      expect(mockPrisma.storageObject.update).toHaveBeenCalledWith({
        where: { id: mockStorageObject.id },
        data: {
          metadata: { ...existingMetadata, ...newMetadata },
        },
      });
    });

    it('should create audit event', async () => {
      const newMetadata = { key: 'value' };

      mockPrisma.storageObject.findUnique.mockResolvedValue(
        mockStorageObject as any,
      );
      mockPrisma.storageObject.update.mockResolvedValue({
        ...mockStorageObject,
        metadata: newMetadata,
      } as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      await service.updateMetadata(
        mockStorageObject.id,
        { metadata: newMetadata },
        testUserId,
      );

      expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          actorUserId: testUserId,
          action: 'storage:object:metadata:update',
          targetType: 'storage_object',
          targetId: mockStorageObject.id,
        }),
      });
    });
  });
  /**
   * #361: storage object metadata is arbitrary caller-supplied JSON, and
   * `updateMetadata` wrote it straight into `audit_events.meta`. Unlike the
   * users sink, nothing here needs a future schema change to leak — a client
   * can put a token in object metadata today.
   */
  describe('audit redaction (#361)', () => {
    const SECRET = 'sk-ant-api03-0123456789abcdefghij';

    beforeEach(() => {
      mockPrisma.storageObject.findUnique.mockResolvedValue(
        mockStorageObject as any,
      );
      mockPrisma.storageObject.update.mockResolvedValue(
        mockStorageObject as any,
      );
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);
    });

    function metaOfLastAuditEvent(): Record<string, unknown> {
      const calls = mockPrisma.auditEvent.create.mock.calls;
      expect(calls.length).toBe(1);
      return (calls[0][0] as { data: { meta: Record<string, unknown> } }).data
        .meta;
    }

    it('does not write a secret-shaped metadata value into audit_events.meta', async () => {
      await service.updateMetadata(
        mockStorageObject.id,
        { metadata: { caption: 'holiday', accessToken: SECRET } },
        testUserId,
      );

      expect(
        JSON.stringify(mockPrisma.auditEvent.create.mock.calls),
      ).not.toContain(SECRET);
    });

    it('still records which metadata keys changed', async () => {
      await service.updateMetadata(
        mockStorageObject.id,
        { metadata: { caption: 'holiday', accessToken: SECRET } },
        testUserId,
      );

      // The key survives and the sibling value survives; only the secret-named
      // value is masked. Masking `metadataChanges` wholesale would satisfy the
      // test above and destroy the row's usefulness.
      expect(metaOfLastAuditEvent()).toEqual({
        name: mockStorageObject.name,
        metadataChanges: {
          caption: 'holiday',
          accessToken: '********ghij',
        },
      });
    });

    it('masks a secret nested inside metadata', async () => {
      // Object metadata is free-form, so the secret need not be top level. A
      // top-level-only sweep would pass the assertions above and leak here.
      await service.updateMetadata(
        mockStorageObject.id,
        { metadata: { source: { kind: 's3', credentials: SECRET } } },
        testUserId,
      );

      expect(metaOfLastAuditEvent()).toEqual({
        name: mockStorageObject.name,
        metadataChanges: {
          source: { kind: 's3', credentials: '********ghij' },
        },
      });
    });

    it('leaves ordinary metadata untouched', async () => {
      await service.updateMetadata(
        mockStorageObject.id,
        { metadata: { caption: 'holiday', pages: 12 } },
        testUserId,
      );

      expect(metaOfLastAuditEvent()).toEqual({
        name: mockStorageObject.name,
        metadataChanges: { caption: 'holiday', pages: 12 },
      });
    });
  });
});
