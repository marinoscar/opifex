import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma } from '@prisma/client';
import { STORAGE_PROVIDER, StorageProvider } from '../providers';
import { OBJECT_UPLOADED_EVENT, ObjectUploadedEvent } from './events/object-uploaded.event';
import { OBJECT_PROCESSOR, ObjectProcessor } from './object-processor.interface';

@Injectable()
export class ObjectProcessingService {
  private readonly logger = new Logger(ObjectProcessingService.name);
  private readonly processors: ObjectProcessor[];

  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE_PROVIDER)
    private readonly storageProvider: StorageProvider,
    @Optional()
    @Inject(OBJECT_PROCESSOR)
    processors?: ObjectProcessor | ObjectProcessor[],
  ) {
    // Handle both single and multi-provider injection
    this.processors = this.normalizeProcessors(processors);
    this.processors.sort((a, b) => a.priority - b.priority);

    this.logger.log(`Initialized with ${this.processors.length} processors`);
    if (this.processors.length > 0) {
      this.logger.debug(`Processors: ${this.processors.map(p => p.name).join(', ')}`);
    }
  }

  private normalizeProcessors(
    processors?: ObjectProcessor | ObjectProcessor[],
  ): ObjectProcessor[] {
    if (!processors) return [];
    return Array.isArray(processors) ? processors : [processors];
  }

  @OnEvent(OBJECT_UPLOADED_EVENT, { async: true })
  async handleObjectUploaded(event: ObjectUploadedEvent): Promise<void> {
    const { object } = event;

    this.logger.log(`Processing object: ${object.id} (${object.name})`);

    // Get applicable processors
    const applicableProcessors = this.processors.filter(p => p.canProcess(object));

    if (applicableProcessors.length === 0) {
      this.logger.debug(`No processors applicable for object ${object.id}`);
      await this.markReady(object.id, {});
      return;
    }

    this.logger.debug(
      `Running ${applicableProcessors.length} processors for object ${object.id}`,
    );

    const allMetadata: Record<string, unknown> = {};
    let hasError = false;

    for (const processor of applicableProcessors) {
      try {
        this.logger.debug(`Running processor: ${processor.name}`);

        const result = await processor.process(
          object,
          () => this.storageProvider.download(object.storageKey),
        );

        if (result.success && result.metadata) {
          allMetadata[processor.name] = result.metadata;
          this.logger.debug(`Processor ${processor.name} completed successfully`);
        } else if (!result.success) {
          this.logger.warn(
            `Processor ${processor.name} failed: ${result.error}`,
          );
          allMetadata[`${processor.name}_error`] = result.error;
          hasError = true;
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        this.logger.error(
          `Processor ${processor.name} threw exception: ${errorMessage}`,
        );
        allMetadata[`${processor.name}_error`] = errorMessage;
        hasError = true;
      }
    }

    // Update final status
    if (hasError) {
      await this.markFailed(object.id, allMetadata);
    } else {
      await this.markReady(object.id, allMetadata);
    }
  }

  private async markReady(
    objectId: string,
    processingMetadata: Record<string, unknown>,
  ): Promise<void> {
    const existing = await this.prisma.storageObject.findUnique({
      where: { id: objectId },
      select: { metadata: true },
    });

    const mergedMetadata = {
      ...(existing?.metadata as Record<string, unknown> || {}),
      _processing: processingMetadata,
      _processedAt: new Date().toISOString(),
    };

    await this.prisma.storageObject.update({
      where: { id: objectId },
      data: {
        status: 'ready',
        metadata: mergedMetadata as Prisma.InputJsonValue,
      },
    });

    this.logger.log(`Object ${objectId} marked as ready`);
  }

  private async markFailed(
    objectId: string,
    processingMetadata: Record<string, unknown>,
  ): Promise<void> {
    const existing = await this.prisma.storageObject.findUnique({
      where: { id: objectId },
      select: { metadata: true },
    });

    const mergedMetadata = {
      ...(existing?.metadata as Record<string, unknown> || {}),
      _processing: processingMetadata,
      _processingFailed: true,
      _processedAt: new Date().toISOString(),
    };

    await this.prisma.storageObject.update({
      where: { id: objectId },
      data: {
        status: 'failed',
        metadata: mergedMetadata as Prisma.InputJsonValue,
      },
    });

    this.logger.warn(`Object ${objectId} marked as failed`);
  }
}
