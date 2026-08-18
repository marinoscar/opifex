import { Module } from '@nestjs/common';
import { STORAGE_PROVIDER } from './storage-provider.interface';
import { S3StorageProvider } from './s3/s3-storage.provider';

/**
 * Storage Providers Module
 * Provides dependency injection for storage provider implementations
 *
 * Currently configured to use S3 storage provider.
 * To add alternative providers (local filesystem, Azure Blob, etc.),
 * update the useClass or use a factory provider based on configuration.
 */
@Module({
  providers: [
    {
      provide: STORAGE_PROVIDER,
      useClass: S3StorageProvider,
    },
  ],
  exports: [STORAGE_PROVIDER],
})
export class StorageProvidersModule {}
