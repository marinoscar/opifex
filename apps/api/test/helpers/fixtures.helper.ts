import { PrismaService } from '../../src/prisma/prisma.service';

/**
 * Creates multiple test users for batch testing
 */
export async function createBulkUsers(
  prisma: PrismaService,
  count: number,
  roleId: string,
): Promise<string[]> {
  const userIds: string[] = [];

  for (let i = 0; i < count; i++) {
    const user = await prisma.user.create({
      data: {
        email: `bulk-user-${i}-${Date.now()}@example.com`,
        providerDisplayName: `Bulk User ${i}`,
        identities: {
          create: {
            provider: 'google',
            providerSubject: `bulk-google-${i}-${Date.now()}`,
            providerEmail: `bulk-user-${i}-${Date.now()}@example.com`,
          },
        },
        userRoles: {
          create: { roleId },
        },
      },
    });
    userIds.push(user.id);
  }

  return userIds;
}

/**
 * Creates a user with custom settings
 */
export async function createUserWithSettings(
  prisma: PrismaService,
  roleId: string,
  settings: Record<string, unknown>,
): Promise<string> {
  const user = await prisma.user.create({
    data: {
      email: `settings-user-${Date.now()}@example.com`,
      providerDisplayName: 'Settings Test User',
      identities: {
        create: {
          provider: 'google',
          providerSubject: `settings-google-${Date.now()}`,
          providerEmail: `settings-user-${Date.now()}@example.com`,
        },
      },
      userRoles: {
        create: { roleId },
      },
      userSettings: {
        create: {
          value: settings,
        },
      },
    },
  });

  return user.id;
}
