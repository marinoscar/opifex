import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { RunnersModule } from '../runners/runners.module';
import { HealthController } from './health.controller';
import { DatabaseHealthIndicator } from './indicators/database.indicator';
import { FleetIndicator } from './indicators/fleet.indicator';
import { SeedIntegrityIndicator } from './indicators/seed-integrity.indicator';
import { SeedIntegrityService } from './seed-integrity.service';

/**
 * `RunnersModule` is imported for `FleetStateService` alone (#277).
 *
 * The edge runs this way rather than the other because fleet state is a fact
 * about the fleet, not about health — it is also read by the registration
 * tick, which has no business importing a module that exists to serve two HTTP
 * routes. Nothing in the runners graph imports health, so the edge is acyclic,
 * and Nest instantiates each module once regardless of how many import it.
 */
@Module({
  imports: [TerminusModule, RunnersModule],
  controllers: [HealthController],
  providers: [
    DatabaseHealthIndicator,
    SeedIntegrityService,
    SeedIntegrityIndicator,
    FleetIndicator,
  ],
})
export class HealthModule {}
