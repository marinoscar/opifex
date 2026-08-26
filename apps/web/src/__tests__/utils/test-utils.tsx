import { ReactElement, ReactNode } from 'react';
import { render, RenderOptions, RenderResult } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { CssBaseline } from '@mui/material';
import { vi } from 'vitest';

// Import AuthContext and ThemeContextProvider
import { AuthContext } from '../../contexts/AuthContext';
import { ThemeContextProvider } from '../../contexts/ThemeContext';
import type { AuthProvider as AuthProviderType } from '../../types';

interface WrapperOptions {
  route?: string;
  theme?: 'light' | 'dark';
  authenticated?: boolean;
  user?: MockUser | null;
  isLoading?: boolean;
  providers?: AuthProviderType[];
  /**
   * Injected so a test can assert that a component RE-READS `/auth/me` rather
   * than inferring a new value (#347). The mock provider makes its own spy
   * otherwise, which no test could reach.
   */
  refreshUser?: () => Promise<void>;
}

export interface MockUser {
  id: string;
  email: string;
  displayName: string | null;
  profileImageUrl: string | null;
  roles: { name: string }[];
  permissions: string[];
  /**
   * The theme policy, as `/auth/me` delivers it (#79, #211). Optional exactly
   * as it is on the real `User`: absent means allowed.
   */
  allowUserThemeOverride?: boolean;
  isActive: boolean;
  createdAt: string;
}

export const mockUser: MockUser = {
  id: 'test-user-id',
  email: 'test@example.com',
  displayName: 'Test User',
  profileImageUrl: null,
  roles: [{ name: 'viewer' }],
  permissions: [
    'user_settings:read',
    'user_settings:write',
    // The Opifex read permissions the seeded `viewer` role really grants
    // (apps/api/prisma/seed.ts). A viewer fixture missing them would test a
    // user that cannot exist — and since #80 gated the Queue destination on
    // `workorders:read`, it would assert that a viewer cannot see the queue,
    // which is false.
    'projects:read',
    'runs:read',
    'workorders:read',
    'escalations:read',
    // A viewer may SEE what is waiting on a person and answer nothing:
    // `approvals:decide` is withheld from the role for the same reason
    // `escalations:acknowledge` is (#98).
    'approvals:read',
    // See what runs unattended and why it stopped; stop nothing. A viewer
    // holds `trust:read` and NOT `trust:revoke` (#101) — revoking is an act on
    // the factory, and a viewer acts on nothing even when the act would
    // narrow rather than widen.
    'trust:read',
  ],
  isActive: true,
  createdAt: new Date().toISOString(),
};

export const mockAdminUser: MockUser = {
  id: 'admin-user-id',
  email: 'admin@example.com',
  displayName: 'Admin User',
  profileImageUrl: null,
  roles: [{ name: 'admin' }],
  permissions: [
    'user_settings:read',
    'user_settings:write',
    'system_settings:read',
    'system_settings:write',
    'users:read',
    'users:write',
    'rbac:manage',
    // Present because the seeded `admin` role grants them
    // (apps/api/prisma/seed.ts). The Allowlist tab gates on `allowlist:read`,
    // so an admin fixture missing it would test a user that cannot exist.
    'allowlist:read',
    'allowlist:write',
    // Likewise the Opifex domain permissions the seeded `admin` role grants.
    'projects:read',
    'projects:write',
    'runs:read',
    'workorders:read',
    'escalations:read',
    // The admin holds all three approval-related permissions, which is what
    // makes VISION §8's third option — "Always approve this class" — available
    // to them and to nobody else.
    'approvals:read',
    'approvals:decide',
    // All three trust permissions, as the seeded `admin` role grants them
    // (#101). `trust:grant` is admin-only; `trust:read` and `trust:revoke` are
    // held by contributors too.
    'trust:read',
    'trust:grant',
    'trust:revoke',
  ],
  isActive: true,
  createdAt: new Date().toISOString(),
};

// Default mock providers
const defaultMockProviders: AuthProviderType[] = [
  { name: 'google', authUrl: '/api/auth/google' },
];

// Mock Auth Provider for testing
interface MockAuthProviderProps {
  children: ReactNode;
  authenticated?: boolean;
  user?: MockUser | null;
  isLoading?: boolean;
  providers?: AuthProviderType[];
  refreshUser?: () => Promise<void>;
}

function MockAuthProvider({
  children,
  authenticated = true,
  user = mockUser,
  isLoading = false,
  providers = defaultMockProviders,
  refreshUser,
}: MockAuthProviderProps) {
  const contextValue = {
    user: authenticated ? user : null,
    isLoading,
    isAuthenticated: authenticated,
    providers,
    login: vi.fn(),
    logout: vi.fn().mockResolvedValue(undefined),
    refreshUser: refreshUser ?? vi.fn().mockResolvedValue(undefined),
  };

  return (
    <AuthContext.Provider value={contextValue}>{children}</AuthContext.Provider>
  );
}

function createWrapper(options: WrapperOptions = {}) {
  const {
    route = '/',
    authenticated = true,
    user = mockUser,
    isLoading = false,
    providers = defaultMockProviders,
    refreshUser,
  } = options;

  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <MemoryRouter initialEntries={[route]}>
        <ThemeContextProvider>
          <CssBaseline />
          <MockAuthProvider
            authenticated={authenticated}
            user={user}
            isLoading={isLoading}
            providers={providers}
            refreshUser={refreshUser}
          >
            {children}
          </MockAuthProvider>
        </ThemeContextProvider>
      </MemoryRouter>
    );
  };
}

interface CustomRenderOptions extends Omit<RenderOptions, 'wrapper'> {
  wrapperOptions?: WrapperOptions;
}

export function renderWithProviders(
  ui: ReactElement,
  options: CustomRenderOptions = {},
): RenderResult {
  const { wrapperOptions, ...renderOptions } = options;

  return render(ui, {
    wrapper: createWrapper(wrapperOptions),
    ...renderOptions,
  });
}

// Re-export everything from testing library
export * from '@testing-library/react';
export { renderWithProviders as render };
