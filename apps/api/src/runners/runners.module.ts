import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { ClaudeCodeLocalRunner } from './claude-code-local/claude-code-local.runner';
import { RunWorkspaceService } from './claude-code-local/run-workspace.service';
import { RunnerRegistrationService } from './runner-registration.service';

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
  imports: [PrismaModule],
  providers: [RunWorkspaceService, ClaudeCodeLocalRunner, RunnerRegistrationService],
  exports: [RunWorkspaceService, ClaudeCodeLocalRunner, RunnerRegistrationService],
})
export class RunnersModule {}
