import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class AdminBootstrapService implements OnModuleInit {
  private readonly logger = new Logger(AdminBootstrapService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit() {
    // Only run in development or when explicitly enabled
    if (this.config.get('NODE_ENV') === 'production') {
      this.logger.log('Admin bootstrap disabled in production');
      return;
    }

    await this.ensureInitialAdminRole();
  }

  /**
   * Ensures the initial admin email (from env) has admin role assigned
   * when they first log in. This is handled during OAuth callback.
   */
  private async ensureInitialAdminRole() {
    const initialAdminEmail = this.config.get<string>('INITIAL_ADMIN_EMAIL');

    if (!initialAdminEmail) {
      this.logger.warn(
        'INITIAL_ADMIN_EMAIL not set - no admin will be auto-assigned',
      );
      return;
    }

    this.logger.log(
      `Admin bootstrap configured for: ${initialAdminEmail}`,
    );
  }

  /**
   * Called during OAuth callback to check if user should be granted admin
   */
  async shouldGrantAdminRole(email: string): Promise<boolean> {
    const initialAdminEmail = this.config.get<string>('INITIAL_ADMIN_EMAIL');

    if (!initialAdminEmail) {
      return false;
    }

    // Check if any admin already exists
    const adminRole = await this.prisma.role.findUnique({
      where: { name: 'admin' },
      include: {
        userRoles: {
          include: { user: true },
        },
      },
    });

    if (!adminRole) {
      return false;
    }

    const existingAdmins = adminRole.userRoles.filter(
      (ur) => ur.user.isActive,
    );

    // Only grant admin if:
    // 1. Email matches INITIAL_ADMIN_EMAIL
    // 2. No other active admins exist
    if (existingAdmins.length === 0 && email === initialAdminEmail) {
      this.logger.log(`Granting admin role to initial admin: ${email}`);
      return true;
    }

    return false;
  }

  /**
   * Assigns admin role to a user
   */
  async assignAdminRole(userId: string): Promise<void> {
    const adminRole = await this.prisma.role.findUnique({
      where: { name: 'admin' },
    });

    if (!adminRole) {
      throw new Error('Admin role not found - run seeds first');
    }

    await this.prisma.userRole.upsert({
      where: {
        userId_roleId: {
          userId,
          roleId: adminRole.id,
        },
      },
      update: {},
      create: {
        userId,
        roleId: adminRole.id,
      },
    });

    this.logger.log(`Admin role assigned to user: ${userId}`);
  }
}
