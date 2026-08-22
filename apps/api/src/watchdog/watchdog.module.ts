import { Module } from '@nestjs/common';

import { WatchdogService } from './watchdog.service';

/**
 * Stall, loop and block detection.
 *
 * Imports nothing that can write — not to GitHub, not to a runner. The
 * watchdog's job is to notice and to compute what should happen; executing a
 * kill is Phase 4 (#61, #66), and the module having no capability to do it is
 * the same guarantee the reconciler core carries.
 */
@Module({
  providers: [WatchdogService],
  exports: [WatchdogService],
})
export class WatchdogModule {}
