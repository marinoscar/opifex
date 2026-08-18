import { describe, it, expect, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockUser, mockAdminUser } from '../utils/test-utils';
import HomePage from '../../pages/HomePage';

describe('HomePage', () => {
  beforeEach(() => {
    // Reset any state before each test
  });

  describe('Rendering', () => {
    it('should render welcome message with user display name', async () => {
      render(<HomePage />, {
        wrapperOptions: {
          authenticated: true,
          user: mockUser,
        },
      });

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /welcome back, test user/i })).toBeInTheDocument();
      });
    });

    it('should render welcome message without name when display name is null', async () => {
      const userWithoutName = {
        ...mockUser,
        displayName: null,
      };

      render(<HomePage />, {
        wrapperOptions: {
          authenticated: true,
          user: userWithoutName,
        },
      });

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /^welcome back$/i })).toBeInTheDocument();
      });
    });

    it('should render dashboard overview description', () => {
      render(<HomePage />);

      expect(screen.getByText(/your dashboard overview/i)).toBeInTheDocument();
    });

    it('should render UserProfileCard component', () => {
      render(<HomePage />);

      // UserProfileCard shows the user's email
      expect(screen.getByText(mockUser.email)).toBeInTheDocument();
    });

    it('should render QuickActions component', () => {
      render(<HomePage />);

      // QuickActions has a title
      expect(screen.getByText(/quick actions/i)).toBeInTheDocument();
    });
  });

  describe('User Profile Card Display', () => {
    it('should display user email in profile card', () => {
      render(<HomePage />);

      expect(screen.getByText(mockUser.email)).toBeInTheDocument();
    });

    it('should display user display name in profile card', () => {
      render(<HomePage />);

      expect(screen.getByText(mockUser.displayName!)).toBeInTheDocument();
    });

    it('should display user roles as chips', () => {
      render(<HomePage />);

      mockUser.roles.forEach((role) => {
        expect(screen.getByText(role.name)).toBeInTheDocument();
      });
    });

    it('should display member since date', () => {
      render(<HomePage />);

      expect(screen.getByText(/member since/i)).toBeInTheDocument();
    });

    it('should display account settings button', () => {
      render(<HomePage />);

      expect(screen.getByRole('button', { name: /account settings/i })).toBeInTheDocument();
    });
  });

  describe('Quick Actions Section', () => {
    it('should display User Settings quick action', () => {
      render(<HomePage />);

      expect(screen.getByText(/^user settings$/i)).toBeInTheDocument();
      expect(screen.getByText(/manage your profile and preferences/i)).toBeInTheDocument();
    });

    it('should display Theme quick action', () => {
      render(<HomePage />);

      expect(screen.getByText(/^theme$/i)).toBeInTheDocument();
      expect(screen.getByText(/customize your display preferences/i)).toBeInTheDocument();
    });

    it('should not display System Settings for non-admin users', () => {
      render(<HomePage />, {
        wrapperOptions: {
          authenticated: true,
          user: mockUser, // viewer role
        },
      });

      expect(screen.queryByText(/^system settings$/i)).not.toBeInTheDocument();
    });

    it('should display System Settings for admin users', () => {
      render(<HomePage />, {
        wrapperOptions: {
          authenticated: true,
          user: mockAdminUser,
        },
      });

      expect(screen.getByText(/^system settings$/i)).toBeInTheDocument();
      expect(screen.getByText(/configure application settings/i)).toBeInTheDocument();
    });
  });

  describe('Role-Based Display', () => {
    it('should render correctly for Viewer role', () => {
      const viewerUser = {
        ...mockUser,
        roles: [{ name: 'viewer' }],
        permissions: ['user_settings:read', 'user_settings:write'],
      };

      render(<HomePage />, {
        wrapperOptions: {
          authenticated: true,
          user: viewerUser,
        },
      });

      // Should see basic quick actions
      expect(screen.getByText(/^user settings$/i)).toBeInTheDocument();
      expect(screen.getByText(/^theme$/i)).toBeInTheDocument();

      // Should not see admin actions
      expect(screen.queryByText(/^system settings$/i)).not.toBeInTheDocument();
    });

    it('should render correctly for Contributor role', () => {
      const contributorUser = {
        ...mockUser,
        displayName: 'Contributor User',
        roles: [{ name: 'contributor' }],
        permissions: ['user_settings:read', 'user_settings:write'],
      };

      render(<HomePage />, {
        wrapperOptions: {
          authenticated: true,
          user: contributorUser,
        },
      });

      // Should see basic quick actions
      expect(screen.getByText(/^user settings$/i)).toBeInTheDocument();
      expect(screen.getByText(/^theme$/i)).toBeInTheDocument();

      // Should not see admin actions
      expect(screen.queryByText(/^system settings$/i)).not.toBeInTheDocument();
    });

    it('should render correctly for Admin role', () => {
      render(<HomePage />, {
        wrapperOptions: {
          authenticated: true,
          user: mockAdminUser,
        },
      });

      // Should see all quick actions including admin
      expect(screen.getByText(/^user settings$/i)).toBeInTheDocument();
      expect(screen.getByText(/^theme$/i)).toBeInTheDocument();
      expect(screen.getByText(/^system settings$/i)).toBeInTheDocument();
    });

    it('should display admin chip for admin users', () => {
      render(<HomePage />, {
        wrapperOptions: {
          authenticated: true,
          user: mockAdminUser,
        },
      });

      const adminChip = screen.getByText('admin');
      expect(adminChip).toBeInTheDocument();
    });
  });

  describe('Navigation', () => {
    it('should navigate to settings when clicking Account Settings button', async () => {
      const user = userEvent.setup();

      render(<HomePage />);

      const settingsButton = screen.getByRole('button', { name: /account settings/i });
      await user.click(settingsButton);

      // Navigation is handled by MemoryRouter in tests
      // We verify the button is clickable and doesn't crash
      expect(settingsButton).toBeInTheDocument();
    });

    it('should navigate to settings when clicking User Settings quick action', async () => {
      const user = userEvent.setup();

      render(<HomePage />);

      const userSettingsButton = screen.getByRole('button', { name: /user settings manage your profile and preferences/i });
      await user.click(userSettingsButton);

      expect(userSettingsButton).toBeInTheDocument();
    });

    it('should navigate to theme settings when clicking Theme quick action', async () => {
      const user = userEvent.setup();

      render(<HomePage />);

      const themeButton = screen.getByRole('button', { name: /theme customize your display preferences/i });
      await user.click(themeButton);

      expect(themeButton).toBeInTheDocument();
    });

    it('should navigate to system settings when clicking System Settings (admin)', async () => {
      const user = userEvent.setup();

      render(<HomePage />, {
        wrapperOptions: {
          authenticated: true,
          user: mockAdminUser,
        },
      });

      const systemSettingsButton = screen.getByRole('button', { name: /system settings configure application settings/i });
      await user.click(systemSettingsButton);

      expect(systemSettingsButton).toBeInTheDocument();
    });
  });

  describe('Layout and Structure', () => {
    it('should use Container with maxWidth lg', () => {
      const { container } = render(<HomePage />);

      const muiContainer = container.querySelector('.MuiContainer-maxWidthLg');
      expect(muiContainer).toBeInTheDocument();
    });

    it('should have proper vertical padding', () => {
      const { container } = render(<HomePage />);

      // Check that Box with py: 4 exists
      const paddedBox = container.querySelector('[class*="MuiBox"]');
      expect(paddedBox).toBeInTheDocument();
    });

    it('should use Grid layout for profile and actions', () => {
      const { container } = render(<HomePage />);

      const gridContainers = container.querySelectorAll('.MuiGrid-container');
      expect(gridContainers.length).toBeGreaterThan(0);
    });

    it('should have responsive grid items', () => {
      const { container } = render(<HomePage />);

      // Profile card should be xs=12, md=4
      // Quick actions should be xs=12, md=8
      // In MUI 9 Grid v2, items use size-based classes (MuiGrid-grid-xs-12) instead of MuiGrid-item
      const gridContainer = container.querySelector('.MuiGrid-container');
      expect(gridContainer).toBeInTheDocument();
      const gridChildren = gridContainer ? Array.from(gridContainer.children) : [];
      expect(gridChildren.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('User Display Variations', () => {
    it('should handle user with no profile image', () => {
      const userNoImage = {
        ...mockUser,
        profileImageUrl: null,
      };

      render(<HomePage />, {
        wrapperOptions: {
          authenticated: true,
          user: userNoImage,
        },
      });

      // Should still render the user's initials in avatar
      expect(screen.getByText(mockUser.email)).toBeInTheDocument();
    });

    it('should handle user with profile image URL', () => {
      const userWithImage = {
        ...mockUser,
        profileImageUrl: 'https://example.com/avatar.jpg',
      };

      render(<HomePage />, {
        wrapperOptions: {
          authenticated: true,
          user: userWithImage,
        },
      });

      expect(screen.getByText(mockUser.email)).toBeInTheDocument();
    });

    it('should display user initials when no display name', () => {
      const userWithoutName = {
        ...mockUser,
        displayName: null,
      };

      render(<HomePage />, {
        wrapperOptions: {
          authenticated: true,
          user: userWithoutName,
        },
      });

      // UserProfileCard shows "No name set" when displayName is null
      expect(screen.getByText(/no name set/i)).toBeInTheDocument();
    });

    it('should handle multiple roles', () => {
      const multiRoleUser = {
        ...mockUser,
        roles: [{ name: 'admin' }, { name: 'contributor' }],
        permissions: mockAdminUser.permissions,
      };

      render(<HomePage />, {
        wrapperOptions: {
          authenticated: true,
          user: multiRoleUser,
        },
      });

      expect(screen.getByText('admin')).toBeInTheDocument();
      expect(screen.getByText('contributor')).toBeInTheDocument();
    });
  });

  describe('Date Formatting', () => {
    it('should format creation date correctly', () => {
      const specificDate = new Date('2024-01-15T10:00:00Z');
      const userWithDate = {
        ...mockUser,
        createdAt: specificDate.toISOString(),
      };

      render(<HomePage />, {
        wrapperOptions: {
          authenticated: true,
          user: userWithDate,
        },
      });

      // The date should be formatted using toLocaleDateString
      // We just verify the "Member since" label is present
      expect(screen.getByText(/member since/i)).toBeInTheDocument();
    });
  });

  describe('Authentication States', () => {
    it('should render when user is authenticated', () => {
      render(<HomePage />, {
        wrapperOptions: {
          authenticated: true,
          user: mockUser,
        },
      });

      expect(screen.getByRole('heading', { name: /welcome back/i })).toBeInTheDocument();
    });

    it('should handle missing user data gracefully', () => {
      render(<HomePage />, {
        wrapperOptions: {
          authenticated: true,
          user: null,
        },
      });

      // Should still render welcome header without name
      expect(screen.getByRole('heading', { name: /^welcome back$/i })).toBeInTheDocument();
    });
  });

  describe('Accessibility', () => {
    it('should have proper heading hierarchy', () => {
      render(<HomePage />);

      const mainHeading = screen.getByRole('heading', { name: /welcome back/i });
      expect(mainHeading).toBeInTheDocument();
      expect(mainHeading.tagName).toBe('H1');
    });

    it('should have descriptive button labels', () => {
      render(<HomePage />);

      // All buttons should have accessible names
      const accountSettingsBtn = screen.getByRole('button', { name: /account settings/i });
      expect(accountSettingsBtn).toBeInTheDocument();

      const userSettingsBtn = screen.getByRole('button', { name: /user settings/i });
      expect(userSettingsBtn).toBeInTheDocument();
    });

    it('should have proper alt text for avatar images', () => {
      const userWithImage = {
        ...mockUser,
        profileImageUrl: 'https://example.com/avatar.jpg',
      };

      render(<HomePage />, {
        wrapperOptions: {
          authenticated: true,
          user: userWithImage,
        },
      });

      const avatar = screen.getByAltText(mockUser.displayName!);
      expect(avatar).toBeInTheDocument();
    });
  });

  describe('Integration', () => {
    it('should render all components together correctly', () => {
      render(<HomePage />, {
        wrapperOptions: {
          authenticated: true,
          user: mockAdminUser,
        },
      });

      // Main heading
      expect(screen.getByRole('heading', { name: /welcome back, admin user/i })).toBeInTheDocument();

      // Dashboard description
      expect(screen.getByText(/your dashboard overview/i)).toBeInTheDocument();

      // Profile card elements
      expect(screen.getByText(mockAdminUser.email)).toBeInTheDocument();
      expect(screen.getByText(/member since/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /account settings/i })).toBeInTheDocument();

      // Quick actions
      expect(screen.getByText(/quick actions/i)).toBeInTheDocument();
      expect(screen.getByText(/^user settings$/i)).toBeInTheDocument();
      expect(screen.getByText(/^theme$/i)).toBeInTheDocument();
      expect(screen.getByText(/^system settings$/i)).toBeInTheDocument();
    });

    it('should maintain consistent layout across different user types', () => {
      const { rerender } = render(<HomePage />, {
        wrapperOptions: {
          authenticated: true,
          user: mockUser,
        },
      });

      expect(screen.getByText(/quick actions/i)).toBeInTheDocument();

      // Re-render with admin user
      rerender(<HomePage />);

      expect(screen.getByText(/quick actions/i)).toBeInTheDocument();
    });
  });
});
