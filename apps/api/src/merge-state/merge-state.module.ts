import { Module } from '@nestjs/common';

import { GitHubReadModule } from '../github/read/github-read.module';
import { PrismaModule } from '../prisma/prisma.module';
import { MergeStateService } from './merge-state.service';
import { MergeStateTask } from './merge-state.task';

/**
 * Pull-request merge state (#215), which success metrics 3 and 5 count.
 *
 * Read-only: it imports `GitHubReadModule` and never the write one, because
 * observing what happened to a pull request is the whole job. Asking for read
 * access by name is what keeps that visible here rather than in a module graph.
 */
@Module({
  imports: [PrismaModule, GitHubReadModule],
  providers: [MergeStateService, MergeStateTask],
  exports: [MergeStateService],
})
export class MergeStateModule {}
