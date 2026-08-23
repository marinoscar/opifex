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
  constructor(private readonly repositories: RepositoriesService) {}

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
