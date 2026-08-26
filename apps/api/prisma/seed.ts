import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

// Prisma 7 requires a driver adapter — PrismaClient can no longer be
// instantiated with no options. The seed script is invoked as a standalone
// ts-node process (see prisma.config.ts: migrations.seed), not through
// Nest's DI container, so it can't reuse PrismaService's buildConnectionString()
// without also pulling in @nestjs/common. Every Prisma CLI invocation in this
// project (npm run prisma:*, or `npx prisma db seed` per the README) already
// guarantees DATABASE_URL is set before the CLI — and therefore this seed
// script — runs, either via scripts/prisma-env.js or an explicit export, so
// reading it directly here is sufficient and keeps the script framework-free.
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    'DATABASE_URL is not set. Run this script via `npm run prisma:seed` ' +
      '(or export DATABASE_URL) so Prisma can connect to the database.',
  );
}

const adapter = new PrismaPg(databaseUrl);
const prisma = new PrismaClient({ adapter });

// =============================================================================
// Seed Data Definitions
// =============================================================================

const ROLES = [
  {
    name: 'admin',
    description: 'Full system access - manage users, roles, and all settings',
  },
  {
    name: 'contributor',
    description: 'Standard user - can manage own settings and future features',
  },
  {
    name: 'viewer',
    description: 'Read-only access - can view content and manage own settings',
  },
] as const;

const PERMISSIONS = [
  // System settings
  { name: 'system_settings:read', description: 'Read system settings' },
  { name: 'system_settings:write', description: 'Modify system settings' },

  // User settings
  { name: 'user_settings:read', description: 'Read own user settings' },
  { name: 'user_settings:write', description: 'Modify own user settings' },

  // Users management
  { name: 'users:read', description: 'View user list and details' },
  { name: 'users:write', description: 'Modify user accounts' },

  // RBAC management
  { name: 'rbac:manage', description: 'Manage roles and permissions' },

  // Allowlist management
  { name: 'allowlist:read', description: 'View allowlisted emails' },
  { name: 'allowlist:write', description: 'Manage allowlisted emails' },

  // Storage management
  {
    name: 'storage:read',
    description: 'Read object metadata, get download URLs',
  },
  { name: 'storage:write', description: 'Upload, update metadata' },
  { name: 'storage:delete_any', description: 'Admin: delete any object' },

  // ---------------------------------------------------------------------
  // Opifex domain (epic #15)
  // ---------------------------------------------------------------------
  // Kept in step with PERMISSIONS in
  // src/common/constants/roles.constants.ts, where the reasoning for this
  // set lives. Seeding is idempotent (upsert by name), so an existing
  // database picks these up on the next `npm run prisma:seed` without
  // disturbing what is already there.
  {
    name: 'projects:read',
    description: 'View projects and watched repositories',
  },
  {
    name: 'projects:write',
    description: 'Register and configure repositories',
  },
  { name: 'runs:read', description: 'View runs and their event timelines' },
  { name: 'runs:cancel', description: 'Cancel a live run' },
  {
    name: 'runs:write',
    description: 'Report run events (held by runners, not people)',
  },
  { name: 'workorders:read', description: 'View work orders and the queue' },
  {
    name: 'workorders:write',
    description: 'Hold, release, and clear quarantine',
  },
  {
    name: 'runners:manage',
    description: 'Register runners and capability manifests',
  },
  { name: 'escalations:read', description: 'View escalations' },
  { name: 'escalations:acknowledge', description: 'Acknowledge an escalation' },
  {
    name: 'supervisor:read',
    description: 'View the supervisor decision log and its proposals',
  },
  {
    name: 'supervisor:review',
    description:
      'Record whether a supervisor proposal would have been approved',
  },
  { name: 'trust:read', description: 'View trust grants and their history' },
  {
    name: 'trust:grant',
    description: 'Issue a trust grant authorizing unattended execution',
  },
  {
    name: 'trust:revoke',
    description: 'Revoke or suspend a trust grant',
  },
  {
    name: 'approvals:read',
    description: 'View approval requests and what happens if they are ignored',
  },
  {
    name: 'approvals:decide',
    description: 'Approve or deny a single pending action',
  },
] as const;

