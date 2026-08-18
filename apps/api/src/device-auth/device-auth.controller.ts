import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { DeviceAuthService } from './device-auth.service';
import { Public } from '../auth/decorators/public.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequestUser } from '../auth/interfaces/authenticated-user.interface';

// Request DTOs
import { DeviceCodeRequestDto } from './dto/device-code-request.dto';
import { DeviceTokenRequestDto } from './dto/device-token-request.dto';
import { DeviceAuthorizeRequestDto } from './dto/device-authorize-request.dto';

// Response DTOs
import { DeviceCodeResponseDto } from './dto/device-code-response.dto';
import { DeviceTokenResponseDto } from './dto/device-token-response.dto';
import { DeviceTokenErrorDto } from './dto/device-token-error.dto';
import { DeviceActivateResponseDto } from './dto/device-activate-response.dto';
import { DeviceAuthorizeResponseDto } from './dto/device-authorize-response.dto';
import { DeviceSessionsResponseDto } from './dto/device-session.dto';

@ApiTags('Device Authorization')
@Controller('auth/device')
export class DeviceAuthController {
  constructor(private readonly deviceAuthService: DeviceAuthService) {}

  /**
   * POST /auth/device/code
   * Generate a new device code pair for device authorization flow
   */
  @Public()
  @Post('code')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Generate device code',
    description:
      'Initiates the device authorization flow by generating a device code and user code pair. ' +
      'The device should poll /auth/device/token while the user authorizes via /device page.',
  })
  @ApiResponse({
    status: 200,
    description: 'Device code generated successfully',
    type: DeviceCodeResponseDto,
  })
  async generateCode(
    @Body() body: DeviceCodeRequestDto,
  ): Promise<{ data: DeviceCodeResponseDto }> {
    const result = await this.deviceAuthService.generateDeviceCode(
      body.clientInfo,
    );

    return { data: result };
  }

  /**
   * POST /auth/device/token
   * Poll for device authorization status
   */
  @Public()
  @Post('token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Poll for device authorization',
    description:
      'Device polls this endpoint to check if the user has authorized the device. ' +
      'Returns tokens when approved, or appropriate error codes while pending/denied/expired.',
  })
  @ApiResponse({
    status: 200,
    description: 'Device authorized - returns access and refresh tokens',
    type: DeviceTokenResponseDto,
  })
  @ApiResponse({
    status: 400,
    description:
      'Authorization pending, slow down, expired, or denied (see error field)',
    type: DeviceTokenErrorDto,
  })
  async pollToken(
    @Body() body: DeviceTokenRequestDto,
  ): Promise<{ data: DeviceTokenResponseDto }> {
    const result = await this.deviceAuthService.pollForToken(body.deviceCode);

    return { data: result };
  }

  /**
   * GET /auth/device/activate
   * Get activation page information
   */
  @Get('activate')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Get device activation info',
    description:
      'Returns information for the device activation page. ' +
      'If a code is provided, validates it and returns details.',
  })
  @ApiQuery({
    name: 'code',
    required: false,
    description: 'User verification code (optional)',
    example: 'ABCD-1234',
  })
  @ApiResponse({
    status: 200,
    description: 'Activation information',
    type: DeviceActivateResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid or expired code',
  })
  @ApiResponse({
    status: 404,
    description: 'Code not found',
  })
  async getActivationInfo(
    @Query('code') code?: string,
  ): Promise<{ data: DeviceActivateResponseDto }> {
    const result = await this.deviceAuthService.getActivationInfo(code);

    return { data: result };
  }

  /**
   * POST /auth/device/authorize
   * Authorize or deny a device
   */
  @Post('authorize')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Authorize or deny device',
    description:
      'User authorizes or denies a device using the user code from the activation page.',
  })
  @ApiResponse({
    status: 200,
    description: 'Device authorization processed',
    type: DeviceAuthorizeResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid or expired code',
  })
  @ApiResponse({
    status: 404,
    description: 'Code not found',
  })
  async authorizeDevice(
    @CurrentUser() user: RequestUser,
    @Body() body: DeviceAuthorizeRequestDto,
  ): Promise<{ data: DeviceAuthorizeResponseDto }> {
    const result = await this.deviceAuthService.authorizeDevice(
      user.id,
      body.userCode,
      body.approve,
    );

    return { data: result };
  }

  /**
   * GET /auth/device/sessions
   * List user's approved device sessions
   */
  @Get('sessions')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'List device sessions',
    description: "Returns a paginated list of the current user's approved device sessions.",
  })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    description: 'Page number',
    example: 1,
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Page size',
    example: 10,
  })
  @ApiResponse({
    status: 200,
    description: 'List of device sessions',
    type: DeviceSessionsResponseDto,
  })
  async getSessions(
    @CurrentUser() user: RequestUser,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ): Promise<{ data: DeviceSessionsResponseDto }> {
    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = limit ? parseInt(limit, 10) : 10;

    const result = await this.deviceAuthService.getUserDeviceSessions(
      user.id,
      pageNum,
      limitNum,
    );

    return { data: result };
  }

  /**
   * DELETE /auth/device/sessions/:id
   * Revoke a device session
   */
  @Delete('sessions/:id')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Revoke device session',
    description: 'Revokes a specific device session for the current user.',
  })
  @ApiResponse({
    status: 200,
    description: 'Session revoked successfully',
    type: DeviceAuthorizeResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'Session not found',
  })
  async revokeSession(
    @CurrentUser() user: RequestUser,
    @Param('id') sessionId: string,
  ): Promise<{ data: DeviceAuthorizeResponseDto }> {
    const result = await this.deviceAuthService.revokeDeviceSession(
      user.id,
      sessionId,
    );

    return { data: result };
  }
}
