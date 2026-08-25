import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Inject } from '@nestjs/common';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';

import { PrismaService } from '../../prisma/prisma.service';
import { Prisma } from '@prisma/client';
import { STORAGE_PROVIDER } from '../providers/storage-provider.interface';
import type { StorageProvider } from '../providers/storage-provider.interface';
import { InitUploadDto, InitUploadResponseDto } from './dto/init-upload.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import {
  ObjectResponseDto,
  UploadStatusResponseDto,
} from './dto/object-response.dto';
import {
  ObjectListQueryDto,
  ObjectListResponseDto,
} from './dto/object-list-query.dto';
import { UpdateMetadataDto } from './dto/update-metadata.dto';
import { DownloadUrlResponseDto } from './dto/download-url-response.dto';
import {
  OBJECT_UPLOADED_EVENT,
  ObjectUploadedEvent,
} from '../processing/events/object-uploaded.event';

export interface MultipartFile {
  filename: string;
  mimetype: string;
  file: Readable;
}

@Injectable()
export class ObjectsService {
  private readonly logger = new Logger(ObjectsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE_PROVIDER)
    private readonly storageProvider: StorageProvider,
    private readonly config: ConfigService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Initialize a resumable multipart upload
   */
  async initUpload(
    dto: InitUploadDto,
    userId: string,
  ): Promise<InitUploadResponseDto> {
    const { name, size, mimeType } = dto;

    // Get configuration
    const partSize = this.config.get<number>('storage.partSize', 10485760); // 10MB default
    const minPartSize = 5 * 1024 * 1024; // 5MB S3 minimum

    // Validate part size
    if (partSize < minPartSize) {
      throw new BadRequestException(
        `Part size must be at least ${minPartSize} bytes`,
      );
    }

    // Calculate total parts
    const totalParts = Math.ceil(size / partSize);

    if (totalParts > 10000) {
      throw new BadRequestException(
        'File too large for multipart upload (exceeds 10,000 parts)',
      );
    }

    // Generate storage key
    const timestamp = Date.now();
    const uuid = randomUUID();
    const extension = extname(name);
    const storageKey = `uploads/${timestamp}/${uuid}${extension}`;

    this.logger.log(`Initializing upload for ${name}, ${totalParts} parts`);

    // Initialize multipart upload with storage provider
    const { uploadId } = await this.storageProvider.initMultipartUpload(
      storageKey,
      { mimeType },
    );

    // Create StorageObject record
    const storageObject = await this.prisma.storageObject.create({
      data: {
        name,
        size: BigInt(size),
        mimeType,
        storageKey,
        storageProvider: 's3',
        bucket: this.storageProvider.getBucket(),
        status: 'pending',
        s3UploadId: uploadId,
        uploadedById: userId,
      },
    });

    // Generate presigned URLs for first batch (up to 10 parts)
    const urlBatchSize = Math.min(10, totalParts);
    const presignedUrls = await Promise.all(
      Array.from({ length: urlBatchSize }, (_, i) => i + 1).map(
        async (partNumber) => ({
          partNumber,
          url: await this.storageProvider.getSignedUploadUrl(
            storageKey,
            uploadId,
            partNumber,
          ),
        }),
      ),
    );

    this.logger.log(
      `Upload initialized: ${storageObject.id}, uploadId: ${uploadId}`,
    );

    return {
      objectId: storageObject.id,
      uploadId,
      partSize,
      totalParts,
      presignedUrls,
    };
  }

  /**
   * Get upload status and progress
   */
  async getUploadStatus(
    objectId: string,
    userId: string,
  ): Promise<UploadStatusResponseDto> {
    const storageObject = await this.prisma.storageObject.findUnique({
      where: { id: objectId },
      include: { chunks: true },
    });

    if (!storageObject) {
      throw new NotFoundException('Upload not found');
    }

    // Check ownership
    if (storageObject.uploadedById !== userId) {
      throw new ForbiddenException('You do not own this upload');
    }

    const uploadedParts = storageObject.chunks
      .map((chunk) => chunk.partNumber)
      .sort((a, b) => a - b);

    const uploadedBytes = storageObject.chunks.reduce(
      (sum, chunk) => sum + chunk.size,
      BigInt(0),
    );

    const partSize = this.config.get<number>('storage.partSize', 10485760);
    const totalParts = Math.ceil(Number(storageObject.size) / partSize);

    return {
      objectId: storageObject.id,
      status: storageObject.status,
      uploadedParts,
      totalParts,
      uploadedBytes: uploadedBytes.toString(),
      totalBytes: storageObject.size.toString(),
    };
  }

