import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { DecisionLogController } from './decision-log/decision-log.controller';
import { DecisionLogService } from './decision-log/decision-log.service';
import { SupervisorService } from './invocation/supervisor.service';
import { SupervisorTask } from './invocation/supervisor.task';
import { SnapshotService } from './snapshot/snapshot.service';

/**
 * The supervisor (VISION §7), observe-only.
 *
 * ## What this module deliberately does not import
 *
 * No `GitHubWriteModule`. No dispatcher. No runner registry. The supervisor
 * proposes and executes nothing, and #90 requires that be "structurally
 * impossible, not merely unimplemented" — so the capability to act is absent
 * from the module graph rather than merely unused in the code. VISION §3.6
 * generalises the principle: "a system whose safety depends on a model being
 * right has no safety property at all", and the same holds for a system whose
 * safety depends on nobody wiring an executor up later.
 *
 * The import list is therefore load-bearing. A future PR adding a write module
 * here is the failure this module's shape exists to make visible in review.
 */
@Module({
  imports: [PrismaModule],
  controllers: [DecisionLogController],
  providers: [
    SnapshotService,
    DecisionLogService,
    SupervisorService,
    SupervisorTask,
  ],
  exports: [SnapshotService, DecisionLogService, SupervisorService],
})
export class SupervisorModule {}
