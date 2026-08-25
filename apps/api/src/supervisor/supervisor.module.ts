import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { NotificationsModule } from '../notifications/notifications.module';
import { PrismaModule } from '../prisma/prisma.module';
import { DailyBriefService } from './brief/daily-brief.service';
import { DailyBriefTask } from './brief/daily-brief.task';
import { DecisionLogController } from './decision-log/decision-log.controller';
import { DecisionLogService } from './decision-log/decision-log.service';
import { createSupervisorModel } from './invocation/anthropic-supervisor-model';
import { SupervisorService } from './invocation/supervisor.service';
import { SUPERVISOR_MODEL } from './invocation/supervisor-model.port';
import {
  SUPERVISOR_PROPOSERS,
  type SupervisorProposer,
} from './invocation/supervisor-proposer.port';
import { RetiredSupervisorConfigService } from './retired-config';
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
    // Instantiated for its constructor alone: it warns at boot about
    // supervisor settings that were retired and are still exported somewhere
    // (ADR-0016). Nothing injects it, and nothing should -- it holds no state
    // and answers no question. It lives here rather than in `app.module.ts`
    // because the settings it speaks for are this module's.
    RetiredSupervisorConfigService,
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
      // The model adapter (ADR-0015, #230), or nothing.
      //
      // A factory rather than a class provider because the binding is
      // CONDITIONAL: `createSupervisorModel` returns the Anthropic adapter
      // when `SUPERVISOR_MODEL_API_KEY` is set and `undefined` when it is not.
      // With `undefined`, `@Optional() @Inject(SUPERVISOR_MODEL)` in
      // `SupervisorService` leaves `model` undefined and the existing
      // `?? new UnavailableSupervisorModel()` fallback still wins — still
      // refusing, still recording that refusal in the decision log. The
      // unconfigured path is unchanged by design; a missing key must not crash
      // the API at boot and must not quietly disable the supervisor either.
      //
      // Why the decision is made HERE, at instantiation, rather than by
      // building the providers array conditionally at module-definition time:
      // this decorator is evaluated while `app.module.ts` is being imported,
      // which is before `ConfigModule.forRoot()` has loaded a `.env` file. A
      // `process.env` read up there would be right in a container and wrong on
      // a developer's machine.
      //
      // It binds one adapter, and nothing outside `invocation/` names a model
      // provider — the seam stays vendor-neutral even though today there is
      // exactly one vendor behind it.
      provide: SUPERVISOR_MODEL,
      inject: [ConfigService],
      useFactory: createSupervisorModel,
    },
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
