import {
  Controller,
  Post,
  Get,
  Delete,
  Patch,
  Param,
  Body,
  Query,
  Req,
  BadRequestException,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBody,
  ApiConsumes,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { FastifyRequest } from 'fastify';
import { ZodValidationPipe } from 'nestjs-zod';

import { Auth } from '../../auth/decorators/auth.decorator';
import { ApiDataResponse } from '../../common/decorators/api-data-response.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { ObjectsService } from './objects.service';
import {
  InitUploadBodyDto,
  InitUploadDto,
  InitUploadResponseDto,
  initUploadSchema,
} from './dto/init-upload.dto';
import {
  CompleteUploadBodyDto,
  CompleteUploadDto,
  completeUploadSchema,
} from './dto/complete-upload.dto';
import {
  ObjectResponseDto,
  UploadStatusResponseDto,
} from './dto/object-response.dto';
import {
  ObjectListQueryDto,
  ObjectListResponseDto,
  objectListQuerySchema,
} from './dto/object-list-query.dto';
import {
  UpdateMetadataBodyDto,
  UpdateMetadataDto,
  updateMetadataSchema,
} from './dto/update-metadata.dto';
import { DownloadUrlResponseDto } from './dto/download-url-response.dto';

@ApiTags('Storage')
@Controller('storage/objects')
@Auth()
export class ObjectsController {
  constructor(private readonly objectsService: ObjectsService) {}

  /**
   * List user's storage objects
   */
  @Get()
  @ApiOperation({
    summary: 'List storage objects',
    description:
      "Get paginated list of user's storage objects with filtering and sorting",
  })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    description: 'Page number (default: 1)',
  })
  @ApiQuery({
    name: 'pageSize',
    required: false,
    type: Number,
    description: 'Items per page (default: 20, max: 100)',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['pending', 'uploading', 'processing', 'ready', 'failed'],
    description: 'Filter by status',
  })
  @ApiQuery({
    name: 'sortBy',
    required: false,
    enum: ['createdAt', 'name', 'size'],
    description: 'Sort field (default: createdAt)',
  })
  @ApiQuery({
    name: 'sortOrder',
    required: false,
    enum: ['asc', 'desc'],
    description: 'Sort order (default: desc)',
  })
  @ApiDataResponse(ObjectResponseDto, {
    pagination: 'nested',
    description: 'List retrieved successfully',
  })
  async list(
    @Query(new ZodValidationPipe(objectListQuerySchema))
    query: ObjectListQueryDto,
    @CurrentUser('id') userId: string,
  ): Promise<{ data: ObjectListResponseDto }> {
    const result = await this.objectsService.list(query, userId);
    return { data: result };
  }

  /**
   * Get single object by ID
   */
  @Get(':id')
  @ApiOperation({
    summary: 'Get storage object',
    description: 'Get metadata for a specific storage object',
  })
  @ApiParam({
    name: 'id',
    type: String,
    format: 'uuid',
    description: 'Object ID',
  })
  @ApiDataResponse(ObjectResponseDto, {
    description: 'Object retrieved successfully',
  })
  @ApiResponse({
    status: 404,
    description: 'Object not found',
  })
  @ApiResponse({
    status: 403,
    description: 'Access denied - you do not own this object',
  })
  async getById(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') userId: string,
  ): Promise<{ data: ObjectResponseDto }> {
    const result = await this.objectsService.getById(id, userId);
    return { data: result };
  }

  /**
   * Get signed download URL
   */
  @Get(':id/download')
  @ApiOperation({
    summary: 'Get download URL',
    description: 'Generate a signed URL for downloading a storage object',
  })
  @ApiParam({
    name: 'id',
    type: String,
    format: 'uuid',
    description: 'Object ID',
  })
  @ApiQuery({
    name: 'expiresIn',
    required: false,
    type: Number,
    description: 'URL expiration in seconds (default: 3600)',
  })
  @ApiDataResponse(DownloadUrlResponseDto, {
    description: 'Download URL generated successfully',
  })
  @ApiResponse({
    status: 400,
    description: 'Object is not ready for download',
  })
  @ApiResponse({
    status: 404,
    description: 'Object not found',
  })
  @ApiResponse({
    status: 403,
    description: 'Access denied - you do not own this object',
  })
  async getDownloadUrl(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('expiresIn') expiresIn: number | undefined,
    @CurrentUser('id') userId: string,
  ): Promise<{ data: DownloadUrlResponseDto }> {
    const result = await this.objectsService.getDownloadUrl(
      id,
      userId,
      expiresIn,
    );
    return { data: result };
  }

  /**
   * Delete storage object
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete storage object',
    description: 'Delete a storage object from both storage and database',
  })
  @ApiParam({
    name: 'id',
    type: String,
    format: 'uuid',
    description: 'Object ID',
  })
  @ApiResponse({
    status: 204,
    description: 'Object deleted successfully',
  })
  @ApiResponse({
    status: 404,
    description: 'Object not found',
  })
  @ApiResponse({
    status: 403,
    description: 'Access denied - you do not own this object',
  })
  async deleteObject(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') userId: string,
  ): Promise<void> {
    await this.objectsService.delete(id, userId);
  }

  /**
   * Update object metadata
   */
  @Patch(':id/metadata')
  @ApiOperation({
    summary: 'Update object metadata',
    description:
      'Update metadata for a storage object (merges with existing metadata)',
  })
  @ApiParam({
    name: 'id',
    type: String,
    format: 'uuid',
    description: 'Object ID',
  })
  @ApiBody({ type: UpdateMetadataBodyDto })
  @ApiDataResponse(ObjectResponseDto, {
    description: 'Metadata updated successfully',
  })
  @ApiResponse({
    status: 404,
    description: 'Object not found',
  })
  @ApiResponse({
    status: 403,
    description: 'Access denied - you do not own this object',
  })
  async updateMetadata(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateMetadataSchema)) dto: UpdateMetadataDto,
    @CurrentUser('id') userId: string,
  ): Promise<{ data: ObjectResponseDto }> {
    const result = await this.objectsService.updateMetadata(id, dto, userId);
    return { data: result };
  }

  /**
   * Initialize resumable multipart upload
   */
  @Post('upload/init')
  @ApiOperation({
    summary: 'Initialize resumable upload',
    description: 'Start a multipart upload for large files',
  })
  @ApiBody({ type: InitUploadBodyDto })
  @ApiDataResponse(InitUploadResponseDto, {
    status: 201,
    description: 'Upload initialized successfully',
  })
  async initUpload(
    @Body(new ZodValidationPipe(initUploadSchema)) dto: InitUploadDto,
    @CurrentUser('id') userId: string,
  ): Promise<{ data: InitUploadResponseDto }> {
    const result = await this.objectsService.initUpload(dto, userId);
    return { data: result };
  }

  /**
   * Get upload status and progress
   */
  @Get(':id/upload/status')
  @ApiOperation({
    summary: 'Get upload status',
    description: 'Check progress of a resumable upload',
  })
  @ApiParam({
    name: 'id',
    type: String,
    format: 'uuid',
    description: 'Object ID',
  })
  @ApiDataResponse(UploadStatusResponseDto, {
    description: 'Upload status retrieved',
  })
  async getUploadStatus(
    @Param('id') objectId: string,
    @CurrentUser('id') userId: string,
  ): Promise<{ data: UploadStatusResponseDto }> {
    const result = await this.objectsService.getUploadStatus(objectId, userId);
    return { data: result };
  }

  /**
   * Complete multipart upload
   */
  @Post(':id/upload/complete')
  @ApiOperation({
    summary: 'Complete resumable upload',
    description: 'Finalize a multipart upload after all parts are uploaded',
  })
  @ApiParam({
    name: 'id',
    type: String,
    format: 'uuid',
    description: 'Object ID',
  })
  @ApiBody({ type: CompleteUploadBodyDto })
  @ApiDataResponse(ObjectResponseDto, {
    description: 'Upload completed successfully',
  })
  async completeUpload(
    @Param('id') objectId: string,
    @Body(new ZodValidationPipe(completeUploadSchema)) dto: CompleteUploadDto,
    @CurrentUser('id') userId: string,
  ): Promise<{ data: ObjectResponseDto }> {
    const result = await this.objectsService.completeUpload(
      objectId,
      dto,
      userId,
    );
    return { data: result };
  }

  /**
   * Abort multipart upload
   */
  @Delete(':id/upload/abort')
  @ApiOperation({
    summary: 'Abort resumable upload',
    description: 'Cancel an in-progress multipart upload',
  })
  @ApiParam({
    name: 'id',
    type: String,
    format: 'uuid',
    description: 'Object ID',
  })
  @ApiResponse({
    status: 204,
    description: 'Upload aborted successfully',
  })
  async abortUpload(
    @Param('id') objectId: string,
    @CurrentUser('id') userId: string,
  ): Promise<void> {
    await this.objectsService.abortUpload(objectId, userId);
  }

  /**
   * Simple upload for smaller files (< 100MB)
   */
  @Post()
  @ApiOperation({
    summary: 'Simple file upload',
    description: 'Direct upload for files under 100MB',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    description: 'File to upload',
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
        },
      },
    },
  })
  @ApiDataResponse(ObjectResponseDto, {
    status: 201,
    description: 'File uploaded successfully',
  })
  async simpleUpload(
    @Req() req: FastifyRequest,
    @CurrentUser('id') userId: string,
  ): Promise<{ data: ObjectResponseDto }> {
    // Get multipart file from request
    const data = await req.file();

    if (!data) {
      throw new BadRequestException('No file provided');
    }

    const result = await this.objectsService.simpleUpload(
      {
        filename: data.filename,
        mimetype: data.mimetype,
        file: data.file,
      },
      userId,
    );

    return { data: result };
  }
}
