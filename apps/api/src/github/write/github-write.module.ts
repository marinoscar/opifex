import { Module } from '@nestjs/common';

import { GitHubReadModule } from '../read/github-read.module';
import { GitHubWriteService } from './github-write.service';
import { GitHubIssueGateService } from './issue-gate.service';

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
  // The gate reads open issues to dedupe against them, so the WRITE module
  // imports the read one. The dependency runs in that direction only, and
  // must keep doing so: the read module importing this one is what would give
  // the read-only reconciler a path to a write adapter.
  imports: [GitHubReadModule],
  providers: [GitHubWriteService, GitHubIssueGateService],
  exports: [GitHubWriteService, GitHubIssueGateService],
})
export class GitHubWriteModule {}
