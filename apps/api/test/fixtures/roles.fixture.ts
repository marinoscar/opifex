export const roleFixtures = {
  admin: {
    name: 'admin',
    description: 'Full system access',
  },
  contributor: {
    name: 'contributor',
    description: 'Standard user capabilities',
  },
  viewer: {
    name: 'viewer',
    description: 'Read-only access',
  },
};

export const permissionFixtures = {
  systemSettingsRead: {
    name: 'system_settings:read',
    description: 'Read system settings',
  },
  systemSettingsWrite: {
    name: 'system_settings:write',
    description: 'Modify system settings',
  },
  userSettingsRead: {
    name: 'user_settings:read',
    description: 'Read user settings',
  },
  userSettingsWrite: {
    name: 'user_settings:write',
    description: 'Modify user settings',
  },
  usersRead: {
    name: 'users:read',
    description: 'Read user data',
  },
  usersWrite: {
    name: 'users:write',
    description: 'Modify user data',
  },
  rbacManage: {
    name: 'rbac:manage',
    description: 'Manage roles and permissions',
  },
};
