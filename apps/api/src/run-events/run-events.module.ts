import { Module } from '@nestjs/common';

import { RunEventValidator } from './run-event-validator';
import { RunEventsController } from './run-events.controller';
import { RunEventsService } from './run-events.service';

/**
 * Runner-reported event ingestion.
 *
 * No GitHub module at all: a runner posts to Opifex, and nothing in this path
 * reads or writes a repository. The git-derived source is a separate module
 * (#52) for the same reason VISION §9 calls them two INDEPENDENT liveness
 * sources — independence that shares a module is not independence.
 */
@Module({
  controllers: [RunEventsController],
  providers: [RunEventValidator, RunEventsService],
  exports: [RunEventsService],
})
export class RunEventsModule {}
