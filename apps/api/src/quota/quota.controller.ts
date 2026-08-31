import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';

import { Auth } from '../auth/decorators/auth.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { ApiDataResponse } from '../common/decorators/api-data-response.decorator';
import {
  ExhaustedWindowDto,
  QuotaEventsQueryDto,
  QuotaWindowsQueryDto,
  RateLimitEpisodeDto,
} from './dto/quota-history.dto';
import { QuotaSummaryDto } from './dto/quota.dto';
import { QuotaHistoryService } from './quota-history.service';
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
 *
 * ## The live gauge, and the memory (#476)
 *
 * `GET /quota` is a gauge: it reads windows that have not yet rolled and says
 * where the fleet stands NOW. An episode an hour old is invisible to it, so
 * "we lost an afternoon; was it quota, and did the system handle it?" had no
 * endpoint at all. `GET /quota/events` and `GET /quota/windows` are that
 * memory, assembled from rows already being written — no new table, per #476
 * and ADR-0018 §1.
 *
 * All three are gated identically on `runs:read`, and the two history routes
 * deliberately introduce no permission of their own: they serve the same
 * `run_events` and `quota_windows` rows the gauge and the run timeline already
 * serve, read a different way, and a separate string would let somebody read
 * blocks on runs they cannot open.
 *
 * Every handler here is READ-ONLY. Nothing in this controller, or in the two
 * services behind it, writes a row.
 */
@ApiTags('Quota')
@Controller('quota')
export class QuotaController {
  constructor(
    private readonly quota: QuotaService,
    private readonly history: QuotaHistoryService,
  ) {}

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

  @Get('events')
  @Auth({ permissions: [PERMISSIONS.RUNS_READ] })
  @ApiOperation({
    summary: 'Rate-limit episodes: when a run was blocked, and what Opifex did',
    description:
      'The history `GET /api/quota` has no memory of (#476). One entry per `run.blocked` event ' +
      'that named a SUBSCRIPTION-level reason, newest first. `reason` stays `rate-limit` or ' +
      '`quota-exhausted` and is never flattened into one word: an overage refused while the ' +
      'window is still live and a window that is actually spent are different operational ' +
      'facts, and the first usually clears in minutes. The blocks that name `awaiting-approval`, ' +
      '`upstream-unavailable` or `unknown` are absent — those are facts about one run, not about ' +
      'the subscription. `disposition` is the point of the endpoint: `parked` (still blocked, ' +
      'resume scheduled), `awaiting-park` (blocked, nothing scheduled yet), `escalated` (a human ' +
      'was told inside this episode), `resumed` (the run reported again), `concluded` (the run ' +
      'reached a terminal state after the block) or `unknown`. `unknown` is a REAL answer and is ' +
      'returned in preference to a guess — `dispositionBasis` names the observation every verdict ' +
      'came from, so no row has to be taken on trust. `resumesAt` is populated only for an ' +
      'episode a run is STILL sitting in, because `Run.resumesAt` describes the current block ' +
      'and reading it back onto a week-old one would credit a park to a block long over. ' +
      '`nextActivityAt` and `durationMs` are an UPPER BOUND on how long the episode lasted, from ' +
      'the run blocking again or from `Run.lastEventAt`; nothing writes `RunAttempt` rows today, ' +
      'so the exact resume instant is not stored anywhere to report. `window` is the ' +
      '`quota_windows` row the block named, matched on the runner and the EXACT reset instant — ' +
      'null means no stored window carries that instant, never a nearest-window guess. Note that ' +
      "until #475 lands nothing writes `Run.status = 'blocked'`, so `parked` and " +
      '`awaiting-park` are unreachable and recent episodes read `resumed`, `concluded` or ' +
      '`unknown`.',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiQuery({
    name: 'since',
    required: false,
    type: String,
    description: 'Inclusive ISO lower bound on `occurredAt`.',
  })
  @ApiQuery({
    name: 'until',
    required: false,
    type: String,
    description: 'Inclusive ISO upper bound on `occurredAt`.',
  })
  @ApiQuery({ name: 'runnerKey', required: false, type: String })
  @ApiQuery({
    name: 'reason',
    required: false,
    enum: ['rate-limit', 'quota-exhausted'],
  })
  @ApiDataResponse(RateLimitEpisodeDto, {
    pagination: 'flat',
    description: 'Paginated rate-limit episodes, newest first',
  })
  async events(@Query() query: QuotaEventsQueryDto) {
    return this.history.episodes(query);
  }

  @Get('windows')
  @Auth({ permissions: [PERMISSIONS.RUNS_READ] })
  @ApiOperation({
    summary:
      'Windows that ever hit the wall, including ones that blocked nothing',
    description:
      'The `quota_windows` half of #476, and a SIBLING endpoint rather than a second array on ' +
      '/api/quota/events on purpose: both lists are offset-paginated, and an unpaginated sibling ' +
      'array either repeats in full on every page or exists only on page 1, which is a contract ' +
      'no generated client can model. The two also order and filter differently — episodes by ' +
      '`occurredAt` and by `reason`, windows by `resetsAt` and by nothing of the kind. Selected ' +
      'on `peakPressure` reaching `exhausted`, NOT on `pressure`: `pressure` forgets the wall the ' +
      "moment the vendor says `allowed` again, which is the distinction `QuotaWindow`'s own " +
      'schema comment keeps the two columns apart for, and this endpoint is read after the fact ' +
      'by definition. `blockedRuns: 0` is the case this endpoint exists for — a window that ' +
      'reached its ceiling with nothing dispatched against it leaves no `run_events` row at all ' +
      'and is invisible to /api/quota/events, while still being a true answer to "when did we hit ' +
      'rate limits". `since`/`until` test OVERLAP against the window\'s observation span ' +
      '(`lastObservedAt >= since AND firstObservedAt <= until`), not equality against a single ' +
      'instant, so a window first sighted before the range and still exhausted inside it is ' +
      'returned.',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiQuery({
    name: 'since',
    required: false,
    type: String,
    description:
      'ISO lower bound; matches windows still observed at or after it.',
  })
  @ApiQuery({
    name: 'until',
    required: false,
    type: String,
    description:
      'ISO upper bound; matches windows first observed at or before it.',
  })
  @ApiQuery({ name: 'runnerKey', required: false, type: String })
  @ApiDataResponse(ExhaustedWindowDto, {
    pagination: 'flat',
    description: 'Paginated exhausted windows, newest reset first',
  })
  async windows(@Query() query: QuotaWindowsQueryDto) {
    return this.history.exhaustedWindows(query);
  }
}