  /**
   * Complete multipart upload
   */
  async completeUpload(
    objectId: string,
    dto: CompleteUploadDto,
    userId: string,
  ): Promise<ObjectResponseDto> {
    const storageObject = await this.prisma.storageObject.findUnique({
      where: { id: objectId },
      include: { chunks: true },
    });

    if (!storageObject) {
      throw new NotFoundException('Upload not found');
    }

    // Check ownership
    if (storageObject.uploadedById !== userId) {
      throw new ForbiddenException('You do not own this upload');
    }

    if (!storageObject.s3UploadId) {
      throw new BadRequestException('Upload ID not found');
    }

    const { parts } = dto;

    this.logger.log(`Completing upload ${objectId} with ${parts.length} parts`);

    // Record chunks in database
    await Promise.all(
      parts.map((part) =>
        this.prisma.storageObjectChunk.upsert({
          where: {
            objectId_partNumber: {
              objectId,
              partNumber: part.partNumber,
            },
          },
          create: {
            objectId,
            partNumber: part.partNumber,
            eTag: part.eTag,
            size: BigInt(0), // We don't know exact part size from client
          },
          update: {
            eTag: part.eTag,
          },
        }),
      ),
    );

    // Complete upload with storage provider
    await this.storageProvider.completeMultipartUpload(
      storageObject.storageKey,
      storageObject.s3UploadId,
      parts,
    );

    // Update status to processing
    const updated = await this.prisma.storageObject.update({
      where: { id: objectId },
      data: { status: 'processing' },
    });

    // Emit event for post-processing
    this.eventEmitter.emit(
      OBJECT_UPLOADED_EVENT,
      new ObjectUploadedEvent(updated),
    );

    // Create audit event
    await this.createAuditEvent(userId, 'storage:upload:complete', objectId, {
      name: updated.name,
      size: updated.size.toString(),
      mimeType: updated.mimeType,
      partsCount: parts.length,
    });

    this.logger.log(`Upload completed: ${objectId}`);

    return this.mapToResponseDto(updated);
  }

  /**
   * Abort multipart upload
   */
  async abortUpload(objectId: string, userId: string): Promise<void> {
    const storageObject = await this.prisma.storageObject.findUnique({
      where: { id: objectId },
    });

    if (!storageObject) {
      throw new NotFoundException('Upload not found');
    }

    // Check ownership
    if (storageObject.uploadedById !== userId) {
      throw new ForbiddenException('You do not own this upload');
    }

    if (!storageObject.s3UploadId) {
      throw new BadRequestException('Upload ID not found');
    }

    this.logger.log(`Aborting upload ${objectId}`);

    // Abort with storage provider
    await this.storageProvider.abortMultipartUpload(
      storageObject.storageKey,
      storageObject.s3UploadId,
    );

    // Delete database records
    await this.prisma.storageObject.delete({
      where: { id: objectId },
    });

    // Create audit event
    await this.createAuditEvent(userId, 'storage:upload:abort', objectId, {
      name: storageObject.name,
      status: storageObject.status,
    });

    this.logger.log(`Upload aborted: ${objectId}`);
  }

  /**
   * Simple upload for smaller files
   */
  async simpleUpload(
    file: MultipartFile,
    userId: string,
  ): Promise<ObjectResponseDto> {
    const { filename, mimetype, file: stream } = file;

    // Generate storage key
    const timestamp = Date.now();
    const uuid = randomUUID();
    const extension = extname(filename);
    const storageKey = `uploads/${timestamp}/${uuid}${extension}`;

    this.logger.log(`Simple upload starting: ${filename}`);

    // Upload to storage
    const result = await this.storageProvider.upload(storageKey, stream, {
      mimeType: mimetype,
    });

    // We don't know the size until after upload for streams
    // Use a default size of 0, should be updated in post-processing
    const storageObject = await this.prisma.storageObject.create({
      data: {
        name: filename,
        size: BigInt(0), // Will be updated by post-processing
        mimeType: mimetype,
        storageKey,
        storageProvider: 's3',
        bucket: result.bucket,
        status: 'processing',
        uploadedById: userId,
      },
    });

    // Emit event for post-processing
    this.eventEmitter.emit(
      OBJECT_UPLOADED_EVENT,
      new ObjectUploadedEvent(storageObject),
    );

    // Create audit event
    await this.createAuditEvent(
      userId,
      'storage:upload:complete',
      storageObject.id,
      {
        name: storageObject.name,
        mimeType: storageObject.mimeType,
        uploadType: 'simple',
      },
    );

    this.logger.log(`Simple upload completed: ${storageObject.id}`);

    return this.mapToResponseDto(storageObject);
  }

