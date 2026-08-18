import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AddEmailDto } from './dto/add-email.dto';
import { AllowlistQueryDto } from './dto/allowlist-query.dto';

@Injectable()
export class AllowlistService {
  private readonly logger = new Logger(AllowlistService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * List allowed emails with pagination and filtering
   */
  async listAllowedEmails(query: AllowlistQueryDto) {
    const { page, pageSize, search, status, sortBy, sortOrder } = query;
    const skip = (page - 1) * pageSize;

    // Build where clause
    const where: any = {};

    if (search) {
      where.email = { contains: search, mode: 'insensitive' };
    }

    if (status === 'pending') {
      where.claimedById = null;
    } else if (status === 'claimed') {
      where.claimedById = { not: null };
    }

    // Execute query
    const [items, total] = await Promise.all([
      this.prisma.allowedEmail.findMany({
        where,
        skip,
        take: pageSize,
        orderBy: { [sortBy]: sortOrder },
        include: {
          addedBy: {
            select: {
              id: true,
              email: true,
            },
          },
          claimedBy: {
            select: {
              id: true,
              email: true,
            },
          },
        },
      }),
      this.prisma.allowedEmail.count({ where }),
    ]);

    return {
      items,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  /**
   * Add email to allowlist
   */
  async addEmail(dto: AddEmailDto, adminUserId: string) {
    const email = dto.email.toLowerCase();

    // Check for duplicates
    const existing = await this.prisma.allowedEmail.findUnique({
      where: { email },
    });

    if (existing) {
      throw new ConflictException(
        `Email ${email} is already in the allowlist`,
      );
    }

    // Create entry
    const entry = await this.prisma.allowedEmail.create({
      data: {
        email,
        notes: dto.notes,
        addedById: adminUserId,
      },
      include: {
        addedBy: {
          select: {
            id: true,
            email: true,
          },
        },
      },
    });

    // Create audit event
    await this.createAuditEvent(
      adminUserId,
      'allowlist:add',
      'allowed_email',
      entry.id,
      { email },
    );

    this.logger.log(`Email ${email} added to allowlist by admin ${adminUserId}`);

    return entry;
  }

  /**
   * Remove email from allowlist
   */
  async removeEmail(id: string, adminUserId: string) {
    // Find entry
    const entry = await this.prisma.allowedEmail.findUnique({
      where: { id },
    });

    if (!entry) {
      throw new NotFoundException(`Allowlist entry with ID ${id} not found`);
    }

    // Check if claimed
    if (entry.claimedById) {
      throw new BadRequestException(
        'Cannot remove allowlist entry that has been claimed by a user',
      );
    }

    // Delete entry
    await this.prisma.allowedEmail.delete({
      where: { id },
    });

    // Create audit event
    await this.createAuditEvent(
      adminUserId,
      'allowlist:remove',
      'allowed_email',
      id,
      { email: entry.email },
    );

    this.logger.log(
      `Email ${entry.email} removed from allowlist by admin ${adminUserId}`,
    );
  }

  /**
   * Check if email is in allowlist
   */
  async isEmailAllowed(email: string): Promise<boolean> {
    const normalizedEmail = email.toLowerCase();
    const entry = await this.prisma.allowedEmail.findUnique({
      where: { email: normalizedEmail },
    });

    return entry !== null;
  }

  /**
   * Mark email as claimed by a user
   */
  async markEmailClaimed(email: string, userId: string): Promise<void> {
    const normalizedEmail = email.toLowerCase();

    // Find entry
    const entry = await this.prisma.allowedEmail.findUnique({
      where: { email: normalizedEmail },
    });

    // If entry doesn't exist or already claimed, do nothing (idempotent)
    if (!entry || entry.claimedById) {
      return;
    }

    // Update entry
    await this.prisma.allowedEmail.update({
      where: { id: entry.id },
      data: {
        claimedById: userId,
        claimedAt: new Date(),
      },
    });

    this.logger.log(`Email ${normalizedEmail} claimed by user ${userId}`);
  }

  /**
   * Create audit event
   */
  private async createAuditEvent(
    actorUserId: string,
    action: string,
    targetType: string,
    targetId: string,
    meta: Record<string, unknown>,
  ) {
    await this.prisma.auditEvent.create({
      data: {
        actorUserId,
        action,
        targetType,
        targetId,
        meta: meta as any,
      },
    });
  }
}
