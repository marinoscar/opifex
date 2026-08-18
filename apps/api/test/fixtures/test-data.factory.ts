import { randomUUID } from 'crypto';

/**
 * Test data factories for creating mock entities
 * These create in-memory objects without database calls
 *
 * NOTE: These factories return plain objects that match Prisma types.
 * They intentionally don't import Prisma types directly to avoid
 * strict type checking issues in tests.
 */

// ============================================================================
// Roles and Permissions
// ============================================================================

export const mockPermissions = {
  systemSettingsRead: {
    id: randomUUID(),
    name: 'system_settings:read',
    description: 'Read system settings',
  },
  systemSettingsWrite: {
    id: randomUUID(),
    name: 'system_settings:write',
    description: 'Modify system settings',
  },
  userSettingsRead: {
    id: randomUUID(),
    name: 'user_settings:read',
    description: 'Read user settings',
  },
  userSettingsWrite: {
    id: randomUUID(),
    name: 'user_settings:write',
    description: 'Modify user settings',
  },
  usersRead: {
    id: randomUUID(),
    name: 'users:read',
    description: 'Read user data',
  },
  usersWrite: {
    id: randomUUID(),
    name: 'users:write',
    description: 'Modify user data',
  },
  rbacManage: {
    id: randomUUID(),
    name: 'rbac:manage',
    description: 'Manage roles and permissions',
  },
  allowlistRead: {
    id: randomUUID(),
    name: 'allowlist:read',
    description: 'Read allowlist',
  },
  allowlistWrite: {
    id: randomUUID(),
    name: 'allowlist:write',
    description: 'Modify allowlist',
  },
};

export const mockRoles = {
  admin: {
    id: randomUUID(),
    name: 'admin',
    description: 'Full system access',
  },
  contributor: {
    id: randomUUID(),
    name: 'contributor',
    description: 'Standard user capabilities',
  },
  viewer: {
    id: randomUUID(),
    name: 'viewer',
    description: 'Read-only access',
  },
};

// ============================================================================
// User Factory
// ============================================================================

export interface CreateMockUserOptions {
  id?: string;
  email?: string;
  displayName?: string | null;
  providerDisplayName?: string | null;
  profileImageUrl?: string | null;
  providerProfileImageUrl?: string | null;
  isActive?: boolean;
  roleName?: 'admin' | 'contributor' | 'viewer';
  createdAt?: Date;
  updatedAt?: Date;
}

export function createMockUser(options: CreateMockUserOptions = {}): any {
  const timestamp = Date.now();
  const {
    id = randomUUID(),
    email = `test-${timestamp}@example.com`,
    displayName = null,
    providerDisplayName = 'Test User',
    profileImageUrl = null,
    providerProfileImageUrl = 'https://example.com/photo.jpg',
    isActive = true,
    createdAt = new Date(),
    updatedAt = new Date(),
  } = options;

  return {
    id,
    email,
    displayName,
    providerDisplayName,
    profileImageUrl,
    providerProfileImageUrl,
    isActive,
    createdAt,
    updatedAt,
  };
}

// ============================================================================
// User Identity Factory
// ============================================================================

export interface CreateMockUserIdentityOptions {
  id?: string;
  userId: string;
  provider?: string;
  providerSubject?: string;
  providerEmail?: string | null;
  createdAt?: Date;
}

export function createMockUserIdentity(
  options: CreateMockUserIdentityOptions,
): any {
  const timestamp = Date.now();
  const {
    id = randomUUID(),
    userId,
    provider = 'google',
    providerSubject = `google-${timestamp}`,
    providerEmail = `test-${timestamp}@example.com`,
    createdAt = new Date(),
  } = options;

  return {
    id,
    userId,
    provider,
    providerSubject,
    providerEmail,
    createdAt,
  };
}

// ============================================================================
// User Role Factory
// ============================================================================

export interface CreateMockUserRoleOptions {
  userId: string;
  roleId: string;
}

export function createMockUserRole(options: CreateMockUserRoleOptions): any {
  const { userId, roleId } = options;

  // UserRole has composite primary key [userId, roleId], no id field
  return {
    userId,
    roleId,
  };
}

// ============================================================================
// User Settings Factory
// ============================================================================

export interface CreateMockUserSettingsOptions {
  id?: string;
  userId: string;
  value?: any;
  version?: number;
  updatedAt?: Date;
}

export function createMockUserSettings(
  options: CreateMockUserSettingsOptions,
): any {
  const {
    id = randomUUID(),
    userId,
    value = {
      theme: 'system',
      profile: {
        displayName: null,
        useProviderImage: true,
        customImageUrl: null,
      },
      updatedAt: new Date().toISOString(),
      version: 1,
    },
    version = 1,
    updatedAt = new Date(),
  } = options;

  return {
    id,
    userId,
    value,
    version,
    updatedAt,
  };
}