  /**
   * List user's objects with pagination and filtering
   */
  async list(
    query: ObjectListQueryDto,
    userId: string,
  ): Promise<ObjectListResponseDto> {
    const { page, pageSize, status, sortBy, sortOrder } = query;

    const skip = (page - 1) * pageSize;
    const take = pageSize;

    const where = {
      uploadedById: userId,
      ...(status && { status }),
    };

    // Build orderBy clause
    const orderBy: Prisma.StorageObjectOrderByWithRelationInput = {};
    if (sortBy === 'createdAt') {
      orderBy.createdAt = sortOrder;
    } else if (sortBy === 'name') {
      orderBy.name = sortOrder;
    } else if (sortBy === 'size') {
      orderBy.size = sortOrder;
    }

    const [items, totalItems] = await Promise.all([
      this.prisma.storageObject.findMany({
        where,
        orderBy,
        skip,
        take,
      }),
      this.prisma.storageObject.count({ where }),
    ]);

    const totalPages = Math.ceil(totalItems / pageSize);

    return {
      items: items.map((item) => this.mapToResponseDto(item)),
      meta: {
        page,
        pageSize,
        totalItems,
        totalPages,
      },
    };
  }

  /**
   * Get object by ID with ownership check
   */
  async getById(id: string, userId: string): Promise<ObjectResponseDto> {
    const object = await this.getObjectWithAuthCheck(id, userId);
    return this.mapToResponseDto(object);
  }

  /**
   * Get signed download URL for an object
   */
  async getDownloadUrl(
    id: string,
    userId: string,
    expiresIn?: number,
  ): Promise<DownloadUrlResponseDto> {
    const object = await this.getObjectWithAuthCheck(id, userId);

    // Verify status is ready
    if (object.status !== 'ready') {
      throw new BadRequestException(
        `Object is not ready for download. Current status: ${object.status}`,
      );
    }

    const defaultExpiry = this.config.get<number>(
      'storage.signedUrlExpiry',
      3600,
    );
    const expiry = expiresIn || defaultExpiry;

    const url = await this.storageProvider.getSignedDownloadUrl(
      object.storageKey,
      { expiresIn: expiry },
    );

    this.logger.log(
      `Generated download URL for object ${id}, expires in ${expiry}s`,
    );

    return {
      url,
      expiresIn: expiry,
    };
  }

  /**
   * Delete object from storage and database
   */
  async delete(id: string, userId: string): Promise<void> {
    const object = await this.getObjectWithAuthCheck(id, userId);

    this.logger.log(`Deleting object ${id} from storage and database`);

    // Delete from storage provider
    await this.storageProvider.delete(object.storageKey);

    // Delete from database (cascade deletes chunks)
    await this.prisma.storageObject.delete({
      where: { id },
    });

    // Create audit event
    await this.createAuditEvent(userId, 'storage:object:delete', id, {
      name: object.name,
      size: object.size.toString(),
      mimeType: object.mimeType,
    });

    this.logger.log(`Object deleted: ${id}`);
  }

  /**
   * Update object metadata
   */
  async updateMetadata(
    id: string,
    dto: UpdateMetadataDto,
    userId: string,
  ): Promise<ObjectResponseDto> {
    const object = await this.getObjectWithAuthCheck(id, userId);

    // Merge new metadata with existing
    const existingMetadata = (object.metadata as Record<string, unknown>) || {};
    const mergedMetadata = {
      ...existingMetadata,
      ...dto.metadata,
    };

    // Update in database
    const updated = await this.prisma.storageObject.update({
      where: { id },
      data: { metadata: mergedMetadata as Prisma.InputJsonValue },
    });

    // Create audit event
    await this.createAuditEvent(userId, 'storage:object:metadata:update', id, {
      name: object.name,
      metadataChanges: dto.metadata,
    });

    this.logger.log(`Updated metadata for object ${id}`);

    return this.mapToResponseDto(updated);
  }

  /**
   * Helper method to get object with ownership check
   * @private
   */
  private async getObjectWithAuthCheck(
    id: string,
    userId: string,
  ): Promise<any> {
    const object = await this.prisma.storageObject.findUnique({
      where: { id },
    });

    if (!object) {
      throw new NotFoundException('Object not found');
    }

    // Check ownership
    if (object.uploadedById !== userId) {
      throw new ForbiddenException('You do not have access to this object');
    }

    return object;
  }

  /**
   * Map Prisma model to response DTO
   */
  private mapToResponseDto(obj: any): ObjectResponseDto {
    return {
      id: obj.id,
      name: obj.name,
      size: obj.size.toString(),
      mimeType: obj.mimeType,
      status: obj.status,
      metadata: obj.metadata as Record<string, unknown> | null,
      createdAt: obj.createdAt.toISOString(),
      updatedAt: obj.updatedAt.toISOString(),
    };
  }

  /**
   * Create audit event for storage operations
   */
  private async createAuditEvent(
    userId: string,
    action: string,
    objectId: string,
    meta?: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.auditEvent.create({
      data: {
        actorUserId: userId,
        action,
        targetType: 'storage_object',
        targetId: objectId,
        meta: (meta ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
  }
}
