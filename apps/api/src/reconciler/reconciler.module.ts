import { Module } from '@nestjs/common';

import { GitHubReadModule } from '../github/read/github-read.module';
import { RepositoriesModule } from '../repositories/repositories.module';
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
  providers: [TickLeaseService, ReconcilerService, ReconcilerTask],
  exports: [ReconcilerService],
})
export class ReconcilerModule {}
