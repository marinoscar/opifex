import { Global, Module } from '@nestjs/common';

import { OperatorSettingsService } from './operator-settings.service';

/**
 * The operator settings read path (#335, epic #332).
 *
 * ## Why `@Global`
 *
 * The same reason `GitHubModule` is: this is a leaf with no dependencies of
 * its own that nearly every feature module will read from once #340 migrates
 * the consumers off `ConfigService`. Importing it into twenty modules would
 * add twenty edits to that migration and communicate nothing — the same
 * argument `ConfigModule.forRoot({ isGlobal: true })` already makes in
 * `app.module.ts` for the thing this replaces.
 *
 * ## What is deliberately not here yet
 *
 * No controller, no Prisma dependency and no refresh loop. #336 adds the
 * table, #338 the endpoints and #339 the database overlay. Keeping this module
 * dependency-free until then means it can be imported from anywhere — including
 * from a spec's testing module — without dragging a database in behind it.
 */
@Global()
@Module({
  providers: [OperatorSettingsService],
  exports: [OperatorSettingsService],
})
export class OperatorSettingsModule {}
