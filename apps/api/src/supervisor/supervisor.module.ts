import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { DecisionLogController } from './decision-log/decision-log.controller';
import { DecisionLogService } from './decision-log/decision-log.service';
import { SupervisorService } from './invocation/supervisor.service';
import { SUPERVISOR_PROPOSERS } from './invocation/supervisor-proposer.port';
import { RunDiagnosisProposer } from './proposers/run-diagnosis.proposer';
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
    RunDiagnosisProposer,
    {
      // The proposer list, assembled here so the set is readable in one place
      // rather than discovered by scanning for a decorator. Every entry
      // returns drafts and nothing else — the port's signature is what makes
      // that true of proposers that do not exist yet.
      provide: SUPERVISOR_PROPOSERS,
      inject: [RunDiagnosisProposer],
      useFactory: (...proposers: RunDiagnosisProposer[]) => proposers,
    },
  ],
  exports: [SnapshotService, DecisionLogService, SupervisorService],
})
export class SupervisorModule {}
