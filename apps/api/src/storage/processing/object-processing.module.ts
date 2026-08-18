import { Module } from '@nestjs/common';
import { ObjectProcessingService } from './object-processing.service';
import { StorageProvidersModule } from '../providers/storage-providers.module';

@Module({
  imports: [StorageProvidersModule],
  providers: [ObjectProcessingService],
  exports: [ObjectProcessingService],
})
export class ObjectProcessingModule {}
