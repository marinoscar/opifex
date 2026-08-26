import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';

import { AuditEventsService } from './audit-events.service';
import { Auth } from '../auth/decorators/auth.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { ApiDataResponse } from '../common/decorators/api-data-response.decorator';
import { AuditEventListQueryDto } from './dto/audit-event-list-query.dto';
import { AuditEventResponseDto } from './dto/audit-event-response.dto';

/**
 * The audit log, readable at last (#338, epic #332).
 *
 * ## Why `system_settings:read` and not a new `audit:read`
 *
 * The audit log is an administrative record, and `system_settings:read` is
 * already the permission that separates an administrator from a contributor in
 * this system — the seed grants it to `admin` alone. Minting a second string
 * with exactly that membership would add a permission an operator has to
 * reason about and grant, while gating precisely the same set of people.
 *
 * `roles.constants.ts` is explicit that these strings are a contract with the
 * frontend and that the set is deliberately small, because VISION §11 has
 * Opifex as single-operator by design. This endpoint is the History section of
 * the Control Center, and a Control Center reader is a system-settings reader.
 * If the audit log ever grows a consumer that is not, that is the moment to
 * split it — not before.
 */
@ApiTags('Audit Events')
@Controller('audit-events')
export class AuditEventsController {
  constructor(private readonly auditEvents: AuditEventsService) {}

  @Get()
  @Auth({ permissions: [PERMISSIONS.SYSTEM_SETTINGS_READ] })
  @ApiOperation({
    summary: 'List audit events (Admin only)',
    description:
      'Every recorded action, newest first, filterable by what it acted on. `targetType` is ' +
      'the useful one: `operator_settings` for configuration changes, with `targetId` being ' +
      'the setting key.\n\n' +
      '`meta` is redacted on the way out as well as on the way in, so a credential logged in ' +
      'the clear by an older build is not served by this endpoint.',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiQuery({ name: 'targetType', required: false, type: String })
  @ApiQuery({ name: 'targetId', required: false, type: String })
  @ApiQuery({ name: 'action', required: false, type: String })
  @ApiQuery({
    name: 'actorUserId',
    required: false,
    type: String,
    format: 'uuid',
  })
  @ApiQuery({
    name: 'since',
    required: false,
    type: String,
    format: 'date-time',
  })
  @ApiQuery({
    name: 'until',
    required: false,
    type: String,
    format: 'date-time',
  })
  @ApiQuery({ name: 'sortOrder', required: false, enum: ['asc', 'desc'] })
  @ApiDataResponse(AuditEventResponseDto, {
    pagination: 'flat',
    description: 'Paginated audit events',
  })
  async list(@Query() query: AuditEventListQueryDto) {
    return this.auditEvents.list(query);
  }
}
