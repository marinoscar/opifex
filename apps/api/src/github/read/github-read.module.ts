import { Module } from '@nestjs/common';

import { EpicChildrenService } from './epic-children.service';
import { GitHubReadService } from './github-read.service';

/**
 * Read capability, and only read capability.
 *
 * The module boundary IS the guarantee #41 asks for. `GitHubWriteModule` is a
 * separate module that this one does not import and does not re-export, so a
 * consumer that imports `GitHubReadModule` has no path to a write adapter —
 * not by convention, but because the provider is not in its injector.
 *
 * VISION §12's observation week depends on that being structural: "we promise
 * not to call the write method" is a convention that survives exactly until
 * someone adds a convenience re-export.
 *
 * `EpicChildrenService` (#424) belongs here for the same reason: it resolves an
 * epic to its children by READING GitHub — two endpoints and a markdown parse —
 * and has no write path and no database of its own.
 */
@Module({
  providers: [GitHubReadService, EpicChildrenService],
  exports: [GitHubReadService, EpicChildrenService],
})
export class GitHubReadModule {}
