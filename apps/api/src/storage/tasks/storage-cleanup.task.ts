import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { STORAGE_PROVIDER, StorageProvider } from '../providers';
import { Inject } from '@nestjs/common';

@Injectable()
export class StorageCleanupTask {
  private readonly logger = new Logger(StorageCleanupTask.name);

  // Cleanup incomplete uploads after 24 hours
  private readonly CLEANUP_AGE_HOURS = 24;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE_PROVIDER)
    private readonly storageProvider: StorageProvider,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async handleCleanup(): Promise<void> {
    this.logger.log('Starting storage cleanup task');

    try {
      const cleanupBefore = new Date();
      cleanupBefore.setHours(cleanupBefore.getHours() - this.CLEANUP_AGE_HOURS);

      // Find incomplete uploads older than threshold
      const staleUploads = await this.prisma.storageObject.findMany({
        where: {
          status: { in: ['pending', 'uploading'] },
          createdAt: { lt: cleanupBefore },
        },
        select: {
          id: true,
          storageKey: true,
          s3UploadId: true,
        },
      });

      if (staleUploads.length === 0) {
        this.logger.log('No stale uploads to clean up');
        return;
      }

      this.logger.log(`Found ${staleUploads.length} stale uploads to clean up`);

      let successCount = 0;
      let errorCount = 0;

      for (const upload of staleUploads) {
        try {
          // Abort S3 multipart upload if exists
          if (upload.s3UploadId) {
            await this.storageProvider.abortMultipartUpload(
              upload.storageKey,
              upload.s3UploadId,
            );
          }

          // Delete from database (chunks cascade delete)
          await this.prisma.storageObject.delete({
            where: { id: upload.id },
          });

          successCount++;
          this.logger.debug(`Cleaned up stale upload: ${upload.id}`);
        } catch (error) {
          errorCount++;
          this.logger.error(
            `Failed to clean up upload ${upload.id}: ${error instanceof Error ? error.message : 'Unknown error'}`,
          );
        }
      }

      this.logger.log(
        `Storage cleanup completed: ${successCount} removed, ${errorCount} failed`,
      );
    } catch (error) {
      this.logger.error(
        `Storage cleanup task failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }
}
