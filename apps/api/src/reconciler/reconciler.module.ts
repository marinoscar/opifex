import { Module } from '@nestjs/common';

import { GitHubReadModule } from '../github/read/github-read.module';
import { RepositoriesModule } from '../repositories/repositories.module';
import { ReconcileLogCleanupTask } from './log/reconcile-log.cleanup.task';
import { ReconcileLogService } from './log/reconcile-log.service';
import { ReconcilerController } from './reconciler.controller';
import { ReconcilerService } from './reconciler.service';
import { ReconcilerTask } from './reconciler.task';
import { TickLeaseService } from './tick-lease.service';

/**
 * The read-only control loop.
 *
 * Imports `GitHubReadModule` and **not** `GitHubWriteModule`. VISION §12
 * requires the reconciler to run read-only for a week, and this import list is
 * where that is true: `GitHubWriteService` is not in this module's injector,
 * so no amount of editing inside the reconciler can reach a write adapter
 * without the change being visible right here.
 */
@Module({
  imports: [GitHubReadModule, RepositoriesModule],
  controllers: [ReconcilerController],
  providers: [
    TickLeaseService,
    ReconcileLogService,
    ReconcileLogCleanupTask,
    ReconcilerService,
    ReconcilerTask,
  ],
  exports: [ReconcilerService, ReconcileLogService],
})
export class ReconcilerModule {}