// ============================================================================
// System Settings Factory
// ============================================================================

export interface CreateMockSystemSettingsOptions {
  id?: string;
  key?: string;
  value?: any;
  version?: number;
  updatedByUserId?: string | null;
  updatedAt?: Date;
}

export function createMockSystemSettings(
  options: CreateMockSystemSettingsOptions = {},
): any {
  const {
    id = randomUUID(),
    key = 'default',
    value = {
      ui: { allowUserThemeOverride: true },
      features: {},
    },
    version = 1,
    updatedByUserId = null,
    updatedAt = new Date(),
  } = options;

  return {
    id,
    key,
    value,
    version,
    updatedByUserId,
    updatedAt,
  };
}

// ============================================================================
// Allowed Email Factory
// ============================================================================

export interface CreateMockAllowedEmailOptions {
  id?: string;
  email: string;
  notes?: string | null;
  addedById?: string | null;
  claimedById?: string | null;
  claimedAt?: Date | null;
  addedAt?: Date;
}

export function createMockAllowedEmail(
  options: CreateMockAllowedEmailOptions,
): any {
  const {
    id = randomUUID(),
    email,
    notes = null,
    addedById = null,
    claimedById = null,
    claimedAt = null,
    addedAt = new Date(),
  } = options;

  return {
    id,
    email: email.toLowerCase(),
    notes,
    addedById,
    claimedById,
    claimedAt,
    addedAt,
  };
}

// ============================================================================
// Audit Event Factory
// ============================================================================

export interface CreateMockAuditEventOptions {
  id?: string;
  actorUserId?: string | null;
  action: string;
  targetId: string;
  targetType: string;
  meta?: any;
  createdAt?: Date;
}

export function createMockAuditEvent(options: CreateMockAuditEventOptions): any {
  const {
    id = randomUUID(),
    actorUserId = null,
    action,
    targetId,
    targetType,
    meta = {},
    createdAt = new Date(),
  } = options;

  return {
    id,
    actorUserId,
    action,
    targetId,
    targetType,
    meta,
    createdAt,
  };
}

// ============================================================================
// Role Permissions Mapping
// ============================================================================

/**
 * Maps role names to their permissions
 * This mirrors the actual RBAC configuration
 */
export const rolePermissionsMap = {
  admin: [
    mockPermissions.systemSettingsRead,
    mockPermissions.systemSettingsWrite,
    mockPermissions.userSettingsRead,
    mockPermissions.userSettingsWrite,
    mockPermissions.usersRead,
    mockPermissions.usersWrite,
    mockPermissions.rbacManage,
    mockPermissions.allowlistRead,
    mockPermissions.allowlistWrite,
  ],
  contributor: [
    mockPermissions.userSettingsRead,
    mockPermissions.userSettingsWrite,
  ],
  viewer: [
    mockPermissions.userSettingsRead,
    mockPermissions.userSettingsWrite,
  ],
};

// ============================================================================
// Complete User with Relations
// ============================================================================

export interface MockUserWithRelations {
  id: string;
  email: string;
  displayName: string | null;
  providerDisplayName: string | null;
  profileImageUrl: string | null;
  providerProfileImageUrl: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  userRoles?: Array<{
    userId: string;
    roleId: string;
    role: {
      id: string;
      name: string;
      description: string | null;
      rolePermissions: Array<{
        roleId: string;
        permissionId: string;
        permission: { id: string; name: string; description: string | null };
      }>;
    };
  }>;
  identities?: any[];
  userSettings?: any;
}

export function createMockUserWithRelations(
  options: CreateMockUserOptions = {},
): MockUserWithRelations {
  const user = createMockUser(options);
  const roleName = options.roleName || 'viewer';
  const role = mockRoles[roleName];

  // Get permissions for this role
  const permissions = rolePermissionsMap[roleName] || [];

  // Build the full nested structure matching AuthenticatedUser type
  const roleWithPermissions = {
    ...role,
    rolePermissions: permissions.map((permission) => ({
      roleId: role.id,
      permissionId: permission.id,
      permission,
    })),
  };

  const userRole = createMockUserRole({
    userId: user.id,
    roleId: role.id,
  });

  const identity = createMockUserIdentity({
    userId: user.id,
    providerEmail: user.email,
  });

  const settings = createMockUserSettings({
    userId: user.id,
  });

  return {
    ...user,
    userRoles: [{ ...userRole, role: roleWithPermissions }],
    identities: [identity],
    userSettings: settings,
  };
}
