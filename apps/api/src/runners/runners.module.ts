import { Module } from '@nestjs/common';

import { EscalationsModule } from '../escalations/escalations.module';
import { PrismaModule } from '../prisma/prisma.module';
import { QuotaModule } from '../quota/quota.module';
import { RunEventsModule } from '../run-events/run-events.module';
import { ClaudeCodeLocalRunner } from './claude-code-local/claude-code-local.runner';
import { RunWorkspaceService } from './claude-code-local/run-workspace.service';
import { FleetStateService } from './fleet-state.service';
import { RunnerRegistrationService } from './runner-registration.service';
import { RunnerRegistrationTask } from './runner-registration.task';
import { RunPollerService } from './run-poller.service';
import { RunPollerTask } from './run-poller.task';

/**
 * The runners the control plane can dispatch to.
 *
 * Deliberately separate from `DispatchModule`, which decides WHICH runner
 * should take a work order. VISION §6: *"work orders never name a runner"* —
 * and the same separation applies one level up. A module that both chose a
 * runner and held the only reference to it would make it easy to write a
 * dispatcher that reaches past its own decision.
 *
 * Adding a second runner here is meant to be uneventful: a class implementing
 * the four functions, a provider, an entry in the fleet. #60's first exit
 * criterion is that swapping runners means touching nothing in dispatch, and
 * this file is where that stays true or quietly stops being true.
 */
@Module({
  // QuotaModule because the poller carries window sightings into it (#231) —
  // the same one-way pump it already is for events. Nothing in QuotaModule
  // depends on a runner, only on what one reported, so the edge stays acyclic.
  imports: [PrismaModule, RunEventsModule, EscalationsModule, QuotaModule],
  providers: [
    RunWorkspaceService,
    ClaudeCodeLocalRunner,
    RunnerRegistrationService,
    // Fleet cardinality, for the health endpoints and for #277's escalation.
    // It lives here rather than in `HealthModule` because it is a fact about
    // the fleet, and the loop that observes it is the registration tick — the
    // one loop that runs on every deployment whatever the enable flags say.
    FleetStateService,
    // Unconditional, unlike `RunPollerTask` below: registration must converge
    // even where every enable flag is off, because an empty fleet table is
    // exactly the state an operator needs resolved before turning them on
    // (#162).
    RunnerRegistrationTask,
    RunPollerService,
    RunPollerTask,
  ],
  exports: [
    // Exported for `HealthModule`, which reports the fleet on
    // /api/health/ready without failing it (#277, following #173's shape).
    FleetStateService,
    RunWorkspaceService,
    ClaudeCodeLocalRunner,
    RunnerRegistrationService,
    RunPollerService,
  ],
})
export class RunnersModule {}
