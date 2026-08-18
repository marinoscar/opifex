import { User, UserSettings, SystemSettings, AuthProvider } from '../../types';

export const mockUsers: User[] = [
  {
    id: 'user-1',
    email: 'viewer@example.com',
    displayName: 'Viewer User',
    profileImageUrl: null,
    roles: ['viewer'],
    permissions: ['user_settings:read'],
    isActive: true,
    createdAt: '2024-01-01T00:00:00.000Z',
  },
  {
    id: 'user-2',
    email: 'contributor@example.com',
    displayName: 'Contributor User',
    profileImageUrl: 'https://example.com/photo.jpg',
    roles: ['contributor'],
    permissions: ['user_settings:read', 'user_settings:write'],
    isActive: true,
    createdAt: '2024-01-02T00:00:00.000Z',
  },
  {
    id: 'user-3',
    email: 'admin@example.com',
    displayName: 'Admin User',
    profileImageUrl: null,
    roles: ['admin'],
    permissions: [
      'user_settings:read',
      'user_settings:write',
      'system_settings:read',
      'system_settings:write',
      'users:read',
      'users:write',
      'rbac:manage',
    ],
    isActive: true,
    createdAt: '2024-01-03T00:00:00.000Z',
  },
  {
    id: 'user-4',
    email: 'inactive@example.com',
    displayName: 'Inactive User',
    profileImageUrl: null,
    roles: ['viewer'],
    permissions: [],
    isActive: false,
    createdAt: '2024-01-04T00:00:00.000Z',
  },
];

export const mockUserSettings: UserSettings = {
  theme: 'system',
  profile: {
    displayName: undefined,
    useProviderImage: true,
    customImageUrl: null,
  },
  updatedAt: '2024-01-01T00:00:00.000Z',
  version: 1,
};

export const mockSystemSettings: SystemSettings = {
  ui: {
    allowUserThemeOverride: true,
  },
  features: {},
  updatedAt: '2024-01-01T00:00:00.000Z',
  updatedBy: null,
  version: 1,
};

export const mockAuthProviders: AuthProvider[] = [
  {
    name: 'google',
    authUrl: '/api/auth/google',
  },
];

// Helper to create variations
export function createMockUser(overrides: Partial<User> = {}): User {
  return {
    id: `user-${Date.now()}`,
    email: `user-${Date.now()}@example.com`,
    displayName: 'Mock User',
    profileImageUrl: null,
    roles: ['viewer'],
    permissions: ['user_settings:read'],
    isActive: true,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

export function createMockUserSettings(
  overrides: Partial<UserSettings> = {},
): UserSettings {
  return {
    ...mockUserSettings,
    ...overrides,
  };
}
