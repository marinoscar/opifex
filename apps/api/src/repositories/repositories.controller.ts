import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiDataResponse } from '../common/decorators/api-data-response.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import {
  AvailableRepositoriesService,
  type AvailableRepositories,
} from './available-repositories.service';
import {
  AvailableRepositoriesDto,
  ListAvailableRepositoriesQueryDto,
} from './dto/available-repository.dto';
import {
  LabelProvisioningReportDto,
  RegisteredRepositoryDto,
} from './dto/repository-labels.dto';
import {
  ListRepositoriesQueryDto,
  RegisterRepositoryDto,
  RepositoryResponseDto,
  RetireRepositoryDto,
  UpdateRepositoryDto,
} from './dto/repository.dto';
import { RepositoriesService } from './repositories.service';

/**
 * Which repositories Opifex watches.
 *
 * The permission strings here are the ones `apps/web/src/config/
 * destinations.ts` will gate the Projects destination on. That file's rule is
 * that a destination's permission is THE STRING ITS CONTROLLER ENFORCES,
 * verified against the controller rather than assumed — so `projects:read`
 * below is what the cockpit must use, and the destination flips from
 * `planned` to `live` against this controller, not against the constant.
 */
@ApiTags('Repositories')
@Controller('repositories')
export class RepositoriesController {
  constructor(
    private readonly repositories: RepositoriesService,
    private readonly available: AvailableRepositoriesService,
  ) {}

