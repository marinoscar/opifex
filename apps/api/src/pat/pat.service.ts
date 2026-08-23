import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { createHash, randomBytes } from 'node:crypto';
import { CreatePatDto } from './dto/create-pat.dto';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';

@Injectable()
export class PatService {
  private readonly logger = new Logger(PatService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Create a new Personal Access Token for a user
   */
  async createToken(userId: string, dto: CreatePatDto) {
    // Generate raw token: pat_ + 32 random bytes as hex (64 hex chars)
    const hexPart = randomBytes(32).toString('hex');
    const rawToken = `pat_${hexPart}`;

    // Hash the token for storage
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');

    // tokenPrefix: "pat_" + first 4 hex chars of hexPart = 8 chars total display prefix
    const tokenPrefix = `pat_${hexPart.slice(0, 4)}`;

    // Compute expiresAt based on durationUnit
    const expiresAt = new Date();
    if (dto.durationUnit === 'minutes') {
      expiresAt.setMinutes(expiresAt.getMinutes() + dto.durationValue);
    } else if (dto.durationUnit === 'days') {
      expiresAt.setDate(expiresAt.getDate() + dto.durationValue);
    } else if (dto.durationUnit === 'months') {
      expiresAt.setMonth(expiresAt.getMonth() + dto.durationValue);
    }

    const pat = await this.prisma.personalAccessToken.create({
      data: {
        userId,
        name: dto.name,
        tokenHash,
        tokenPrefix,
        durationValue: dto.durationValue,
        durationUnit: dto.durationUnit,
        expiresAt,
      },
    });

    this.logger.log(`Created PAT "${dto.name}" for user: ${userId}`);

    return {
      token: rawToken,
      id: pat.id,
      name: pat.name,
      tokenPrefix: pat.tokenPrefix,
      expiresAt: pat.expiresAt.toISOString(),
      createdAt: pat.createdAt.toISOString(),
    };
  }

  /**
   * List all PATs for a user (without token hashes)
   */
  async listTokens(userId: string) {
    const tokens = await this.prisma.personalAccessToken.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        tokenPrefix: true,
        durationValue: true,
        durationUnit: true,
        expiresAt: true,
        lastUsedAt: true,
        createdAt: true,
        revokedAt: true,
      },
    });

    return tokens;
  }

  /**
   * Revoke a PAT by ID (ownership-checked)
   */
  async revokeToken(userId: string, tokenId: string): Promise<void> {
    const pat = await this.prisma.personalAccessToken.findFirst({
      where: { id: tokenId, userId },
    });

    if (!pat) {
      throw new NotFoundException('Token not found');
    }

    if (pat.revokedAt !== null) {
      throw new NotFoundException('Token already revoked');
    }

    await this.prisma.personalAccessToken.update({
      where: { id: pat.id },
      data: { revokedAt: new Date() },
    });

    this.logger.log(
      `Revoked PAT "${pat.name}" (${pat.id}) for user: ${userId}`,
    );
  }

  /**
   * Validate a raw PAT and return the associated user if valid
   */
  async validateToken(rawToken: string): Promise<AuthenticatedUser | null> {
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');

    const pat = await this.prisma.personalAccessToken.findUnique({
      where: { tokenHash },
      include: {
        user: {
          include: {
            userRoles: {
              include: {
                role: {
                  include: {
                    rolePermissions: {
                      include: { permission: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!pat) {
      return null;
    }

    // Check revoked
    if (pat.revokedAt !== null) {
      return null;
    }

    // Check expired
    if (pat.expiresAt <= new Date()) {
      return null;
    }

    // Check user active
    if (!pat.user.isActive) {
      return null;
    }

    // Fire-and-forget update of lastUsedAt
    this.prisma.personalAccessToken
      .update({ where: { id: pat.id }, data: { lastUsedAt: new Date() } })
      .catch(() => {});

    return pat.user as AuthenticatedUser;
  }

  /**
   * Clean up expired and old revoked PATs
   * Returns the count of deleted records
   */
  async cleanupExpiredTokens(): Promise<number> {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const result = await this.prisma.personalAccessToken.deleteMany({
      where: {
        OR: [
          { expiresAt: { lt: new Date() } },
          {
            revokedAt: { not: null, lt: thirtyDaysAgo },
          },
        ],
      },
    });

    this.logger.log(`Cleaned up ${result.count} expired/revoked PATs`);
    return result.count;
  }
}
