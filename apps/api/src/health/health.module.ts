import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller';
import { DatabaseHealthIndicator } from './indicators/database.indicator';
import { SeedIntegrityIndicator } from './indicators/seed-integrity.indicator';
import { SeedIntegrityService } from './seed-integrity.service';

@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
  providers: [
    DatabaseHealthIndicator,
    SeedIntegrityService,
    SeedIntegrityIndicator,
  ],
})
export class HealthModule {}
