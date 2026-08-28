import { Module } from '@nestjs/common';

import { GitHubReadModule } from '../github/read/github-read.module';
import { GitHubWriteModule } from '../github/write/github-write.module';
import { OperatorSettingsModule } from '../settings/operator-settings/operator-settings.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SteeringController } from './steering.controller';
import { SteeringService } from './steering.service';

/**
 * Steering (#425, epic #419).
 *
 * Its own module rather than a third controller inside `CockpitModule`,
 * because of what it has to IMPORT: the cockpit is a read-model module whose
 * one write capability is `GitHubWriteModule`, deliberately visible in a short
 * imports list. Steering additionally needs GitHub READS (to resolve an epic
 * and to sweep for the "everything else" set) and the operator settings (to
 * report whether the chat model could answer). Folding those into the cockpit
 * would widen what every cockpit read model can reach in order to ship one
 * endpoint family.
 *
 * There is no model adapter here, and that absence is load-bearing: an
 * instruction naming explicit issue numbers is parsed in code, and the model
 * path this module does not have is one it cannot accidentally take.
 */
@Module({
  imports: [
    PrismaModule,
    GitHubReadModule,
    GitHubWriteModule,
    OperatorSettingsModule,
  ],
  controllers: [SteeringController],
  providers: [SteeringService],
  exports: [SteeringService],
})
export class SteeringModule {}
