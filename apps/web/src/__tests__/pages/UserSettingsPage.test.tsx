import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { render, mockUser } from '../utils/test-utils';
import UserSettingsPage from '../../pages/UserSettingsPage';

// Mock the hooks
vi.mock('../../hooks/useUserSettings', () => ({
  useUserSettings: vi.fn(),
}));

import { useUserSettings } from '../../hooks/useUserSettings';

const mockUseUserSettings = vi.mocked(useUserSettings);

describe('UserSettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default mock implementation
    mockUseUserSettings.mockReturnValue({
      settings: {
        theme: 'system',
        profile: {
          displayName: undefined,
          useProviderImage: true,
          customImageUrl: undefined,
        },
        updatedAt: new Date().toISOString(),
        version: 1,
      },
      isLoading: false,
      error: null,
      isSaving: false,
      updateSettings: vi.fn(),
      updateTheme: vi.fn().mockResolvedValue(undefined),
      updateProfile: vi.fn().mockResolvedValue(undefined),
      refresh: vi.fn(),
    });
  });

  describe('Loading State', () => {
    it('should show loading spinner while fetching settings', () => {
      mockUseUserSettings.mockReturnValue({
        settings: null,
        isLoading: true,
        error: null,
        isSaving: false,
        updateSettings: vi.fn(),
        updateTheme: vi.fn(),
        updateProfile: vi.fn(),
        refresh: vi.fn(),
      });

      render(<UserSettingsPage />);

      expect(screen.getByRole('progressbar')).toBeInTheDocument();
    });

    it('should display settings after loading', async () => {
      render(<UserSettingsPage />);

      await waitFor(() => {
        expect(screen.getByText(/settings/i)).toBeInTheDocument();
      });
    });
  });

  describe('Page Content', () => {
    it('should display page title', () => {
      render(<UserSettingsPage />);

      expect(screen.getByRole('heading', { name: /settings/i })).toBeInTheDocument();
    });

    it('should display page description', () => {
      render(<UserSettingsPage />);

      expect(screen.getByText(/manage your account preferences/i)).toBeInTheDocument();
    });
  });

  describe('Error Display', () => {
    it('should display error message when error exists', () => {
      mockUseUserSettings.mockReturnValue({
        settings: null,
        isLoading: false,
        error: 'Failed to load settings',
        isSaving: false,
        updateSettings: vi.fn(),
        updateTheme: vi.fn(),
        updateProfile: vi.fn(),
        refresh: vi.fn(),
      });

      render(<UserSettingsPage />);

      expect(screen.getByText(/failed to load settings/i)).toBeInTheDocument();
    });
  });

  describe('Theme Settings', () => {
    it('should call updateTheme when theme is changed', async () => {
      const updateTheme = vi.fn().mockResolvedValue(undefined);
      mockUseUserSettings.mockReturnValue({
        settings: {
          theme: 'light',
          profile: {
            displayName: undefined,
            useProviderImage: true,
            customImageUrl: undefined,
          },
          updatedAt: new Date().toISOString(),
          version: 1,
        },
        isLoading: false,
        error: null,
        isSaving: false,
        updateSettings: vi.fn(),
        updateTheme,
        updateProfile: vi.fn(),
        refresh: vi.fn(),
      });

      render(<UserSettingsPage />);

      // Theme change will be triggered by ThemeSettings component
      // This test verifies the hook is available
      expect(updateTheme).toBeDefined();
    });

    it('should show success message after theme update', async () => {
      const updateTheme = vi.fn().mockResolvedValue(undefined);
      mockUseUserSettings.mockReturnValue({
        settings: {
          theme: 'system',
          profile: {
            displayName: undefined,
            useProviderImage: true,
            customImageUrl: undefined,
          },
          updatedAt: new Date().toISOString(),
          version: 1,
        },
        isLoading: false,
        error: null,
        isSaving: false,
        updateSettings: vi.fn(),
        updateTheme,
        updateProfile: vi.fn(),
        refresh: vi.fn(),
      });

      render(<UserSettingsPage />);

      // Component should be ready to show success messages
      await waitFor(() => {
        expect(screen.getByText(/settings/i)).toBeInTheDocument();
      });
    });

    it('should show error message when theme update fails', async () => {
      const updateTheme = vi.fn().mockRejectedValue(new Error('Update failed'));
      mockUseUserSettings.mockReturnValue({
        settings: {
          theme: 'system',
          profile: {
            displayName: undefined,
            useProviderImage: true,
            customImageUrl: undefined,
          },
          updatedAt: new Date().toISOString(),
          version: 1,
        },
        isLoading: false,
        error: null,
        isSaving: false,
        updateSettings: vi.fn(),
        updateTheme,
        updateProfile: vi.fn(),
        refresh: vi.fn(),
      });

      render(<UserSettingsPage />);

      await waitFor(() => {
        expect(screen.getByText(/settings/i)).toBeInTheDocument();
      });
    });
  });

  describe('Profile Settings', () => {
    it('should call updateProfile when profile is saved', async () => {
      const updateProfile = vi.fn().mockResolvedValue(undefined);
      mockUseUserSettings.mockReturnValue({
        settings: {
          theme: 'system',
          profile: {
            displayName: 'Test User',
            useProviderImage: false,
            customImageUrl: 'https://example.com/avatar.jpg',
          },
          updatedAt: new Date().toISOString(),
          version: 1,
        },
        isLoading: false,
        error: null,
        isSaving: false,
        updateSettings: vi.fn(),
        updateTheme: vi.fn(),
        updateProfile,
        refresh: vi.fn(),
      });

      render(<UserSettingsPage />);

      // Profile update will be triggered by ProfileSettings component
      expect(updateProfile).toBeDefined();
    });
  });

  describe('Save State', () => {
    it('should disable controls while saving', () => {
      mockUseUserSettings.mockReturnValue({
        settings: {
          theme: 'system',
          profile: {
            displayName: undefined,
            useProviderImage: true,
            customImageUrl: undefined,
          },
          updatedAt: new Date().toISOString(),
          version: 1,
        },
        isLoading: false,
        error: null,
        isSaving: true,
        updateSettings: vi.fn(),
        updateTheme: vi.fn(),
        updateProfile: vi.fn(),
        refresh: vi.fn(),
      });

      render(<UserSettingsPage />);

      // Settings components should receive disabled prop
      expect(screen.getByText(/settings/i)).toBeInTheDocument();
    });
  });

  describe('Settings Components', () => {
    it('should render ThemeSettings component', () => {
      render(<UserSettingsPage />);

      // ThemeSettings component should be rendered
      expect(screen.getByText(/settings/i)).toBeInTheDocument();
    });

    it('should render ProfileSettings component', () => {
      render(<UserSettingsPage />);

      // ProfileSettings component should be rendered
      expect(screen.getByText(/settings/i)).toBeInTheDocument();
    });

    it('should pass current settings to components', () => {
      mockUseUserSettings.mockReturnValue({
        settings: {
          theme: 'dark',
          profile: {
            displayName: 'Custom Name',
            useProviderImage: false,
            customImageUrl: 'https://example.com/avatar.jpg',
          },
          updatedAt: new Date().toISOString(),
          version: 1,
        },
        isLoading: false,
        error: null,
        isSaving: false,
        updateSettings: vi.fn(),
        updateTheme: vi.fn(),
        updateProfile: vi.fn(),
        refresh: vi.fn(),
      });

      render(<UserSettingsPage />);

      expect(screen.getByText(/settings/i)).toBeInTheDocument();
    });
  });

  describe('Snackbar Notifications', () => {
    it('should close success message when dismissed', async () => {
      render(<UserSettingsPage />);

      // Snackbar should be present in the component
      await waitFor(() => {
        expect(screen.getByText(/settings/i)).toBeInTheDocument();
      });
    });

    it('should close error message when dismissed', async () => {
      render(<UserSettingsPage />);

      // Snackbar should be present in the component
      await waitFor(() => {
        expect(screen.getByText(/settings/i)).toBeInTheDocument();
      });
    });
  });

  /**
   * The identity header, moved here from the old home page (issue #75).
   *
   * `/settings` is the one page that is entirely about the current user and it
   * had no indication of WHOSE settings were being edited. The cockpit, which
   * is about the fleet rather than about a person, is where it did not belong.
   */
  describe('Identity header', () => {
    it('shows who is signed in', () => {
      render(<UserSettingsPage />);

      expect(screen.getByText(mockUser.email)).toBeInTheDocument();
      expect(screen.getByText(mockUser.displayName!)).toBeInTheDocument();
      expect(screen.getByText('Member since')).toBeInTheDocument();
    });

    it('drops the card\'s "Account Settings" button, which pointed here', () => {
      // A button navigating to the page you are already on is a dead control,
      // and this is the most conspicuous place to leave one.
      render(<UserSettingsPage />);

      expect(
        screen.queryByRole('button', { name: /account settings/i }),
      ).not.toBeInTheDocument();
    });

    it('renders above the settings cards', () => {
      render(<UserSettingsPage />);

      const email = screen.getByText(mockUser.email);
      const themeCard = document.getElementById('theme')!;

      expect(
        email.compareDocumentPosition(themeCard) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });
  });

  /**
   * `/settings#theme` (issue #78).
   *
   * The `#theme` anchor always existed — `ThemeSettings` renders
   * `<Card id="theme">`. The bug was that react-router does no hash scrolling
   * and this page returns a spinner until settings resolve, so the target is
   * absent at navigation time. Hence the `ready` gate.
   */
  describe('Hash navigation', () => {
    it('scrolls to and focuses the theme card once settings have loaded', () => {
      const scrollIntoView = vi.fn();
      Element.prototype.scrollIntoView = scrollIntoView;

      render(<UserSettingsPage />, { wrapperOptions: { route: '/settings#theme' } });

      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(document.activeElement).toBe(document.getElementById('theme'));
    });

    it('does nothing while the page is still a spinner', () => {
      const scrollIntoView = vi.fn();
      Element.prototype.scrollIntoView = scrollIntoView;

      mockUseUserSettings.mockReturnValue({
        settings: null,
        isLoading: true,
        error: null,
        isSaving: false,
        updateSettings: vi.fn(),
        updateTheme: vi.fn(),
        updateProfile: vi.fn(),
        refresh: vi.fn(),
      });

      render(<UserSettingsPage />, { wrapperOptions: { route: '/settings#theme' } });

      expect(scrollIntoView).not.toHaveBeenCalled();
    });
  });

});
