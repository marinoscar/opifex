import { Module } from '@nestjs/common';

import { GitHubReadModule } from '../github/read/github-read.module';
import { GitLivenessService } from './git-liveness.service';

/**
 * Git-derived liveness.
 *
 * Imports READ capability only, and needs nothing else: deriving liveness from
 * commits, pull requests and CI is entirely a matter of looking. Nothing here
 * writes to GitHub.
 */
@Module({
  imports: [GitHubReadModule],
  providers: [GitLivenessService],
  exports: [GitLivenessService],
})
export class LivenessModule {}
