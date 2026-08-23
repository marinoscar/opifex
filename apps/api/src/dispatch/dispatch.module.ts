import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { RunnersModule } from '../runners/runners.module';
import { WorkOrdersModule } from '../work-orders/work-orders.module';
import { DispatchQueueService } from './dispatch-queue.service';
import { DispatchService } from './dispatch.service';
import { RunExecutorService } from './run-executor.service';

/**
 * Dispatch decisions.
 *
 * Deliberately holds no runner, no executor and no GitHub client: deciding
 * WHICH runner should take a work order is separate from handing it over, and
 * a module that could do both would make it easy to write a dispatcher that
 * decides and acts in one place with nothing recording the decision.
 */
@Module({
  imports: [PrismaModule, RunnersModule, WorkOrdersModule],
  providers: [DispatchService, RunExecutorService, DispatchQueueService],
  exports: [DispatchService, RunExecutorService, DispatchQueueService],
})
export class DispatchModule {}
