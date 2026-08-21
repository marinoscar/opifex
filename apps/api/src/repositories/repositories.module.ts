import { Module } from '@nestjs/common';

import { GitHubReadModule } from '../github/read/github-read.module';
import { RepositoriesController } from './repositories.controller';
import { RepositoriesService } from './repositories.service';

/**
 * Imports READ capability only.
 *
 * Registration verifies a repository is reachable, which is a read. Nothing
 * here writes to GitHub, and its imports say so — which is the point of #41
 * and #42 being separate modules rather than one service with a comment.
 */
@Module({
  imports: [GitHubReadModule],
  controllers: [RepositoriesController],
  providers: [RepositoriesService],
  exports: [RepositoriesService],
})
export class RepositoriesModule {}
