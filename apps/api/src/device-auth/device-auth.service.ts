import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes, createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';
import { DeviceCodeStatus } from '@prisma/client';
import type { Prisma } from '@prisma/client';

/**
 * Narrow a `client_info` JSON column back to the object shape the write path
 * put there, instead of asserting it (#186).
 *
 * The column is `Json?`, so its read type admits arrays, scalars and SQL
 * NULL — none of which this service ever writes (`generateDeviceCode` stores
 * `clientInfo || {}`). Checking rather than casting keeps that assumption
 * stated in code: anything that is not a JSON object reads back as absent,
 * which is exactly what the optional `clientInfo?` field on the response DTOs
 * already promises callers.
 */
function toClientInfo(
  value: Prisma.JsonValue | null,
): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value
    : undefined;
}

/**
 * Service for handling Device Authorization Flow (RFC 8628)
 */
@Injectable()
export class DeviceAuthService {
  private readonly logger = new Logger(DeviceAuthService.name);

  // Characters for user code generation (unambiguous)
  private readonly USER_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  // Tracking last poll times for rate limiting
  private readonly pollTimestamps = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Generate a new device code pair
   */
  /**
   * `Prisma.InputJsonObject` rather than `Record<string, unknown>`: this value
   * goes straight into the `client_info` JSON column, and `unknown` is not
   * something Prisma will accept there. Stating the column's contract on the
   * parameter is what lets the write below need no cast (#186).
   */
  async generateDeviceCode(clientInfo?: Prisma.InputJsonObject) {
    const expiryMinutes = this.configService.get<number>(
      'deviceAuth.expiryMinutes',
      15,
    );
    const pollInterval = this.configService.get<number>(
      'deviceAuth.pollInterval',
      5,
    );
    const appUrl = this.configService.get<string>('appUrl');

    // Generate device code (secure random string)
    const deviceCode = randomBytes(32).toString('hex');
    const deviceCodeHash = this.hashToken(deviceCode);

    // Generate user code (human-readable)
    const userCode = this.generateUserCode();

    // Calculate expiration
    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + expiryMinutes);

    // Store in database
    await this.prisma.deviceCode.create({
      data: {
        deviceCode: deviceCodeHash,
        userCode,
        status: DeviceCodeStatus.pending,
        clientInfo: clientInfo || {},
        scopes: [], // Future extension for scoped permissions
        expiresAt,
      },
    });

    this.logger.log(`Generated device code with user code: ${userCode}`);

    // Build response
    const verificationUri = `${appUrl}/activate`;
    const verificationUriComplete = `${verificationUri}?code=${userCode}`;

