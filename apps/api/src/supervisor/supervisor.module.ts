import { Module } from '@nestjs/common';

import { NotificationsModule } from '../notifications/notifications.module';
import { PrismaModule } from '../prisma/prisma.module';
import { OperatorSettingsService } from '../settings/operator-settings/operator-settings.service';
import { DailyBriefService } from './brief/daily-brief.service';
import { DailyBriefTask } from './brief/daily-brief.task';
import { DecisionLogController } from './decision-log/decision-log.controller';
import { DecisionLogService } from './decision-log/decision-log.service';
import { createSupervisorModel } from './invocation/supervisor-model.factory';
import { SupervisorService } from './invocation/supervisor.service';
import { SupervisorSpendCeilingService } from './invocation/supervisor-spend-ceiling';
import { SupervisorSpendLedgerService } from './invocation/supervisor-spend-ledger.service';
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
    // The supervisor's own spend ceiling and the tally it is measured against
    // (#261, ADR-0017). Deliberately NOT `HardSpendCeilingService` and NOT
    // `SpendLedgerService`: those are dispatch's, and a supervisor whose
    // ability to run depends on what the workers have spent goes quiet exactly
    // when worker spend is the thing worth explaining.
    SupervisorSpendCeilingService,
    SupervisorSpendLedgerService,
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
      // The model adapter (ADR-0015, #230), bound UNCONDITIONALLY (#344).
      //
      // It used to be conditional: `createSupervisorModel` returned the
      // adapter when `SUPERVISOR_MODEL_API_KEY` was set and `undefined` when
      // it was not, leaving `@Optional() @Inject(SUPERVISOR_MODEL)` in
      // `SupervisorService` to fall back to `UnavailableSupervisorModel`. A
      // factory runs ONCE, so that verdict outlived any later change to the
      // key: an operator who set it in the Control Center enabled a supervisor
      // that could not call anything until the process restarted, while the UI
      // said it was on. Since epic #332 makes the key operator-settable, the
      // condition had to move — the adapter is always here, and it resolves
      // the key, the model name, the base URL, the timeout and the token
      // ceiling on every call.
      //
      // The unconfigured path is unchanged, by design and by ADR-0015: with no
      // key the adapter refuses per invocation, reports its name as `'none'`
      // exactly as `UnavailableSupervisorModel` did, and the refusal is
      // recorded in the decision log rather than crashing the API at boot or
      // quietly disabling the supervisor.
      //
      // Still a factory rather than a class provider, and since #392 the
      // reason is live rather than anticipated: there ARE two vendors, and
      // choosing between them is that function's job. It is imported from
      // `supervisor-model.factory.ts` rather than from an adapter file so that
      // this module's import list names no vendor either — the seam is
      // vendor-neutral in the import graph and not only in the code. The
      // choice itself is made per call, not here: a factory runs once, and a
      // provider decided at boot would be the same stale copy of a live
      // setting that #344 removed for the API key.
      provide: SUPERVISOR_MODEL,
      inject: [OperatorSettingsService],
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