// Role to permissions mapping
const ROLE_PERMISSIONS: Record<string, string[]> = {
  admin: [
    'system_settings:read',
    'system_settings:write',
    'user_settings:read',
    'user_settings:write',
    'users:read',
    'users:write',
    'rbac:manage',
    'allowlist:read',
    'allowlist:write',
    'storage:read',
    'storage:write',
    'storage:delete_any',
    // Opifex domain - the operator role, in practice the only one that runs
    // the factory (VISION §11).
    'projects:read',
    'projects:write',
    'runs:read',
    'runs:cancel',
    'runs:write',
    'workorders:read',
    'workorders:write',
    'runners:manage',
    'escalations:read',
    'escalations:acknowledge',
    'supervisor:read',
    'supervisor:review',
    // All three. 'trust:grant' is admin-only: granting autonomy reconfigures
    // what the factory may do unattended, which is the same class of decision
    // as 'runners:manage' and 'projects:write' — it decides what the control
    // plane is allowed to do without asking, not merely what it does today.
    'trust:read',
    'trust:grant',
    'trust:revoke',
    // Both. An admin holding 'trust:grant' as well is what makes VISION §8's
    // third option — "Always approve this class" — available to them, and to
    // nobody else.
    'approvals:read',
    'approvals:decide',
  ],
  contributor: [
    'user_settings:read',
    'user_settings:write',
    'storage:read',
    'storage:write',
    // Opifex domain - may act on the factory but not reconfigure it.
    // No 'projects:write' (registering a repository decides what Opifex may
    // touch) and no 'runners:manage' (a runner registration decides what the
    // control plane hands real repositories to). Both are admin decisions.
    'projects:read',
    'runs:read',
    'runs:cancel',
    'runs:write',
    'workorders:read',
    'workorders:write',
    'escalations:read',
    'escalations:acknowledge',
    // The review verdict is the Phase 6 measurement and decides which action
    // classes become eligible for promotion. A contributor runs the factory,
    // so judging what the supervisor would have been allowed to do is within
    // that role.
    'supervisor:read',
    'supervisor:review',
    // Read and revoke, never grant. Narrowing trust is always safe, and an
    // operator who suspects a grant is misbehaving should not need to find an
    // admin before stopping it — the same reasoning as
    // 'escalations:acknowledge' above. Granting is the opposite act: it widens
    // what runs unattended, so it stays with 'projects:write' and
    // 'runners:manage' as an admin decision.
    'trust:read',
    'trust:revoke',
    // Deciding an approval is acting on the factory, not reconfiguring it —
    // the same line 'escalations:acknowledge' is on, and drawn for the same
    // reason: an operator who is watching a run should not have to find an
    // admin before answering the question the run is blocked on. VISION §8's
    // entire premise is that approvals must be cheap, and an approval that
    // requires escalating to a different human is the friction that produces
    // blanket trust.
    //
    // Note what this does NOT include: 'trust:grant'. A contributor may
    // approve a single action and may NOT mint a grant from it, so VISION §8's
    // third option ("Always approve this class") is unavailable to them. That
    // composition is deliberate — the safe act is cheap and the widening act
    // stays with the admin decisions, alongside 'projects:write' and
    // 'runners:manage'. #98's controller must check both permissions, because
    // 'approvals:decide' alone is not authority to create standing autonomy.
    'approvals:read',
    'approvals:decide',
  ],
  viewer: [
    'user_settings:read',
    'user_settings:write',
    'storage:read',
    // Opifex domain - read-only throughout. A viewer can watch the factory
    // and cannot change what it does, including acknowledging an escalation:
    // an acknowledgement is a claim that someone will act on it.
    'projects:read',
    'runs:read',
    'workorders:read',
    'escalations:read',
    // Read the log, never judge it: a would-have-approved verdict is evidence
    // that grants autonomy later, which is not a read.
    'supervisor:read',
    // See what runs unattended and why it stopped. Revoking is withheld
    // because it is an act on the factory, and a viewer acts on nothing -
    // even when the act would narrow rather than widen.
    'trust:read',
    // See what is waiting and what happens if it is ignored; answer nothing.
    // An approval IS an act on the factory — it is the moment an action takes
    // effect — so 'approvals:decide' is withheld for the same reason
    // 'escalations:acknowledge' is.
    'approvals:read',
  ],
};

