import { Module } from '@nestjs/common';

import { AuditEventsController } from './audit-events.controller';
import { AuditEventsService } from './audit-events.service';

/**
 * The audit log read model (#338, epic #332).
 *
 * Read-only, and it stays that way. Writing an audit row is something each
 * service does for its own actions, beside the change it is recording and
 * inside the same reasoning — a shared writer would invite a caller to record
 * an event that did not happen, or to forget one that did. This module exposes
 * no service to anything else for the same reason: nothing in the API should
 * need to read the audit log except the endpoint that serves it.
 */
@Module({
  controllers: [AuditEventsController],
  providers: [AuditEventsService],
})
export class AuditEventsModule {}
