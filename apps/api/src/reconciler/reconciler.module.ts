import { Module } from '@nestjs/common';

import { DeadTimeModule } from '../dead-time/dead-time.module';
import { DispatchModule } from '../dispatch/dispatch.module';
import { EscalationsModule } from '../escalations/escalations.module';
import { GitHubReadModule } from '../github/read/github-read.module';
import { GitHubWriteModule } from '../github/write/github-write.module';
import { LivenessModule } from '../liveness/liveness.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { WatchdogModule } from '../watchdog/watchdog.module';
import { WorkOrdersModule } from '../work-orders/work-orders.module';
import { MirrorLabelExecutor } from './execute/mirror-label.executor';
import { SpecFeedbackExecutor } from './execute/spec-feedback.executor';
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
 *    what should happen is still incapable of making it happen. #155 gave it
 *    `WorkOrderProjectionService`, which writes ROWS; the GitHub half of that
 *    work — telling an author why their spec was rejected — leaves on the tick
 *    record and is posted by the task, on the same side of the line as every
 *    other outward action.
 *  - `ReconcilerTask` is the only place the two meet: it calls the reconciler
 *    to COMPUTE, then hands the action list to the executor to APPLY.
 *  - The executor handles two label action types and ignores everything else.
 *    There is no branch in it that could dispatch a run, and
 *    `GitHubWriteService` has no dispatch adapter for it to call.
 *
 * Two flags, and both must be on: `GITHUB_WRITES_ENABLED` globally, which
 * ships ON since ADR-0019 (#439), and `Repository.mirrorLabelsEnabled` per
 * repository, which does not. So the per-repository flag is now the one an
 * operator opts in with, and no repository is written to until they do.
 */
@Module({
  imports: [
    GitHubReadModule,
    GitHubWriteModule,
    LivenessModule,
    WatchdogModule,
    // The dead-time ledger (#232). A DATABASE write held by the TASK, not by
    // `ReconcilerService` — the component that decides what is true still
    // cannot record it, which is the same line the escalations sit on.
    DeadTimeModule,
    RepositoriesModule,
    // Escalation records, written by the task and by nothing else in here.
    // `ReconcilerService` still cannot reach them, which keeps "decides" and
    // "acts" on opposite sides of the same line the executor is on.
    EscalationsModule,
    // Sending them. Also driven from the task, for the same reason: raising
    // an escalation and telling somebody are both ACTIONS, and the component
    // that decides to escalate can do neither.
    NotificationsModule,
    // Turning eligible issues into work order rows (#155). A DATABASE write,
    // not a GitHub one — which is why `ReconcilerService` may hold it while
    // still being unable to touch a repository. A queued work order is inert
    // without `DISPATCH_ENABLED`, and seeing what the factory would work on is
    // the artifact VISION §12 asks the observation week to produce.
    WorkOrdersModule,
    // Draining the queue those work orders land in (#153). Held by the TASK,
    // not by `ReconcilerService` — dispatch is the most consequential action
    // in the system, and the component that decides what should happen must
    // not be able to start a run. Gated twice: `Repository.dispatchEnabled`
    // per repository, which defaults off, and `DISPATCH_ENABLED` globally,
    // which since ADR-0019 (#439) defaults ON — with the hard spend ceiling,
    // unset and refusing, as the one thing that keeps a fresh install from
    // spending. `RECONCILER_ENABLED` defaults on in the same change, so this
    // drain really does run on a fresh install and really does reach that
    // refusal, rather than never being called at all.
    DispatchModule,
  ],
  controllers: [ReconcilerController],
  providers: [
    TickLeaseService,
    ReconcileLogService,
    ReconcileLogCleanupTask,
    ReconcilerService,
    MirrorLabelExecutor,
    // The other write the task may make: telling an issue author why their
    // spec was refused (#155). On the same side of the compute/act line as
    // the label executor, behind its own per-repository flag.
    SpecFeedbackExecutor,
    ReconcilerTask,
  ],
  exports: [ReconcilerService, ReconcileLogService],
})
export class ReconcilerModule {}
