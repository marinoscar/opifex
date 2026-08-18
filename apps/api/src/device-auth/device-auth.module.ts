import { Module } from '@nestjs/common';
import { DeviceAuthController } from './device-auth.controller';
import { DeviceAuthService } from './device-auth.service';
import { DeviceCodeCleanupTask } from './tasks/device-code-cleanup.task';
import { AuthModule } from '../auth/auth.module';

/**
 * Module for Device Authorization Flow (RFC 8628)
 *
 * Provides endpoints for:
 * - Generating device codes
 * - Polling for authorization status
 * - User authorization of devices
 * - Managing device sessions
 */
@Module({
  imports: [AuthModule],
  controllers: [DeviceAuthController],
  providers: [DeviceAuthService, DeviceCodeCleanupTask],
  exports: [DeviceAuthService],
})
export class DeviceAuthModule {}
