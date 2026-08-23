import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  Body,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';

import { AllowlistService } from './allowlist.service';
import { ApiDataResponse } from '../common/decorators/api-data-response.decorator';
import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { AddEmailDto } from './dto/add-email.dto';
import { AllowlistQueryDto } from './dto/allowlist-query.dto';
import { AllowlistEntryDto } from './dto/allowlist-response.dto';

@ApiTags('Allowlist')
@Controller('allowlist')
export class AllowlistController {
  constructor(private readonly allowlistService: AllowlistService) {}

  @Get()
  @Auth({ permissions: [PERMISSIONS.ALLOWLIST_READ] })
  @ApiOperation({ summary: 'List allowlisted emails (Admin only)' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['all', 'pending', 'claimed'],
  })
  @ApiQuery({
    name: 'sortBy',
    required: false,
    enum: ['email', 'addedAt', 'claimedAt'],
  })
  @ApiQuery({ name: 'sortOrder', required: false, enum: ['asc', 'desc'] })
  @ApiDataResponse(AllowlistEntryDto, {
    pagination: 'flat',
    description: 'Paginated allowlist',
  })
  async listAllowedEmails(@Query() query: AllowlistQueryDto) {
    return this.allowlistService.listAllowedEmails(query);
  }

  @Post()
  @Auth({ permissions: [PERMISSIONS.ALLOWLIST_WRITE] })
  @ApiOperation({ summary: 'Add email to allowlist (Admin only)' })
  @ApiDataResponse(AllowlistEntryDto, {
    status: 201,
    description: 'Email added to allowlist',
  })
  @ApiResponse({ status: 409, description: 'Email already in allowlist' })
  async addEmail(
    @Body() dto: AddEmailDto,
    @CurrentUser('id') adminUserId: string,
  ) {
    return this.allowlistService.addEmail(dto, adminUserId);
  }

  @Delete(':id')
  @Auth({ permissions: [PERMISSIONS.ALLOWLIST_WRITE] })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove email from allowlist (Admin only)' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 204, description: 'Email removed from allowlist' })
  @ApiResponse({ status: 404, description: 'Allowlist entry not found' })
  @ApiResponse({ status: 400, description: 'Cannot remove claimed entry' })
  async removeEmail(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') adminUserId: string,
  ) {
    await this.allowlistService.removeEmail(id, adminUserId);
  }
}
