import { Module } from '@nestjs/common';

import { GitHubWriteModule } from '../github/write/github-write.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SupervisorModule } from '../supervisor/supervisor.module';
import { RunSummaryService } from './run-summary.service';
import { RunSummaryTask } from './run-summary.task';

/**
 * The VISION §5 run summary (#67).
 *
 * Its own module rather than a service inside `run-events`, because it is not
 * part of ingestion: the summary is composed from the run's settled facts on a
 * sweep, deliberately off the path a runner POSTs into.
 *
 * `GitHubWriteModule` rather than `GitHubModule`, and that distinction is
 * load-bearing: the transport module deliberately does not re-export write
 * access, so a consumer has to ask for it by name. The capability is then
 * visible in this imports list rather than buried in a module graph.
 *
 * `SupervisorModule` is imported for READ access to the decision log, so a
 * summary can carry the supervisor's diagnosis (#92). The direction matters:
 * the run summary reads what the supervisor proposed, and the supervisor
 * imports nothing that could post a comment. Reversing this edge would give a
 * proposal a path to GitHub, which is exactly what #90 makes structurally
 * impossible — and `supervisor-isolation.spec.ts` fails if anyone tries.
 */
@Module({
  imports: [PrismaModule, GitHubWriteModule, SupervisorModule],
  providers: [RunSummaryService, RunSummaryTask],
  exports: [RunSummaryService],
})
export class RunSummaryModule {}
