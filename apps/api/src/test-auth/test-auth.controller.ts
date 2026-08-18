import {
  Controller,
  Post,
  Body,
  UseGuards,
  Res,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { FastifyReply } from 'fastify';
import { Public } from '../auth/decorators/public.decorator';
import { TestEnvironmentGuard } from './guards/test-environment.guard';
import { TestAuthService } from './test-auth.service';
import { TestLoginDto } from './dto/test-login.dto';

const REFRESH_TOKEN_COOKIE = 'refresh_token';
const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/api/auth',
  maxAge: 14 * 24 * 60 * 60, // 14 days in seconds
};

@ApiTags('Test Authentication')
@Controller('auth/test')
export class TestAuthController {
  private readonly logger = new Logger(TestAuthController.name);

  constructor(
    private readonly testAuthService: TestAuthService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * POST /auth/test/login
   * Test authentication endpoint - bypasses OAuth for E2E testing
   */
  @Public()
  @Post('login')
  @UseGuards(TestEnvironmentGuard)
  @ApiOperation({
    summary: 'Test login (non-production only)',
    description:
      'Authenticate as any user for testing purposes. Only available in non-production environments.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirects to /auth/callback with access token',
  })
  @ApiResponse({
    status: 403,
    description: 'Forbidden - only available in non-production environments',
  })
  async testLogin(
    @Body() dto: TestLoginDto,
    @Res() res: FastifyReply,
  ): Promise<void> {
    this.logger.log(`Test login request for: ${dto.email}`);

    const result = await this.testAuthService.loginAsTestUser(dto);

    // Set refresh token in HttpOnly cookie
    res.setCookie(REFRESH_TOKEN_COOKIE, result.refreshToken, COOKIE_OPTIONS);

    // Redirect to frontend with access token
    const appUrl = this.configService.get<string>('appUrl');
    const redirectUrl = new URL('/auth/callback', appUrl);
    redirectUrl.searchParams.set('token', result.accessToken);
    redirectUrl.searchParams.set('expiresIn', result.expiresIn.toString());

    this.logger.log(`Test login successful, redirecting to: ${redirectUrl.toString()}`);
    return res.status(302).redirect(redirectUrl.toString());
  }
}
