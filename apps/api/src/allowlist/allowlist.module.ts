import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AllowlistController } from './allowlist.controller';
import { AllowlistService } from './allowlist.service';

@Module({
  imports: [PrismaModule],
  controllers: [AllowlistController],
  providers: [AllowlistService],
  exports: [AllowlistService],
})
export class AllowlistModule {}
