import { Module } from '@nestjs/common';

import { EscalationsController } from './escalations.controller';
import { EscalationsService } from './escalations.service';

/**
 * Escalation records and their lifecycle.
 *
 * No transport here. #58 adds one, behind a seam, so that "we raised it" and
 * "we managed to tell someone" stay separate facts — which is the distinction
 * the lifecycle exists to record.
 */
@Module({
  controllers: [EscalationsController],
  providers: [EscalationsService],
  exports: [EscalationsService],
})
export class EscalationsModule {}
