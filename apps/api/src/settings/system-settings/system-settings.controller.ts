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

import { SystemSettingsService } from './system-settings.service';
import { Auth } from '../../auth/decorators/auth.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../../common/constants/roles.constants';
import {
  UpdateSystemSettingsDto,
  PatchSystemSettingsDto,
} from '../dto/update-system-settings.dto';
import { SystemSettingsResponseDto } from '../dto/system-settings-response.dto';

@ApiTags('System Settings')
@Controller('system-settings')
export class SystemSettingsController {
  constructor(private readonly systemSettingsService: SystemSettingsService) {}

  @Get()
  @Auth({ permissions: [PERMISSIONS.SYSTEM_SETTINGS_READ] })
  @ApiOperation({ summary: 'Get system settings (Admin only)' })
  @ApiResponse({
    status: 200,
    description: 'System settings',
    type: SystemSettingsResponseDto,
  })
  async getSettings() {
    return this.systemSettingsService.getSettings();
  }

  @Put()
  @Auth({ permissions: [PERMISSIONS.SYSTEM_SETTINGS_WRITE] })
  @ApiOperation({ summary: 'Replace system settings (Admin only)' })
  @ApiResponse({
    status: 200,
    description: 'Updated settings',
    type: SystemSettingsResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Validation error' })
  async replaceSettings(
    @Body() dto: UpdateSystemSettingsDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.systemSettingsService.replaceSettings(dto, userId);
  }

  @Patch()
  @Auth({ permissions: [PERMISSIONS.SYSTEM_SETTINGS_WRITE] })
  @ApiOperation({ summary: 'Partially update system settings (Admin only)' })
  @ApiHeader({
    name: 'If-Match',
    description: 'Expected version for optimistic concurrency',
    required: false,
  })
  @ApiResponse({
    status: 200,
    description: 'Updated settings',
    type: SystemSettingsResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({ status: 409, description: 'Version conflict' })
  async patchSettings(
    @Body() dto: PatchSystemSettingsDto,
    @CurrentUser('id') userId: string,
    @Headers('if-match') ifMatch?: string,
  ) {
    const expectedVersion = ifMatch ? parseInt(ifMatch, 10) : undefined;
    return this.systemSettingsService.patchSettings(dto, userId, expectedVersion);
  }
}
