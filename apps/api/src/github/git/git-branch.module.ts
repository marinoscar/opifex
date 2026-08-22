import { Module } from '@nestjs/common';

import { GitHubModule } from '../github.module';
import { GitHubWriteModule } from '../write/github-write.module';
import { GitBranchService } from './git-branch.service';

/**
 * Branch creation, separated from every other write.
 *
 * A module of one service, which is the point: importing it is a visible,
 * greppable statement that a component can create branches. Folding it into
 * `GitHubWriteModule` would make that capability arrive with a dozen others.
 */
@Module({
  imports: [GitHubModule, GitHubWriteModule],
  providers: [GitBranchService],
  exports: [GitBranchService],
})
export class GitBranchModule {}
