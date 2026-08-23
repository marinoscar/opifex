import { Module } from '@nestjs/common';

import { BudgetModule } from '../budget/budget.module';
import { DispatchModule } from '../dispatch/dispatch.module';
import { GitHubWriteModule } from '../github/write/github-write.module';
import { PrismaModule } from '../prisma/prisma.module';
import { CostController } from './cost.controller';
import { CostService } from './cost.service';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';
import { QueueController } from './queue.controller';
import { QueueService } from './queue.service';
import { QueueSteeringService } from './queue-steering.service';
import { RunsController } from './runs.controller';
import { RunsService } from './runs.service';
import { WorkOrdersController } from './work-orders.controller';
import { WorkOrdersService } from './work-orders.service';

/**
 * The cockpit read models (#80), plus queue steering (#116).
 *
 * It holds `DispatchModule` to ASK the routing policy why a work order is
 * waiting, and nothing here can dispatch one.
 *
 * `GitHubWriteModule` arrived with #116 and is the one write capability in this
 * module. It is imported by name rather than inherited, because the transport
 * module deliberately does not re-export write access — so the capability is
 * visible in this imports list. What it buys is narrow on purpose: hold and
 * release write an INPUT LABEL to GitHub and nothing else, so the effect still
 * arrives through the reconciler rather than around it.
 *
 * One module per endpoint family as #80 asks, so each family flips its own
 * registry flag and its own destination in its own pull request.
 */
@Module({
  imports: [PrismaModule, DispatchModule, BudgetModule, GitHubWriteModule],
  controllers: [
    QueueController,
    RunsController,
    MetricsController,
    WorkOrdersController,
    CostController,
    EventsController,
  ],
  providers: [
    QueueService,
    QueueSteeringService,
    RunsService,
    MetricsService,
    WorkOrdersService,
    CostService,
    EventsService,
  ],
  exports: [
    QueueService,
    RunsService,
    MetricsService,
    WorkOrdersService,
    CostService,
    EventsService,
  ],
})
export class CockpitModule {}
