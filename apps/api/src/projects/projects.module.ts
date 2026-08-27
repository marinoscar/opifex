import { Module } from '@nestjs/common';

import { RepositoriesModule } from '../repositories/repositories.module';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';

/**
 * Imports `RepositoriesModule` so assignment goes through the one service that
 * already owns what a repository is and what it looks like on the wire. The
 * dependency runs one way only — nothing in `RepositoriesModule` knows this
 * module exists — so there is no cycle to break.
 */
@Module({
  imports: [RepositoriesModule],
  controllers: [ProjectsController],
  providers: [ProjectsService],
  exports: [ProjectsService],
})
export class ProjectsModule {}
