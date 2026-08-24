import { Module } from '@nestjs/common';

import { NotificationsModule } from '../notifications/notifications.module';
import { PrismaModule } from '../prisma/prisma.module';
import { DailyBriefService } from './brief/daily-brief.service';
import { DailyBriefTask } from './brief/daily-brief.task';
import { DecisionLogController } from './decision-log/decision-log.controller';
import { DecisionLogService } from './decision-log/decision-log.service';
import { SupervisorService } from './invocation/supervisor.service';
import {
  SUPERVISOR_PROPOSERS,
  type SupervisorProposer,
} from './invocation/supervisor-proposer.port';
import { DecompositionProposer } from './proposers/decomposition.proposer';
import { IssueShapingProposer } from './proposers/issue-shaping.proposer';
import { SpecQualityProposer } from './proposers/spec-quality.proposer';
import { RunDiagnosisProposer } from './proposers/run-diagnosis.proposer';
import { SupervisorTask } from './invocation/supervisor.task';
import { SnapshotService } from './snapshot/snapshot.service';
import { TrustDigestSource } from './brief/trust-digest.source';

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
  imports: [PrismaModule, NotificationsModule],
  controllers: [DecisionLogController],
  providers: [
    SnapshotService,
    DecisionLogService,
    SupervisorService,
    SupervisorTask,
    RunDiagnosisProposer,
    DecompositionProposer,
    IssueShapingProposer,
    SpecQualityProposer,
    TrustDigestSource,
    DailyBriefService,
    DailyBriefTask,
    {
      // The proposer list, assembled here so the set is readable in one place
      // rather than discovered by scanning for a decorator. Every entry
      // returns drafts and nothing else — the port's signature is what makes
      // that true of proposers that do not exist yet.
      provide: SUPERVISOR_PROPOSERS,
      inject: [
        RunDiagnosisProposer,
        DecompositionProposer,
        IssueShapingProposer,
        SpecQualityProposer,
      ],
      useFactory: (...proposers: SupervisorProposer[]) => proposers,
    },
  ],
  exports: [
    SnapshotService,
    DecisionLogService,
    SupervisorService,
    DailyBriefService,
  ],
})
export class SupervisorModule {}
