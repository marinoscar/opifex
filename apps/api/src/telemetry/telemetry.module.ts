import { Global, Module } from '@nestjs/common';

import { FactoryMetrics } from './factory-metrics.service';

/**
 * Factory telemetry: success metric 1 and the work-order trace.
 *
 * Global because measurement is cross-cutting — ingestion, the watchdog and
 * the notification transport all record into it, and threading a module
 * import through each of them would make instrumenting a new component a
 * wiring exercise, which is how components end up uninstrumented.
 */
@Global()
@Module({
  providers: [FactoryMetrics],
  exports: [FactoryMetrics],
})
export class TelemetryModule {}
