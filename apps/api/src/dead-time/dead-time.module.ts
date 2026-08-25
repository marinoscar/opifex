import { Module } from '@nestjs/common';

import { DeadTimeService } from './dead-time.service';

/**
 * The dead-time ledger (#232) — VISION §10's metric 2.
 *
 * Provides the WRITER only. The arithmetic that turns the ledger into a number
 * is a pure function in `dead-time.ts`, imported directly by
 * `cockpit/metrics.service.ts` the same way it imports `stats` from
 * `escalations/detection-latency.ts` — a module dependency to reach a function
 * with no state would be ceremony around an import.
 */
@Module({
  providers: [DeadTimeService],
  exports: [DeadTimeService],
})
export class DeadTimeModule {}
