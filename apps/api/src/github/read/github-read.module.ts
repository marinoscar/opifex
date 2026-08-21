import { Module } from '@nestjs/common';

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
 */
@Module({
  providers: [GitHubReadService],
  exports: [GitHubReadService],
})
export class GitHubReadModule {}
