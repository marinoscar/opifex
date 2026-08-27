import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
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
import { PERMISSIONS } from '../common/constants/roles.constants';
import { ApiDataResponse } from '../common/decorators/api-data-response.decorator';
import { RepositoryResponseDto } from '../repositories/dto/repository.dto';
import {
  CreateProjectDto,
  ListProjectsQueryDto,
  ProjectDeletionResponseDto,
  ProjectResponseDto,
  UpdateProjectDto,
} from './dto/project.dto';
import { ProjectsService } from './projects.service';

/**
 * Projects — the grouping repositories are managed inside (epic #403).
 *
 * Gated on `projects:read` / `projects:write`, the same pair
 * `RepositoriesController` enforces, because a project is administered by
 * whoever administers the repositories in it. A project carries no authority
 * of its own: nothing reads `projectId` to decide whether a run may happen.
 */
@ApiTags('Projects')
@Controller('projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  @Auth({ permissions: [PERMISSIONS.PROJECTS_READ] })
  @ApiOperation({
    summary: 'List projects',
    description:
      'Each row carries `repositoryCount`, so a list does not cost one request per project to be ' +
      'useful.\n\n**Repositories with no project are not listed here and are not missing.** ' +
      '`projectId: null` is a first-class state — every repository registered before projects ' +
      'existed is in it, and such a repository is still observed, still dispatchable and still ' +
      'walked up the enablement ladder. Ask for them with ' +
      '`GET /api/repositories?projectId=none`.',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiQuery({
    name: 'search',
    required: false,
    type: String,
    description: 'Case-insensitive substring over the name and the slug.',
  })
  @ApiDataResponse(ProjectResponseDto, {
    pagination: 'flat',
    description: 'Paginated projects',
  })
  async list(@Query() query: ListProjectsQueryDto) {
    return this.projects.list(query);
  }

  @Get(':id')
  @Auth({ permissions: [PERMISSIONS.PROJECTS_READ] })
  @ApiOperation({ summary: 'Get a project' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiDataResponse(ProjectResponseDto, { description: 'The project' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.projects.findById(id);
  }

  @Post()
  @Auth({ permissions: [PERMISSIONS.PROJECTS_WRITE] })
  @ApiOperation({
    summary: 'Create a project',
    description:
      '`slug` is optional and is derived from `name` when omitted — `"Billing Platform"` becomes ' +
      '`billing-platform`.\n\n**A taken slug is refused, never silently suffixed.** Appending ' +
      '`-2` would hand back a handle nobody chose and nobody can predict, and would leave every ' +
      'later reference to the original slug pointing at somebody else’s project. The 409 ' +
      'names the slug that collided, including when it was derived and the caller never typed ' +
      'it.\n\nA name with no character in the slug alphabet (`"日本語"`) derives nothing and is a ' +
      '400 asking for an explicit slug, rather than a generated identifier nobody can remember.',
  })
  @ApiDataResponse(ProjectResponseDto, {
    status: 201,
    description: 'Project created',
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid, or no slug could be derived from the name',
  })
  @ApiResponse({ status: 409, description: 'That slug is already taken' })
  async create(@Body() dto: CreateProjectDto) {
    return this.projects.create(dto);
  }

  @Patch(':id')
  @Auth({ permissions: [PERMISSIONS.PROJECTS_WRITE] })
  @ApiOperation({
    summary: 'Update a project',
    description:
      'Omitted fields are left unchanged. **Renaming does not move the slug**: derivation happens ' +
      'once, at creation, because the slug is the stable handle everything else referenced. ' +
      'Changing it is possible and has to be asked for explicitly.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiDataResponse(ProjectResponseDto, { description: 'The updated project' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  @ApiResponse({ status: 409, description: 'That slug is already taken' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProjectDto,
  ) {
    return this.projects.update(id, dto);
  }

  @Delete(':id')
  @Auth({ permissions: [PERMISSIONS.PROJECTS_WRITE] })
  @ApiOperation({
    summary: 'Delete a project, leaving its repositories registered',
    description:
      '**The repositories in it are NOT deleted.** They become unassigned — still registered, ' +
      'still observed, still dispatchable — which is the same state every repository was in ' +
      'before projects existed. The response says how many, so a caller can report it rather ' +
      'than infer it.\n\nUnlike `DELETE /api/repositories/:id`, this is never refused for having ' +
      'contents. A project owns no work orders, no runs and no events, so nothing in the ' +
      'provenance graph VISION §5 protects depends on it; the only thing removed is the ' +
      'label.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiDataResponse(ProjectDeletionResponseDto, {
    description: 'The project is gone; its repositories are unassigned',
  })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.projects.remove(id);
  }

  @Put(':id/repositories/:repositoryId')
  @Auth({ permissions: [PERMISSIONS.PROJECTS_WRITE] })
  @ApiOperation({
    summary: 'Assign a repository to this project',
    description:
      'Idempotent, and it MOVES: a repository already in another project is reassigned to this ' +
      'one. Equivalent to `PATCH /api/repositories/{repositoryId}` with `projectId`, and runs ' +
      'the same code — this spelling exists because repositories are managed from inside a ' +
      'project, so the project is the resource the caller already has.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiParam({ name: 'repositoryId', type: String, format: 'uuid' })
  @ApiDataResponse(RepositoryResponseDto, {
    description: 'The repository, now in this project',
  })
  @ApiResponse({ status: 404, description: 'Project or repository not found' })
  async assignRepository(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('repositoryId', ParseUUIDPipe) repositoryId: string,
  ) {
    return this.projects.assignRepository(id, repositoryId);
  }

  @Delete(':id/repositories/:repositoryId')
  @Auth({ permissions: [PERMISSIONS.PROJECTS_WRITE] })
  @ApiOperation({
    summary: 'Remove a repository from this project',
    description:
      '**Removes the grouping, not the repository.** It stays registered and becomes unassigned.' +
      '\n\n404 when the repository is in a DIFFERENT project: this path asserts the repository ' +
      'is in this one, and acting anyway would let a stale screen unassign it from wherever it ' +
      'was actually moved to.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiParam({ name: 'repositoryId', type: String, format: 'uuid' })
  @ApiDataResponse(RepositoryResponseDto, {
    description: 'The repository, now unassigned',
  })
  @ApiResponse({
    status: 404,
    description: 'Project not found, or the repository is not in it',
  })
  async unassignRepository(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('repositoryId', ParseUUIDPipe) repositoryId: string,
  ) {
    return this.projects.unassignRepository(id, repositoryId);
  }
}
