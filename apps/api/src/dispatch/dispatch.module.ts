import { Module } from '@nestjs/common';

import { DispatchService } from './dispatch.service';

/**
 * Dispatch decisions.
 *
 * Deliberately holds no runner, no executor and no GitHub client: deciding
 * WHICH runner should take a work order is separate from handing it over, and
 * a module that could do both would make it easy to write a dispatcher that
 * decides and acts in one place with nothing recording the decision.
 */
@Module({
  providers: [DispatchService],
  exports: [DispatchService],
})
export class DispatchModule {}
