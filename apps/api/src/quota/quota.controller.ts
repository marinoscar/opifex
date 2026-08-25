import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { Auth } from '../auth/decorators/auth.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { ApiDataResponse } from '../common/decorators/api-data-response.decorator';
import { QuotaSummaryDto } from './dto/quota.dto';
import { QuotaService } from './quota.service';

/**
 * The agent subscription's rate-limit windows (#231).
 *
 * Gated on `runs:read`, which is what it reads: the consumption figures are
 * sums over run events, and gating an aggregate more loosely than its rows
 * would let somebody total up runs they cannot open — the same argument
 * `CostController` makes.
 *
 * Deliberately its own route rather than a field on the cost summary. Cost is
 * money and quota is a window, they are measured to different standards, and
 * `CostSummaryDto.quota` says so by being permanently null. A screen showing
 * both (#86) reads two endpoints, which is honest about the two being
 * different kinds of fact.
 */
@ApiTags('Quota')
@Controller('quota')
export class QuotaController {
  constructor(private readonly quota: QuotaService) {}

  @Get()
  @Auth({ permissions: [PERMISSIONS.RUNS_READ] })
  @ApiOperation({
    summary: 'Vendor quota windows, and Opifex’s own consumption through them',
    description:
      '`burnFraction` is ALWAYS null, and that is the point of this endpoint rather than an ' +
      'omission from it. VISION §10’s metric 6 is consumption over window capacity; no vendor ' +
      'publishes a capacity (there is no non-interactive API at all, #102) and no runner can ' +
      'declare one. Worse, the numerator would be incomplete even with a capacity: VISION §11’s ' +
      'subscription is SHARED with the operator’s own interactive use, which burns the same ' +
      'window and leaves no record here. So `opifexConsumption` is named for whose consumption ' +
      'it is, and no ratio is offered for anyone to mistake for a burn rate. What IS real: ' +
      '`resetsAt` is the vendor’s own reset instant, and `pressure` is the vendor’s own ordinal ' +
      'reading — `warning` being the only signal in the system that arrives before a run is ' +
      'parked. A runner that has reported no rate-limit signal is ABSENT from `runners` rather ' +
      'than present with zeroes: unknown is not zero. Each runner carries EVERY window that ' +
      'has not yet rolled, soonest reset first, plus a `position` saying which of them binds ' +
      'and when it lifts — a runner holds a `five_hour` and a `weekly` at once, and reporting ' +
      'only one of them hid an exhausted short window behind a healthy long one (#301). ' +
      '`position` is null for UNKNOWN, never for healthy, and comes from the same function ' +
      'dispatch routes on, so this endpoint and the fleet answer "can this runner work now" ' +
      'identically.',
  })
  @ApiDataResponse(QuotaSummaryDto, {
    description:
      'One entry per runner with at least one live window, carrying all of them',
  })
  async summary() {
    const now = new Date();
    return {
      generatedAt: now.toISOString(),
      runners: await this.quota.readings(now),
    };
  }
}
