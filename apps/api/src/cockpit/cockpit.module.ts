import { Module } from '@nestjs/common';

import { DispatchModule } from '../dispatch/dispatch.module';
import { PrismaModule } from '../prisma/prisma.module';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';
import { QueueController } from './queue.controller';
import { QueueService } from './queue.service';
import { RunsController } from './runs.controller';
import { RunsService } from './runs.service';
import { WorkOrdersController } from './work-orders.controller';
import { WorkOrdersService } from './work-orders.service';

/**
 * The cockpit read models (#80).
 *
 * Read-only by construction: it holds `DispatchModule` to ASK the routing
 * policy why a work order is waiting, and nothing here can dispatch one. The
 * queue's hold and release controls are deliberately a separate issue (#116)
 * because a write path has different authorization stakes, and keeping them
 * out of this module is what makes that separation structural.
 *
 * One module per endpoint family as #80 asks, so each family flips its own
 * registry flag and its own destination in its own pull request.
 */
@Module({
  imports: [PrismaModule, DispatchModule],
  controllers: [QueueController, RunsController, MetricsController, WorkOrdersController],
  providers: [QueueService, RunsService, MetricsService, WorkOrdersService],
  exports: [QueueService, RunsService, MetricsService, WorkOrdersService],
})
export class CockpitModule {}
