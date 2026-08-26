import { Global, Module } from '@nestjs/common';

import { OperatorSettingsService } from '../settings/operator-settings/operator-settings.service';
import { EtagCacheService } from './etag-cache.service';
import { GitHubHttpService } from './github-http.service';
import { RateLimitService } from './rate-limit.service';

/**
 * The GitHub transport: authentication, rate-limit accounting, conditional
 * requests, retry and pagination.
 *
 * Exports the pipeline and its two pieces of state, and NOTHING that knows
 * what an issue or a label is. The read adapters (#41) and write adapters
 * (#42) are separate modules built on this one, which is what lets the
 * read-only reconciler import read capability without write capability coming
 * along — VISION §12 requires the reconciler to run read-only for a week, and
 * "we promise not to call the write method" is a convention that one refactor
 * will break, not a boundary.
 */
@Global()
@Module({
  providers: [
    RateLimitService,
    {
      provide: EtagCacheService,
      // A factory rather than an injected settings lookup inside the service:
      // the cache is a data structure with a size bound, and giving it a
      // settings dependency would make it awkward to construct in a test at a
      // size a test can actually fill. The registry declares this key
      // `restart` for the same reason — resizing a live cache is a different
      // operation from building one.
      useFactory: (settings: OperatorSettingsService) =>
        new EtagCacheService(settings.get('github.etagCacheMaxEntries')),
      inject: [OperatorSettingsService],
    },
    GitHubHttpService,
  ],
  exports: [GitHubHttpService, RateLimitService, EtagCacheService],
})
export class GitHubModule {}

// `GitHubReadModule` is NOT re-exported here, and neither will the write
// module be. Importing the transport must not confer either capability —
// a consumer asks for read access explicitly, which is what makes the
// read-only guarantee visible in its imports list rather than buried in a
// module graph.
