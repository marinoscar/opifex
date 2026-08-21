import { Module } from '@nestjs/common';

import { GitHubWriteService } from './github-write.service';

/**
 * Write capability, in its own module on purpose.
 *
 * Nothing imports this yet, and the read-only reconciler must not: VISION §12
 * requires an observation week, and #41's read module is deliberately not a
 * re-export of this one. A module that imports `GitHubReadModule` has no
 * provider for `GitHubWriteService` in its injector, so the boundary holds
 * structurally rather than by anyone remembering it.
 */
@Module({
  providers: [GitHubWriteService],
  exports: [GitHubWriteService],
})
export class GitHubWriteModule {}
