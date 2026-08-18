import {
  Controller,
  Get,
  Put,
  Patch,
  Body,
  Headers,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiHeader,
} from '@nestjs/swagger';

import { UserSettingsService } from './user-settings.service';
import { Auth } from '../../auth/decorators/auth.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../../common/constants/roles.constants';
import {
  UpdateUserSettingsDto,
  PatchUserSettingsDto,
} from '../dto/update-user-settings.dto';
import { UserSettingsResponseDto } from '../dto/user-settings-response.dto';

@ApiTags('User Settings')
@Controller('user-settings')
export class UserSettingsController {
  constructor(private readonly userSettingsService: UserSettingsService) {}

  @Get()
  @Auth({ permissions: [PERMISSIONS.USER_SETTINGS_READ] })
  @ApiOperation({ summary: 'Get current user settings' })
  @ApiResponse({
    status: 200,
    description: 'User settings',
    type: UserSettingsResponseDto,
  })
  async getSettings(@CurrentUser('id') userId: string) {
    return this.userSettingsService.getSettings(userId);
  }

  @Put()
  @Auth({ permissions: [PERMISSIONS.USER_SETTINGS_WRITE] })
  @ApiOperation({ summary: 'Replace user settings' })
  @ApiResponse({
    status: 200,
    description: 'Updated settings',
    type: UserSettingsResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Validation error' })
  async replaceSettings(
    @CurrentUser('id') userId: string,
    @Body() dto: UpdateUserSettingsDto,
  ) {
    return this.userSettingsService.replaceSettings(userId, dto);
  }

  @Patch()
  @Auth({ permissions: [PERMISSIONS.USER_SETTINGS_WRITE] })
  @ApiOperation({ summary: 'Partially update user settings' })
  @ApiHeader({
    name: 'If-Match',
    description: 'Expected version for optimistic concurrency',
    required: false,
  })
  @ApiResponse({
    status: 200,
    description: 'Updated settings',
    type: UserSettingsResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({ status: 409, description: 'Version conflict' })
  async patchSettings(
    @CurrentUser('id') userId: string,
    @Body() dto: PatchUserSettingsDto,
    @Headers('if-match') ifMatch?: string,
  ) {
    const expectedVersion = ifMatch ? parseInt(ifMatch, 10) : undefined;
    return this.userSettingsService.patchSettings(
      userId,
      dto,
      expectedVersion,
    );
  }
}
