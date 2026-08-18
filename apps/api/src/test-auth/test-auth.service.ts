import { Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { TestLoginDto } from './dto/test-login.dto';
import { JwtPayload } from '../auth/strategies/jwt.strategy';
import { DEFAULT_USER_SETTINGS } from '../common/types/settings.types';

export interface TestAuthTokenResponse {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  user: {
    id: string;
    email: string;
    displayName: string | null;
    roles: string[];
  };
}

@Injectable()
export class TestAuthService {
  private readonly logger = new Logger(TestAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Login as test user - bypass OAuth and allowlist for testing
   */
  async loginAsTestUser(dto: TestLoginDto): Promise<TestAuthTokenResponse> {
    this.logger.log(`Test login for email: ${dto.email} with role: ${dto.role}`);

    const email = dto.email.toLowerCase();

    // Find or create user
    let user = await this.prisma.user.findUnique({
      where: { email },
      include: {
        userRoles: {
          include: {
            role: true,
          },
        },
      },
    });

    if (!user) {
      // Create new user
      const displayName = dto.displayName || email.split('@')[0];

      user = await this.prisma.user.create({
        data: {
          email,
          displayName,
          isActive: true,
          // Create default user settings
          userSettings: {
            create: {
              value: DEFAULT_USER_SETTINGS as any,
            },
          },
        },
        include: {
          userRoles: {
            include: {
              role: true,
            },
          },
        },
      });

      this.logger.log(`Created test user: ${email}`);
    }

    // Assign specified role (replace existing roles)
    const targetRole = await this.prisma.role.findUnique({
      where: { name: dto.role || 'viewer' },
    });

    if (!targetRole) {
      throw new Error(`Role ${dto.role} not found`);
    }

    // Remove all existing roles and assign the specified role
    await this.prisma.$transaction([
      this.prisma.userRole.deleteMany({
        where: { userId: user.id },
      }),
      this.prisma.userRole.create({
        data: {
          userId: user.id,
          roleId: targetRole.id,
        },
      }),
    ]);

    // Reload user with updated roles
    user = await this.prisma.user.findUnique({
      where: { id: user.id },
      include: {
        userRoles: {
          include: {
            role: true,
          },
        },
      },
    });

    if (!user) {
      throw new Error('Failed to reload user after role assignment');
    }

    // Generate JWT tokens
    const roles = user.userRoles.map((ur) => ur.role.name);

    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      roles,
    };

    const accessTtlMinutes = this.configService.get<number>(
      'jwt.accessTtlMinutes',
      15,
    );

    const accessToken = this.jwtService.sign(payload);

    // Create refresh token
    const refreshToken = await this.createRefreshToken(user.id);

    this.logger.log(`Test login successful for user: ${user.email} with roles: ${roles.join(', ')}`);

    return {
      accessToken,
      expiresIn: accessTtlMinutes * 60, // Convert to seconds
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        roles,
      },
    };
  }

  /**
   * Create a new refresh token (copied from AuthService)
   */
  private async createRefreshToken(userId: string): Promise<string> {
    const refreshTtlDays = this.configService.get<number>(
      'jwt.refreshTtlDays',
      14,
    );
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + refreshTtlDays);

    // Generate random token
    const token = randomBytes(32).toString('hex');
    const tokenHash = this.hashToken(token);

    // Store hashed token in database
    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash,
        expiresAt,
      },
    });

    this.logger.debug(`Created refresh token for user: ${userId}`);

    return token;
  }

  /**
   * Hash token for storage
   */
  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