  @Get()
  @Auth({ permissions: [PERMISSIONS.PROJECTS_READ] })
  @ApiOperation({ summary: 'List registered repositories' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiQuery({ name: 'observeEnabled', required: false, type: Boolean })
  @ApiQuery({ name: 'dispatchEnabled', required: false, type: Boolean })
  @ApiQuery({
    name: 'retired',
    required: false,
    type: Boolean,
    description:
      'Filter on retirement. Omitted returns BOTH — a retired repository is still listed.',
  })
  @ApiQuery({
    name: 'projectId',
    required: false,
    type: String,
    description:
      'A project id, or the literal `none` for repositories in no project at all. ' +
      '`none` is a first-class answer rather than a missing one: every repository registered ' +
      'before projects existed is unassigned, and such a repository is still observed, still ' +
      'dispatchable and still walked up the enablement ladder.',
  })
  @ApiDataResponse(RepositoryResponseDto, {
    pagination: 'flat',
    description: 'Paginated repositories',
  })
  async list(@Query() query: ListRepositoriesQueryDto) {
    return this.repositories.list(query);
  }

  // DECLARED BEFORE `:id`, and it has to be: Nest matches routes in
  // declaration order, so below the parameterised route this literal path
  // would be swallowed by it and answer 400 from `ParseUUIDPipe` instead.
  @Get('available')
  // A read, gated as the list above is. It reveals what the credential can
  // reach, which is not public — but it reveals nothing `GET /api/repositories`
  // does not already imply about the same credential, so a second permission
  // would separate no duty and only make the screen harder to grant.
  @Auth({ permissions: [PERMISSIONS.PROJECTS_READ] })
  @ApiOperation({
    summary: 'List the repositories the configured GitHub credential can reach',
    description:
      'Answers what could be registered, so `owner/name` is chosen from a list rather than ' +
      'typed from memory. `github.token` is read per request, so a token saved a moment ago ' +
      'is the one used here.\n\n' +
      '**This is the token\u2019s scope, not the account\u2019s inventory.** Opifex ' +
      'authenticates with a fine-grained personal access token (ADR-0001), which grants ' +
      'access one repository at a time. A short list is the scope showing, and an EMPTY list ' +
      'is a successful answer — `status: "ok"` with `reachable: 0` and a `detail` saying the ' +
      'credential works and covers nothing.\n\n' +
      '**Every repository is listed, and the unaddable ones are MARKED.** `admission` is ' +
      '`available`, `registered` (already in the table — the 409 this endpoint exists to ' +
      'spare, with `repositoryId` pointing at the existing row) or `archived` (which ' +
      '`POST /api/repositories` refuses). Hiding either would leave an operator hunting for ' +
      'a repository they can see on GitHub.\n\n' +
      '**A failure is a 200 carrying a `status`, not an error status.** `no_credential` means ' +
      'none is configured; `invalid_credential` means GitHub rejected it; `refused` means it ' +
      'authenticated and is not permitted, so the remedy is the scope rather than the token; ' +
      '`rate_limited` means the hourly budget is spent and `detail` says until when; ' +
      '`unreachable` means nothing answered, so the credential was never judged; `failed` is ' +
      'anything else.\n\n' +
      '**Paginated over the whole reachable set**, with `search` applied first. `total` counts ' +
      'the matches and `reachable` counts what the token sees before searching, so a client ' +
      'can tell an empty search from an empty scope. If GitHub\u2019s listing hits its page ' +
      'cap, `truncated` is true and the list is not presented as complete.',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiQuery({
    name: 'search',
    required: false,
    type: String,
    description:
      'Case-insensitive substring over `owner/name`, applied to the reachable set. ' +
      'GitHub\u2019s search API is deliberately not used: it searches all of GitHub and would ' +
      'return public repositories this token cannot touch.',
  })
  @ApiDataResponse(AvailableRepositoriesDto, {
    description: 'What GitHub answered, or why it did not',
  })
  listAvailable(
    @Query() query: ListAvailableRepositoriesQueryDto,
  ): Promise<AvailableRepositories> {
    return this.available.list(query);
  }

  @Get(':id')
  @Auth({ permissions: [PERMISSIONS.PROJECTS_READ] })
  @ApiOperation({ summary: 'Get a registered repository' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiDataResponse(RepositoryResponseDto, { description: 'The repository' })
  @ApiResponse({ status: 404, description: 'Repository not found' })
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.repositories.findById(id);
  }

  @Post()
  @Auth({ permissions: [PERMISSIONS.PROJECTS_WRITE] })
  @ApiOperation({
    summary: 'Register a repository for Opifex to watch',
    description:
      'Verifies the repository is reachable with the configured GitHub credential before accepting it. ' +
      'Dispatch is off unless explicitly enabled.\n\n' +
      '**It also creates the factory label taxonomy on the repository** (#415). `factory:ready` is the ' +
      'whole eligibility signal, and GitHub\u2019s label picker only offers labels that exist \u2014 so a ' +
      'repository registered without them cannot be steered at all.\n\n' +
      '**Provisioning failing does NOT fail the registration.** ADR-0001 authenticates with a ' +
      'fine-grained personal access token, granted one repository and one permission at a time, and such ' +
      'a token emits no `x-oauth-scopes` header \u2014 whether it can create a label is unknowable until ' +
      'it is tried. So the repository is registered either way and `labelProvisioning` reports what ' +
      'happened: `ok` when every declared label is present, `refused` when the token authenticated and ' +
      'was not permitted (grant Issues: Read and write, then repair), and the other statuses for a ' +
      'missing credential, a 404, an exhausted budget or an unreachable GitHub. When the labels could ' +
      'not be read at all, every count on the report is null \u2014 null meaning NOT READ, never ' +
      'zero. Repair with `POST /api/repositories/{id}/labels`.',
  })
  @ApiDataResponse(RegisteredRepositoryDto, {
    status: 201,
    description: 'Repository registered, with what happened to its labels',
  })
  @ApiResponse({
    status: 400,
    description: 'Not reachable, archived, or invalid',
  })
  @ApiResponse({ status: 409, description: 'Already registered' })
  @ApiResponse({
    status: 503,
    description: 'The GitHub credential is missing or expired',
  })
  async register(@Body() dto: RegisterRepositoryDto) {
    return this.repositories.register(dto);
  }

  // The observed half of the ladder. `GET` reads, `POST` repairs — the pair
  // `POST /api/settings/probes/:probe` already established for "go and find
  // out what is actually true out there", answered with the same
  // `{ ok, detail, checkedAt }` triple rather than a parallel shape.
  @Get(':id/labels')
  @Auth({ permissions: [PERMISSIONS.PROJECTS_READ] })
  @ApiOperation({
    summary: 'Check which factory labels exist on a repository',
    description:
      'Asks GitHub which of the declared factory labels exist on this repository, and answers an ' +
      'OBSERVATION with a `checkedAt` \u2014 not a stored fact. Writes nothing.\n\n' +
      '**Per-label, not just a count.** `labels[]` names every declared label with `stateBefore` — ' +
      'what was found (`present`, `missing`, or `drifted` with the differences) — so a client can ' +
      'say WHICH label is missing. `present` / `declared` is the "N of M labels present" summary.\n\n' +
      '**Every count is null when the labels could not be read, and null means NOT READ rather than ' +
      'zero.** `declared`, `present`, `missing`, `created`, `updated`, `unchanged` and `failed` are ' +
      'null together whenever GitHub\u2019s label list was never obtained \u2014 a refused, expired ' +
      'or absent credential, a 404, an exhausted budget, an unreachable GitHub. A token that cannot ' +
      'read a repository\u2019s labels establishes nothing about what is on it, so rendering ' +
      '"0 of 15 present" from such a report would state a fact nobody found out. Check the null, not ' +
      'the `status`: a repair whose WRITE was refused still carries real counts, because its read ' +
      'succeeded.\n\n' +
      '**Three kinds are declared**: `input` (`factory:*`, the control surface \u2014 missing, the ' +
      'repository cannot be steered), `mirror` (`factory/*`, Opifex\u2019s own writes) and `routing` ' +
      '(`needs:*`, `tier:*` \u2014 missing, work still runs but only on the defaults). This ' +
      'repository\u2019s organisational labels (`bug`, `phase:*`, components) are deliberately not ' +
      'part of the taxonomy Opifex provisions.\n\n' +
      '**A failure is a 200 carrying a `status`**, not an error status: `refused` means the token ' +
      'authenticated and is not permitted, `not_found` means GitHub answered 404, `rate_limited` means ' +
      'the budget is spent, `unreachable` means nothing answered. `labels` is empty and every count is ' +
      'null in those cases.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiDataResponse(LabelProvisioningReportDto, {
    description: 'What GitHub has, as of checkedAt',
  })
  @ApiResponse({ status: 404, description: 'Repository not found' })
  async inspectLabels(@Param('id', ParseUUIDPipe) id: string) {
    return this.repositories.inspectLabels(id);
  }

  @Post(':id/labels')
  @Auth({ permissions: [PERMISSIONS.PROJECTS_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Create the missing factory labels on a repository',
    description:
      'The repair action for a repository registered while the GitHub token could not write labels. ' +
      'Creates every declared label that is missing and updates every one whose colour or description ' +
      'has drifted.\n\n' +
      '**It never deletes.** A label present on the repository and absent from the taxonomy is left ' +
      'alone: deleting a label strips it from every issue carrying it, and that is not recoverable from ' +
      'a declaration that knows names and colours but not which issues had them.\n\n' +
      '**Idempotent.** It reads first and writes only the difference, so running it twice creates ' +
      'nothing the second time and reports no error \u2014 `unchanged` counts the labels that needed ' +
      'nothing.\n\n' +
      '**Not gated by `github.writesEnabled`.** That switch governs whether the factory acts on issues ' +
      'during a tick; creating the taxonomy is operator setup, and gating it there would mean the ' +
      'observation week could not be set up without turning on the writes the switch exists to ' +
      'withhold.\n\n' +
      'Returns the same report as `GET`, with `attempted: true` and the `created` / `updated` / ' +
      '`failed` counts filled in. `attempted` means this call TRIED to write \u2014 not that the ' +
      'writes landed: a refused repair is `attempted: true` having written nothing, and the outcome ' +
      'is `status`, `created` and `failed`. A refusal is a 200 with `status: "refused"`. Note that a ' +
      'repair refused at the WRITE still carries real counts, since its read succeeded; only a report ' +
      'whose read failed has null counts.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiDataResponse(LabelProvisioningReportDto, {
    description: 'What was created or updated, and what remains',
  })
  @ApiResponse({ status: 404, description: 'Repository not found' })
  async repairLabels(@Param('id', ParseUUIDPipe) id: string) {
    return this.repositories.repairLabels(id);
  }

  @Patch(':id')
  @Auth({ permissions: [PERMISSIONS.PROJECTS_WRITE] })
  @ApiOperation({
    summary: 'Update a repository policy',
    description:
      'Enabling dispatch re-verifies reachability. Omitted fields are left unchanged.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiDataResponse(RepositoryResponseDto, {
    description: 'The updated repository',
  })
  @ApiResponse({ status: 404, description: 'Repository not found' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRepositoryDto,
  ) {
    return this.repositories.update(id, dto);
  }

  // POST and not PATCH, and a verb in the path, because this is an ACT rather
  // than an edit to a field: the caller does not get to compose the resulting
  // state. `POST /api/promotion/states/:actionClass/demote` is the same shape
  // for the same reason.
  @Post(':id/retire')
  @Auth({ permissions: [PERMISSIONS.PROJECTS_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Retire a repository',
    description:
      'Stands the repository down: `observeEnabled`, `mirrorLabelsEnabled`, `specFeedbackEnabled` ' +
      'and `dispatchEnabled` all off, in ONE transaction, with an `audit_events` row recording who ' +
      'did it and what rungs it was standing on.\n\n' +
      '**This is not a delete, and nothing is destroyed.** The repository stays in the registry and ' +
      'stays listed (`GET /api/repositories` returns it; filter with `retired`), and its work ' +
      'orders, runs and provenance are untouched. That is the point: `DELETE` is refused on a ' +
      'repository with work orders precisely because removing it would cascade that history away.\n\n' +
      '**Retired is a stored fact, not "all four flags are off".** All four off is also what four ' +
      'separate PATCHes produce, and an operator who muted observation for an afternoon has not ' +
      'retired anything. Read `retiredAt` to tell the two apart.\n\n' +
      '**Idempotent.** Retiring an already-retired repository returns it unchanged and writes no ' +
      'second audit row, so a retry after a dropped connection is not a second decision.\n\n' +
      'While retired, `PATCH /api/repositories/:id` refuses to turn any rung back on — that is what ' +
      'un-retiring is for. Everything else (budget ceiling, timeout, path constraints) stays editable.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiDataResponse(RepositoryResponseDto, {
    description: 'The retired repository',
  })
  @ApiResponse({ status: 404, description: 'Repository not found' })
  async retire(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RetireRepositoryDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.repositories.retire(id, dto, userId);
  }

  @Post(':id/unretire')
  @Auth({ permissions: [PERMISSIONS.PROJECTS_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Return a retired repository to the ladder',
    description:
      'Puts the repository back at the **bottom** of the enablement ladder: `observeEnabled` on, ' +
      'every outward write (`mirrorLabelsEnabled`, `specFeedbackEnabled`, `dispatchEnabled`) off — ' +
      'the same position a newly registered repository lands in.\n\n' +
      '**It does NOT restore the rungs the repository previously held.** Retiring is often the ' +
      'answer to a repository doing something unwanted, and silently switching dispatch back on ' +
      'would re-enable the factory\u2019s most consequential permission as a side effect of an undo. ' +
      'Ask for dispatch again with `PATCH`, which re-verifies reachability.\n\n' +
      '**Idempotent.** Un-retiring a repository that is not retired returns it unchanged and does ' +
      'not reset its ladder.\n\n' +
      'Recorded in `audit_events` in the same transaction as the change.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiDataResponse(RepositoryResponseDto, {
    description: 'The repository, back at the bottom of the ladder',
  })
  @ApiResponse({ status: 404, description: 'Repository not found' })
  async unretire(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RetireRepositoryDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.repositories.unretire(id, dto, userId);
  }

  @Delete(':id')
  @Auth({ permissions: [PERMISSIONS.PROJECTS_WRITE] })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'De-register a repository',
    description:
      'Refused while the repository has work orders — deleting would cascade away runs and their ' +
      'provenance. Retire it instead (`POST /api/repositories/:id/retire`), which stands the whole ' +
      'ladder down in one act and leaves that history in place.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 204, description: 'Repository de-registered' })
  @ApiResponse({ status: 400, description: 'Repository has work orders' })
  @ApiResponse({ status: 404, description: 'Repository not found' })
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    await this.repositories.remove(id);
  }
}
