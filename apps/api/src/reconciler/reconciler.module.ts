import { Module } from '@nestjs/common';

import { EscalationsModule } from '../escalations/escalations.module';
import { GitHubReadModule } from '../github/read/github-read.module';
import { GitHubWriteModule } from '../github/write/github-write.module';
import { LivenessModule } from '../liveness/liveness.module';
import { WatchdogModule } from '../watchdog/watchdog.module';
import { MirrorLabelExecutor } from './execute/mirror-label.executor';
import { RepositoriesModule } from '../repositories/repositories.module';
import { ReconcileLogCleanupTask } from './log/reconcile-log.cleanup.task';
import { ReconcileLogService } from './log/reconcile-log.service';
import { ReconcilerController } from './reconciler.controller';
import { ReconcilerService } from './reconciler.service';
import { ReconcilerTask } from './reconciler.task';
import { TickLeaseService } from './tick-lease.service';

/**
 * The control loop.
 *
 * ## Read the import list, then read this
 *
 * This module now imports `GitHubWriteModule` — it did not before #48, and
 * the change being visible right here is exactly what the earlier comment
 * promised would happen. The guarantee was never "a write can never be added";
 * it was "a write cannot be added invisibly".
 *
 * What remains structurally true, and is the part VISION §12's observation
 * week rests on:
 *
 *  - `ReconcilerService` — observation, projection, diff — does not depend on
 *    `MirrorLabelExecutor` or on any write service. The component that decides
 *    what should happen is still incapable of making it happen.
 *  - `ReconcilerTask` is the only place the two meet: it calls the reconciler
 *    to COMPUTE, then hands the action list to the executor to APPLY.
 *  - The executor handles two label action types and ignores everything else.
 *    There is no branch in it that could dispatch a run, and
 *    `GitHubWriteService` has no dispatch adapter for it to call.
 *
 * Both flags default off: `GITHUB_WRITES_ENABLED` globally, and
 * `Repository.mirrorLabelsEnabled` per repository. Both must be on.
 */
@Module({
  imports: [
    GitHubReadModule,
    GitHubWriteModule,
    LivenessModule,
    WatchdogModule,
    RepositoriesModule,
    // Escalation records, written by the task and by nothing else in here.
    // `ReconcilerService` still cannot reach them, which keeps "decides" and
    // "acts" on opposite sides of the same line the executor is on.
    EscalationsModule,
  ],
  controllers: [ReconcilerController],
  providers: [
    TickLeaseService,
    ReconcileLogService,
    ReconcileLogCleanupTask,
    ReconcilerService,
    MirrorLabelExecutor,
    ReconcilerTask,
  ],
  exports: [ReconcilerService, ReconcileLogService],
})
export class ReconcilerModule {}
