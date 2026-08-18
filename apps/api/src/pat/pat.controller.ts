import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
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
} from '@nestjs/swagger';

import { PatService } from './pat.service';
import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CreatePatDto } from './dto/create-pat.dto';
import { PatCreatedResponseDto, PatListItemDto } from './dto/pat-response.dto';

@ApiTags('Personal Access Tokens')
@Controller('pat')
export class PatController {
  constructor(private readonly patService: PatService) {}

  @Post()
  @Auth()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new Personal Access Token' })
  @ApiResponse({
    status: 201,
    description: 'Token created - raw token is shown only once',
    type: PatCreatedResponseDto,
  })
  async createToken(
    @Body() dto: CreatePatDto,
    @CurrentUser('id') userId: string,
  ): Promise<PatCreatedResponseDto> {
    return this.patService.createToken(userId, dto);
  }

  @Get()
  @Auth()
  @ApiOperation({ summary: 'List all Personal Access Tokens for current user' })
  @ApiResponse({
    status: 200,
    description: 'List of PATs (raw tokens are never returned in list)',
    type: [PatListItemDto],
  })
  async listTokens(@CurrentUser('id') userId: string): Promise<PatListItemDto[]> {
    const tokens = await this.patService.listTokens(userId);
    return tokens.map((t: typeof tokens[number]) => ({
      id: t.id,
      name: t.name,
      tokenPrefix: t.tokenPrefix,
      durationValue: t.durationValue,
      durationUnit: t.durationUnit,
      expiresAt: t.expiresAt.toISOString(),
      lastUsedAt: t.lastUsedAt ? t.lastUsedAt.toISOString() : null,
      createdAt: t.createdAt.toISOString(),
      revokedAt: t.revokedAt ? t.revokedAt.toISOString() : null,
    }));
  }

  @Delete(':id')
  @Auth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke a Personal Access Token' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 204, description: 'Token revoked successfully' })
  @ApiResponse({ status: 404, description: 'Token not found or already revoked' })
  async revokeToken(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') userId: string,
  ): Promise<void> {
    await this.patService.revokeToken(userId, id);
  }
}