    return {
      deviceCode,
      userCode,
      verificationUri,
      verificationUriComplete,
      expiresIn: expiryMinutes * 60, // Convert to seconds
      interval: pollInterval,
    };
  }

  /**
   * Poll for device authorization status
   */
  async pollForToken(deviceCode: string) {
    const deviceCodeHash = this.hashToken(deviceCode);
    const pollInterval = this.configService.get<number>(
      'deviceAuth.pollInterval',
      5,
    );

    // Check rate limiting
    const lastPoll = this.pollTimestamps.get(deviceCodeHash);
    const now = Date.now();

    if (lastPoll && now - lastPoll < pollInterval * 1000) {
      throw new BadRequestException({
        error: 'slow_down',
        error_description: 'Polling too frequently. Please slow down.',
      });
    }

    // Update last poll timestamp
    this.pollTimestamps.set(deviceCodeHash, now);

    // Find device code
    const record = await this.prisma.deviceCode.findUnique({
      where: { deviceCode: deviceCodeHash },
      include: {
        user: {
          include: {
            userRoles: {
              include: {
                role: true,
              },
            },
          },
        },
      },
    });

    if (!record) {
      throw new UnauthorizedException({
        error: 'invalid_grant',
        error_description: 'Invalid device code',
      });
    }

    // Check if expired
    if (record.expiresAt < new Date()) {
      await this.prisma.deviceCode.update({
        where: { id: record.id },
        data: { status: DeviceCodeStatus.expired },
      });

      throw new BadRequestException({
        error: 'expired_token',
        error_description: 'The device code has expired',
      });
    }

    // Check status
    switch (record.status) {
      case DeviceCodeStatus.pending:
        throw new BadRequestException({
          error: 'authorization_pending',
          error_description: 'User has not yet authorized this device',
        });

      case DeviceCodeStatus.denied:
        throw new BadRequestException({
          error: 'access_denied',
          error_description: 'User denied the authorization request',
        });

      case DeviceCodeStatus.expired:
        throw new BadRequestException({
          error: 'expired_token',
          error_description: 'The device code has expired',
        });

      case DeviceCodeStatus.approved: {
        if (!record.user) {
          throw new UnauthorizedException({
            error: 'invalid_grant',
            error_description: 'User information not found',
          });
        }

        // Generate tokens with device-specific expiry
        const tokenExpiryDays = this.configService.get<number>(
          'deviceAuth.tokenExpiryDays',
          7,
        );
        const tokens = await this.authService.generateFullTokens(record.user, {
          accessTtlMinutes: tokenExpiryDays * 24 * 60,
          refreshTtlDays: tokenExpiryDays,
        });

        // Mark as used (update status to expired to prevent reuse)
        await this.prisma.deviceCode.update({
          where: { id: record.id },
          data: { status: DeviceCodeStatus.expired },
        });

        // Clean up poll timestamp
        this.pollTimestamps.delete(deviceCodeHash);

        this.logger.log(
          `Device authorized successfully for user: ${record.user.email}`,
        );

        return {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken!,
          tokenType: 'Bearer',
          expiresIn: tokens.expiresIn,
        };
      }

      default:
        throw new BadRequestException({
          error: 'invalid_request',
          error_description: 'Unknown device code status',
        });
    }
  }

  /**
   * Get activation info for the frontend
   */
  async getActivationInfo(userCode?: string) {
    const appUrl = this.configService.get<string>('appUrl');
    const verificationUri = `${appUrl}/activate`;

    if (!userCode) {
      return { verificationUri };
    }

    // Normalize user code
    const normalizedCode = userCode.toUpperCase().replace(/\s/g, '');

    // Find device code by user code
    const record = await this.prisma.deviceCode.findUnique({
      where: { userCode: normalizedCode },
    });

    if (!record) {
      throw new NotFoundException('Invalid user code');
    }

    // Check if expired
    if (record.expiresAt < new Date()) {
      throw new BadRequestException('This code has expired');
    }

    // Check if already processed
    if (
      record.status === DeviceCodeStatus.approved ||
      record.status === DeviceCodeStatus.denied
    ) {
      throw new BadRequestException('This code has already been processed');
    }

    return {
      verificationUri,
      userCode: record.userCode,
      clientInfo: toClientInfo(record.clientInfo),
      expiresAt: record.expiresAt.toISOString(),
    };
  }

  /**
   * Authorize or deny a device
   */
  async authorizeDevice(userId: string, userCode: string, approve: boolean) {
    // Normalize user code
    const normalizedCode = userCode.toUpperCase().replace(/\s/g, '');

    // Find device code
    const record = await this.prisma.deviceCode.findUnique({
      where: { userCode: normalizedCode },
    });

    if (!record) {
      throw new NotFoundException('Invalid user code');
    }

    // Check if expired
    if (record.expiresAt < new Date()) {
      throw new BadRequestException('This code has expired');
    }

    // Check if already processed
    if (
      record.status === DeviceCodeStatus.approved ||
      record.status === DeviceCodeStatus.denied
    ) {
      throw new BadRequestException('This code has already been processed');
    }

    // Update status
    const newStatus = approve
      ? DeviceCodeStatus.approved
      : DeviceCodeStatus.denied;

    await this.prisma.deviceCode.update({
      where: { id: record.id },
      data: {
        status: newStatus,
        userId: approve ? userId : null,
      },
    });

    const action = approve ? 'approved' : 'denied';
    this.logger.log(
      `Device ${action} by user ${userId} with code: ${normalizedCode}`,
    );

    return {
      success: true,
      message: approve
        ? 'Device authorized successfully'
        : 'Device authorization denied',
    };
  }

  /**
   * Get user's approved device sessions
   */
  async getUserDeviceSessions(
    userId: string,
    page: number = 1,
    limit: number = 10,
  ) {
    const skip = (page - 1) * limit;

    const [sessions, total] = await Promise.all([
      this.prisma.deviceCode.findMany({
        where: {
          userId,
          status: DeviceCodeStatus.approved,
        },
        orderBy: {
          createdAt: 'desc',
        },
        skip,
        take: limit,
      }),
      this.prisma.deviceCode.count({
        where: {
          userId,
          status: DeviceCodeStatus.approved,
        },
      }),
    ]);

    return {
      sessions: sessions.map((session) => ({
        id: session.id,
        userCode: session.userCode,
        status: session.status,
        clientInfo: toClientInfo(session.clientInfo),
        createdAt: session.createdAt.toISOString(),
        expiresAt: session.expiresAt.toISOString(),
      })),
      total,
      page,
      limit,
    };
  }

  /**
   * Revoke a device session
   */
  async revokeDeviceSession(userId: string, sessionId: string) {
    const session = await this.prisma.deviceCode.findUnique({
      where: { id: sessionId },
    });

    if (!session) {
      throw new NotFoundException('Session not found');
    }

    // Verify ownership
    if (session.userId !== userId) {
      throw new NotFoundException('Session not found');
    }

    // Update status to denied
    await this.prisma.deviceCode.update({
      where: { id: sessionId },
      data: { status: DeviceCodeStatus.denied },
    });

    this.logger.log(`Device session revoked: ${sessionId} by user: ${userId}`);

    return {
      success: true,
      message: 'Device session revoked successfully',
    };
  }

  /**
   * Clean up expired device codes (scheduled task)
   */
  async cleanupExpiredCodes(): Promise<number> {
    const result = await this.prisma.deviceCode.deleteMany({
      where: {
        OR: [
          { expiresAt: { lt: new Date() } },
          {
            status: DeviceCodeStatus.expired,
            updatedAt: {
              lt: new Date(Date.now() - 24 * 60 * 60 * 1000), // 1 day old
            },
          },
        ],
      },
    });

    this.logger.log(`Cleaned up ${result.count} expired device codes`);
    return result.count;
  }

  /**
   * Generate a human-readable user code
   */
  private generateUserCode(): string {
    const chars = this.USER_CODE_CHARS;
    let code = '';

    // Generate 8 random characters
    for (let i = 0; i < 8; i++) {
      const randomIndex = randomBytes(1)[0] % chars.length;
      code += chars[randomIndex];
    }

    // Format as XXXX-XXXX
    return `${code.substring(0, 4)}-${code.substring(4, 8)}`;
  }

  /**
   * Hash token for storage
   */
  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