// Default system settings
const DEFAULT_SYSTEM_SETTINGS = {
  ui: {
    allowUserThemeOverride: true,
  },
  features: {},
};

// =============================================================================
// Seed Functions
// =============================================================================

async function seedRoles() {
  console.log('Seeding roles...');

  for (const role of ROLES) {
    await prisma.role.upsert({
      where: { name: role.name },
      update: { description: role.description },
      create: role,
    });
  }

  console.log(`✓ Seeded ${ROLES.length} roles`);
}

async function seedPermissions() {
  console.log('Seeding permissions...');

  for (const permission of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { name: permission.name },
      update: { description: permission.description },
      create: permission,
    });
  }

  console.log(`✓ Seeded ${PERMISSIONS.length} permissions`);
}

async function seedRolePermissions() {
  console.log('Seeding role-permission mappings...');

  let count = 0;

  for (const [roleName, permissionNames] of Object.entries(ROLE_PERMISSIONS)) {
    const role = await prisma.role.findUnique({ where: { name: roleName } });
    if (!role) continue;

    for (const permissionName of permissionNames) {
      const permission = await prisma.permission.findUnique({
        where: { name: permissionName },
      });
      if (!permission) continue;

      await prisma.rolePermission.upsert({
        where: {
          roleId_permissionId: {
            roleId: role.id,
            permissionId: permission.id,
          },
        },
        update: {},
        create: {
          roleId: role.id,
          permissionId: permission.id,
        },
      });
      count++;
    }
  }

  console.log(`✓ Seeded ${count} role-permission mappings`);
}

async function seedSystemSettings() {
  console.log('Seeding system settings...');

  await prisma.systemSettings.upsert({
    where: { key: 'global' },
    update: {}, // Don't overwrite existing settings
    create: {
      key: 'global',
      value: DEFAULT_SYSTEM_SETTINGS,
      version: 1,
    },
  });

  console.log('✓ Seeded default system settings');
}

async function seedInitialAdminAllowlist() {
  console.log('Seeding initial admin allowlist...');

  const initialAdminEmail = process.env.INITIAL_ADMIN_EMAIL;
  if (initialAdminEmail) {
    await prisma.allowedEmail.upsert({
      where: { email: initialAdminEmail.toLowerCase() },
      update: {},
      create: {
        email: initialAdminEmail.toLowerCase(),
        notes: 'Initial admin (auto-seeded)',
      },
    });
    console.log(`✓ Added ${initialAdminEmail} to allowlist`);
  } else {
    console.log('⊘ INITIAL_ADMIN_EMAIL not set, skipping allowlist seed');
  }
}

// operator_settings (#332, #336) is deliberately NOT seeded here, and never
// should be. An ABSENT row is how OperatorSettingsResolver knows to fall
// through to `.env` for that key; seeding today's environment values into
// the table would freeze them in the database and make every future `.env`
// edit inert, silently, since the resolver would keep reading the stale
// database row instead. There is also no reference data to seed: unlike
// roles/permissions, the set of valid keys lives in the registry
// (`apps/api/src/operator-settings/*`, #335), not in this table.

// =============================================================================
// Main Seed Function
// =============================================================================

async function main() {
  console.log('Starting database seed...\n');

  await seedRoles();
  await seedPermissions();
  await seedRolePermissions();
  await seedSystemSettings();
  await seedInitialAdminAllowlist();

  console.log('\n✓ Database seeding completed successfully');
}

main()
  .catch((e) => {
    console.error('Seed error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
