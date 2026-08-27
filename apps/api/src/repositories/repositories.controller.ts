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
  ListRepositoriesQueryDto,
  RegisterRepositoryDto,
  RepositoryResponseDto,
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
    name: 'projectId',
    required: false,
    type: String,
    format: 'uuid',
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
      'Dispatch is off unless explicitly enabled.',
  })
  @ApiDataResponse(RepositoryResponseDto, {
    status: 201,
    description: 'Repository registered',
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

  @Delete(':id')
  @Auth({ permissions: [PERMISSIONS.PROJECTS_WRITE] })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'De-register a repository',
    description:
      'Refused while the repository has work orders — deleting would cascade away runs and their ' +
      'provenance. Disable observation and dispatch instead.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 204, description: 'Repository de-registered' })
  @ApiResponse({ status: 400, description: 'Repository has work orders' })
  @ApiResponse({ status: 404, description: 'Repository not found' })
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    await this.repositories.remove(id);
  }
}
