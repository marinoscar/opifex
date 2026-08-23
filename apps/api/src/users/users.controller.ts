import {
  Controller,
  Get,
  Patch,
  Put,
  Param,
  Query,
  Body,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';

import { UsersService } from './users.service';
import { ApiDataResponse } from '../common/decorators/api-data-response.decorator';
import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { UserListQueryDto } from './dto/user-list-query.dto';
import {
  UserDetailResponseDto,
  UserResponseDto,
} from './dto/user-response.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UpdateUserRolesDto } from './dto/update-user-roles.dto';

@ApiTags('Users')
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  @Auth({ permissions: [PERMISSIONS.USERS_READ] })
  @ApiOperation({ summary: 'List users (Admin only)' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({ name: 'role', required: false, type: String })
  // Not `type: Boolean`: the zod query schema accepts the literal strings
  // 'true' and 'false' and rejects anything else, so a documented boolean would
  // invite `isActive=1` and a 400.
  @ApiQuery({ name: 'isActive', required: false, enum: ['true', 'false'] })
  @ApiQuery({
    name: 'sortBy',
    required: false,
    enum: ['email', 'createdAt', 'updatedAt'],
  })
  @ApiQuery({ name: 'sortOrder', required: false, enum: ['asc', 'desc'] })
  @ApiDataResponse(UserResponseDto, {
    pagination: 'flat',
    description: 'Paginated user list',
  })
  async listUsers(@Query() query: UserListQueryDto) {
    return this.usersService.listUsers(query);
  }

  @Get(':id')
  @Auth({ permissions: [PERMISSIONS.USERS_READ] })
  @ApiOperation({ summary: 'Get user by ID (Admin only)' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiDataResponse(UserDetailResponseDto, { description: 'User details' })
  @ApiResponse({ status: 404, description: 'User not found' })
  async getUserById(@Param('id', ParseUUIDPipe) id: string) {
    return this.usersService.getUserById(id);
  }

  @Patch(':id')
  @Auth({ permissions: [PERMISSIONS.USERS_READ, PERMISSIONS.USERS_WRITE] })
  @ApiOperation({ summary: 'Update user (Admin only)' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiDataResponse(UserResponseDto, { description: 'Updated user' })
  @ApiResponse({ status: 404, description: 'User not found' })
  @ApiResponse({ status: 403, description: 'Cannot deactivate self' })
  async updateUser(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserDto,
    @CurrentUser('id') adminUserId: string,
  ) {
    return this.usersService.updateUser(id, dto, adminUserId);
  }

  @Put(':id/roles')
  @Auth({ permissions: [PERMISSIONS.RBAC_MANAGE] })
  @ApiOperation({ summary: 'Update user roles (Admin only)' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Updated user with new roles' })
  @ApiResponse({ status: 404, description: 'User not found' })
  @ApiResponse({ status: 400, description: 'Invalid role names' })
  @ApiResponse({ status: 403, description: 'Cannot remove own admin role' })
  async updateUserRoles(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserRolesDto,
    @CurrentUser('id') adminUserId: string,
  ) {
    return this.usersService.updateUserRoles(id, dto, adminUserId);
  }
}
