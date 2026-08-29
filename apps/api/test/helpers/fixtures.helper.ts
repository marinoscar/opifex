import type { Prisma } from '@prisma/client';

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
          // Asserted, not converted, and the same assertion
          // `allowlist.service.ts` makes for the same reason (#186):
          // `Record<string, unknown>` cannot be PROVEN assignable to Prisma's
          // `InputJsonObject`, because `unknown` is not `InputJsonValue`. The
          // assertion still constrains the target to a JSON object rather
          // than widening to `any`.
          //
          // This never compiled. It went unnoticed because `tsconfig.json`
          // excluded `test/` from the typecheck program, and ts-jest only
          // reports a file it actually loads — nothing imports this helper
          // today (#372).
          value: settings as Prisma.InputJsonObject,
        },
      },
    },
  });

  return user.id;
}
