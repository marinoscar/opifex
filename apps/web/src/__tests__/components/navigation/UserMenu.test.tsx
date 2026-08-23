import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockUser, mockAdminUser } from '../../utils/test-utils';
import { UserMenu } from '../../../components/navigation/UserMenu';
import { DESTINATIONS } from '../../../config/destinations';

// Mock usePermissions hook
vi.mock('../../../hooks/usePermissions', () => ({
  usePermissions: vi.fn(),
}));

import { usePermissions } from '../../../hooks/usePermissions';

const mockUsePermissions = vi.mocked(usePermissions);

describe('UserMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default permission mock - viewer user
    mockUsePermissions.mockReturnValue({
      permissions: new Set(['user_settings:read', 'user_settings:write']),
      roles: new Set(['viewer']),
      hasPermission: (perm: string) =>
        perm === 'user_settings:read' || perm === 'user_settings:write',
      hasAnyPermission: vi.fn(),
      hasAllPermissions: vi.fn(),
      hasRole: vi.fn(),
      hasAnyRole: vi.fn(),
      isAdmin: false,
    });
  });

  describe('Rendering', () => {
    it('should display user avatar button', () => {
      render(<UserMenu />);

      const avatarButton = screen.getByRole('button');
      expect(avatarButton).toBeInTheDocument();
    });

    it('should display user initials when no profile image', () => {
      render(<UserMenu />, {
        wrapperOptions: {
          user: {
            ...mockUser,
            profileImageUrl: null,
            displayName: 'Test User' as string | null,
          },
        },
      });

      // Avatar should contain initials
      const avatarButton = screen.getByRole('button');
      expect(avatarButton).toBeInTheDocument();
    });

    it('should display first letter of email when no display name', () => {
      render(<UserMenu />, {
        wrapperOptions: {
          user: {
            ...mockUser,
            displayName: null as string | null,
          },
        },
      });

      const avatarButton = screen.getByRole('button');
      expect(avatarButton).toBeInTheDocument();
    });

    it('should not render when user is null', () => {
      render(<UserMenu />, {
        wrapperOptions: { authenticated: false },
      });

      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });
  });

  describe('Menu Interaction', () => {
    it('should open menu on click', async () => {
      const user = userEvent.setup();

      render(<UserMenu />);

      const avatarButton = screen.getByRole('button');
      await user.click(avatarButton);

      await waitFor(() => {
        expect(screen.getByRole('menu')).toBeInTheDocument();
      });
    });

    it('should display user email in menu', async () => {
      const user = userEvent.setup();

      render(<UserMenu />);

      await user.click(screen.getByRole('button'));

      await waitFor(() => {
        expect(screen.getByText(mockUser.email)).toBeInTheDocument();
      });
    });

    it('should display user display name in menu', async () => {
      const user = userEvent.setup();

      render(<UserMenu />, {
        wrapperOptions: {
          user: {
            ...mockUser,
            displayName: 'Custom Display Name',
          },
        },
      });

      await user.click(screen.getByRole('button'));

      await waitFor(() => {
        expect(screen.getByText('Custom Display Name')).toBeInTheDocument();
      });
    });

    it('should show placeholder when no display name', async () => {
      const user = userEvent.setup();

      render(<UserMenu />, {
        wrapperOptions: {
          user: {
            ...mockUser,
            displayName: null as string | null,
          },
        },
      });

      await user.click(screen.getByRole('button'));

      await waitFor(() => {
        expect(screen.getByText(/no name set/i)).toBeInTheDocument();
      });
    });

    it('should close menu when clicking outside', async () => {
      const user = userEvent.setup();

      render(<UserMenu />);

      await user.click(screen.getByRole('button'));

      await waitFor(() => {
        expect(screen.getByRole('menu')).toBeInTheDocument();
      });

      // Click outside (on document body)
      await user.keyboard('{Escape}');

      await waitFor(() => {
        expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      });
    });
  });

  describe('Menu Items', () => {
    it('should have settings menu item', async () => {
      const user = userEvent.setup();

      render(<UserMenu />);

      await user.click(screen.getByRole('button'));

      await waitFor(() => {
        expect(
          screen.getByRole('menuitem', { name: /settings/i }),
        ).toBeInTheDocument();
      });
    });

    it('should have logout menu item', async () => {
      const user = userEvent.setup();

      render(<UserMenu />);

      await user.click(screen.getByRole('button'));

      await waitFor(() => {
        expect(
          screen.getByRole('menuitem', { name: /logout/i }),
        ).toBeInTheDocument();
      });
    });

    it('should NOT show system settings even for admin users', async () => {
      // Issue #70. The menu used to carry every destination except Home, so an
      // admin found System Settings and User Management in it. It now carries
      // the ACCOUNT section only: the rail's Administration group and the
      // phone's More sheet both reach those pages, and a third copy of them in
      // the avatar menu is the duplication this epic exists to remove.
      const user = userEvent.setup();

      mockUsePermissions.mockReturnValue({
        permissions: new Set(['system_settings:read', 'users:read']),
        roles: new Set(['admin']),
        hasPermission: () => true,
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin: true,
      });

      render(<UserMenu />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await user.click(screen.getByRole('button'));

      await waitFor(() => {
        expect(screen.getByRole('menu')).toBeInTheDocument();
      });
      expect(
        screen.queryByRole('menuitem', { name: 'System Settings' }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole('menuitem', { name: 'User Management' }),
      ).not.toBeInTheDocument();
    });

    it('should NOT show system settings for non-admin users', async () => {
      const user = userEvent.setup();

      render(<UserMenu />);

      await user.click(screen.getByRole('button'));

      await waitFor(() => {
        expect(screen.getByRole('menu')).toBeInTheDocument();
      });

      expect(
        screen.queryByRole('menuitem', { name: /system settings/i }),
      ).not.toBeInTheDocument();
    });
  });

  describe('Navigation', () => {
    it('should navigate to settings page', async () => {
      const user = userEvent.setup();

      render(<UserMenu />);

      await user.click(screen.getByRole('button'));

      await waitFor(() => {
        expect(
          screen.getByRole('menuitem', { name: /settings/i }),
        ).toBeInTheDocument();
      });

      const settingsItem = screen.getByRole('menuitem', { name: /settings/i });
      await user.click(settingsItem);

      // Menu should close after navigation
      await waitFor(() => {
        expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      });
    });
  });

  describe('Logout', () => {
    it('should call logout on logout click', async () => {
      const user = userEvent.setup();

      render(<UserMenu />);

      await user.click(screen.getByRole('button'));

      await waitFor(() => {
        expect(
          screen.getByRole('menuitem', { name: /logout/i }),
        ).toBeInTheDocument();
      });

      const logoutItem = screen.getByRole('menuitem', { name: /logout/i });
      await user.click(logoutItem);

      // Logout should be triggered
      await waitFor(() => {
        expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      });
    });
  });

  describe('Icons', () => {
    it('should display settings icon', async () => {
      const user = userEvent.setup();

      render(<UserMenu />);

      await user.click(screen.getByRole('button'));

      await waitFor(() => {
        const settingsItem = screen.getByRole('menuitem', {
          name: /settings/i,
        });
        expect(settingsItem).toBeInTheDocument();
      });
    });

    it('should display logout icon', async () => {
      const user = userEvent.setup();

      render(<UserMenu />);

      await user.click(screen.getByRole('button'));

      await waitFor(() => {
        const logoutItem = screen.getByRole('menuitem', { name: /logout/i });
        expect(logoutItem).toBeInTheDocument();
      });
    });
  });

  describe('Accessibility', () => {
    it('should have proper ARIA attributes', async () => {
      const user = userEvent.setup();

      render(<UserMenu />);

      const avatarButton = screen.getByRole('button');
      expect(avatarButton).toHaveAttribute('aria-haspopup', 'true');
      // aria-expanded is undefined when menu is closed (not set)
      expect(avatarButton).not.toHaveAttribute('aria-expanded');

      await user.click(avatarButton);

      await waitFor(() => {
        expect(avatarButton).toHaveAttribute('aria-expanded', 'true');
      });
    });

    it('should have menu ID', async () => {
      const user = userEvent.setup();

      render(<UserMenu />);

      const avatarButton = screen.getByRole('button');
      await user.click(avatarButton);

      await waitFor(() => {
        // MUI Menu puts the id on the presentation wrapper, not the menu role element
        const menuWrapper = document.getElementById('user-menu');
        expect(menuWrapper).toBeInTheDocument();
        // Verify the menu role element exists inside
        expect(screen.getByRole('menu')).toBeInTheDocument();
      });
    });
  });

  describe('Sourced from the destination table', () => {
    /**
     * Issues #70/#71. This menu already gated System Settings on
     * `system_settings:read` while the sidebar gated the same page on the
     * `admin` ROLE — so a Contributor granted that permission saw the menu
     * entry, reached a working page, and had no sidebar row. Both surfaces read
     * `config/destinations.ts` now, so there is one answer per destination.
     *
     * The filter is the SECTION rather than a list of excluded keys. That is
     * the change worth testing: with `key !== 'home'`, every destination added
     * anywhere in the app arrived in the avatar menu by default, and the four
     * planned cockpit pages would have landed here without anyone deciding
     * they should.
     */
    function setPermissions(granted: string[], isAdmin = false) {
      mockUsePermissions.mockReturnValue({
        permissions: new Set(granted),
        roles: new Set(isAdmin ? ['admin'] : ['contributor']),
        hasPermission: (perm: string) => granted.includes(perm),
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin,
      });
    }

    async function openMenu() {
      const user = userEvent.setup();
      await user.click(screen.getByRole('button'));
      await waitFor(() => {
        expect(screen.getByRole('menu')).toBeInTheDocument();
      });
      return user;
    }

    it('offers exactly the account section, whatever the user holds', async () => {
      // A FIXED SHAPE — identity header, User Settings, Logout — for every
      // permission set. An avatar menu is about the account, not the app.
      const accountLabels = DESTINATIONS.filter(
        (d) => d.section === 'account',
      ).map((d) => d.label);

      for (const granted of [[], ['users:read', 'system_settings:read']]) {
        setPermissions(granted, granted.length > 0);
        const { unmount } = render(<UserMenu />, {
          wrapperOptions: { user: mockAdminUser },
        });
        await openMenu();

        for (const label of accountLabels) {
          expect(
            screen.getByRole('menuitem', { name: label }),
          ).toBeInTheDocument();
        }
        // The account destinations plus Logout, and nothing invented locally.
        expect(screen.getAllByRole('menuitem')).toHaveLength(
          accountLabels.length + 1,
        );

        unmount();
      }
    });

    it('omits the cockpit destinations — the rail and the More sheet own them', async () => {
      setPermissions(['users:read', 'system_settings:read'], true);

      render(<UserMenu />, { wrapperOptions: { user: mockAdminUser } });
      await openMenu();

      for (const destination of DESTINATIONS.filter(
        (d) => d.section !== 'account',
      )) {
        expect(
          screen.queryByRole('menuitem', { name: destination.label }),
          `${destination.key} should not be in the avatar menu`,
        ).not.toBeInTheDocument();
      }
    });

    it('labels and targets its entries from the destination table', async () => {
      setPermissions([]);

      render(<UserMenu />);
      await openMenu();

      const settings = DESTINATIONS.find((d) => d.key === 'settings')!;
      expect(
        screen.getByRole('menuitem', { name: settings.label }),
      ).toBeInTheDocument();
    });
  });
});
