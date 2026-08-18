import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useUserSettings } from '../../hooks/useUserSettings';
import { api, ApiError } from '../../services/api';
import type { UserSettings } from '../../types';

// Mock the API module
vi.mock('../../services/api', () => ({
  api: {
    get: vi.fn(),
    patch: vi.fn(),
  },
  ApiError: class ApiError extends Error {
    status: number;
    code?: string;
    details?: any;
    constructor(message: string, status: number, code?: string, details?: any) {
      super(message);
      this.status = status;
      this.code = code;
      this.details = details;
    }
  },
}));

// Helper to mock useThemeContext
const mockSetMode = vi.fn();
vi.mock('../../contexts/ThemeContext', () => ({
  useThemeContext: vi.fn(() => ({
    mode: 'system',
    theme: {},
    isDarkMode: false,
    setMode: mockSetMode,
    toggleMode: vi.fn(),
  })),
}));

// Mock data
const mockUserSettings: UserSettings = {
  theme: 'system',
  profile: {
    displayName: 'Test User',
    useProviderImage: true,
    customImageUrl: null,
  },
  updatedAt: new Date().toISOString(),
  version: 1,
};

describe('useUserSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSetMode.mockClear();
  });

  describe('Initial Loading State', () => {
    it('should start in loading state', () => {
      vi.mocked(api.get).mockImplementation(
        () => new Promise(() => {}), // Never resolves
      );

      const { result } = renderHook(() => useUserSettings());

      expect(result.current.isLoading).toBe(true);
      expect(result.current.settings).toBeNull();
      expect(result.current.error).toBeNull();
    });

    it('should not be saving initially', () => {
      vi.mocked(api.get).mockImplementation(
        () => new Promise(() => {}),
      );

      const { result } = renderHook(() => useUserSettings());

      expect(result.current.isSaving).toBe(false);
    });
  });

  describe('Successful Settings Fetch', () => {
    it('should fetch settings on mount', async () => {
      vi.mocked(api.get).mockResolvedValue(mockUserSettings);

      const { result } = renderHook(() => useUserSettings());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(api.get).toHaveBeenCalledWith('/user-settings');
      expect(result.current.settings).toEqual(mockUserSettings);
      expect(result.current.error).toBeNull();
    });

    it('should sync theme with ThemeContext on fetch', async () => {
      const settingsWithDarkTheme: UserSettings = {
        ...mockUserSettings,
        theme: 'dark',
      };
      vi.mocked(api.get).mockResolvedValue(settingsWithDarkTheme);

      renderHook(() => useUserSettings());

      await waitFor(() => {
        expect(mockSetMode).toHaveBeenCalledWith('dark');
      });
    });

    it('should set loading to false after successful fetch', async () => {
      vi.mocked(api.get).mockResolvedValue(mockUserSettings);

      const { result } = renderHook(() => useUserSettings());

      expect(result.current.isLoading).toBe(true);

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });
    });
  });

  describe('Error Handling on Fetch Failure', () => {
    it('should handle API errors during fetch', async () => {
      const apiError = new ApiError('Failed to load settings', 500);
      vi.mocked(api.get).mockRejectedValue(apiError);

      const { result } = renderHook(() => useUserSettings());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.error).toBe('Failed to load settings');
      expect(result.current.settings).toBeNull();
    });

    it('should handle generic errors during fetch', async () => {
      vi.mocked(api.get).mockRejectedValue(new Error('Network error'));

      const { result } = renderHook(() => useUserSettings());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.error).toBe('Failed to load settings');
      expect(result.current.settings).toBeNull();
    });

    it('should clear previous error on successful fetch', async () => {
      // First call fails
      vi.mocked(api.get).mockRejectedValueOnce(
        new ApiError('Failed to load settings', 500),
      );

      const { result } = renderHook(() => useUserSettings());

      await waitFor(() => {
        expect(result.current.error).toBe('Failed to load settings');
      });

      // Refresh with successful response
      vi.mocked(api.get).mockResolvedValue(mockUserSettings);

      await act(async () => {
        await result.current.refresh();
      });

      await waitFor(() => {
        expect(result.current.error).toBeNull();
      });

      expect(result.current.settings).toEqual(mockUserSettings);
    });
  });

  describe('updateTheme', () => {
    it('should update theme settings', async () => {
      vi.mocked(api.get).mockResolvedValue(mockUserSettings);

      const updatedSettings: UserSettings = {
        ...mockUserSettings,
        theme: 'dark',
        version: 2,
      };
      vi.mocked(api.patch).mockResolvedValue(updatedSettings);

      const { result } = renderHook(() => useUserSettings());

      await waitFor(() => {
        expect(result.current.settings).not.toBeNull();
      });

      await act(async () => {
        await result.current.updateTheme('dark');
      });

      expect(api.patch).toHaveBeenCalledWith(
        '/user-settings',
        { theme: 'dark' },
        {
          headers: {
            'If-Match': '1',
          },
        },
      );

      expect(result.current.settings?.theme).toBe('dark');
    });

    it('should sync theme with ThemeContext on update', async () => {
      vi.mocked(api.get).mockResolvedValue(mockUserSettings);

      const updatedSettings: UserSettings = {
        ...mockUserSettings,
        theme: 'light',
        version: 2,
      };
      vi.mocked(api.patch).mockResolvedValue(updatedSettings);

      const { result } = renderHook(() => useUserSettings());

      await waitFor(() => {
        expect(result.current.settings).not.toBeNull();
      });

      mockSetMode.mockClear(); // Clear initial fetch call

      await act(async () => {
        await result.current.updateTheme('light');
      });

      expect(mockSetMode).toHaveBeenCalledWith('light');
    });

    it('should set isSaving during theme update', async () => {
      vi.mocked(api.get).mockResolvedValue(mockUserSettings);

      let resolvePatch: (value: UserSettings) => void;
      const patchPromise = new Promise<UserSettings>((resolve) => {
        resolvePatch = resolve;
      });
      vi.mocked(api.patch).mockReturnValue(patchPromise);

      const { result } = renderHook(() => useUserSettings());

      await waitFor(() => {
        expect(result.current.settings).not.toBeNull();
      });

      act(() => {
        result.current.updateTheme('dark');
      });

      // Should be saving during the update
      expect(result.current.isSaving).toBe(true);

      // Resolve the promise
      await act(async () => {
        resolvePatch!({ ...mockUserSettings, theme: 'dark', version: 2 });
        await patchPromise;
      });

      await waitFor(() => {
        expect(result.current.isSaving).toBe(false);
      });
    });
  });

  describe('updateProfile', () => {
    it('should update profile settings', async () => {
      vi.mocked(api.get).mockResolvedValue(mockUserSettings);

      const newProfile = {
        displayName: 'Updated Name',
        useProviderImage: false,
        customImageUrl: 'https://example.com/avatar.jpg',
      };

      const updatedSettings: UserSettings = {
        ...mockUserSettings,
        profile: newProfile,
        version: 2,
      };
      vi.mocked(api.patch).mockResolvedValue(updatedSettings);

      const { result } = renderHook(() => useUserSettings());

      await waitFor(() => {
        expect(result.current.settings).not.toBeNull();
      });

      await act(async () => {
        await result.current.updateProfile(newProfile);
      });

      expect(api.patch).toHaveBeenCalledWith(
        '/user-settings',
        { profile: newProfile },
        {
          headers: {
            'If-Match': '1',
          },
        },
      );

      expect(result.current.settings?.profile).toEqual(newProfile);
    });

    it('should update version after profile update', async () => {
      vi.mocked(api.get).mockResolvedValue(mockUserSettings);

      const newProfile = {
        displayName: 'New Name',
        useProviderImage: true,
        customImageUrl: null,
      };

      const updatedSettings: UserSettings = {
        ...mockUserSettings,
        profile: newProfile,
        version: 2,
      };
      vi.mocked(api.patch).mockResolvedValue(updatedSettings);

      const { result } = renderHook(() => useUserSettings());

      await waitFor(() => {
        expect(result.current.settings?.version).toBe(1);
      });

      await act(async () => {
        await result.current.updateProfile(newProfile);
      });

      expect(result.current.settings?.version).toBe(2);
    });

    it('should handle errors during profile update', async () => {
      vi.mocked(api.get).mockResolvedValue(mockUserSettings);
      vi.mocked(api.patch).mockRejectedValue(
        new ApiError('Failed to save settings', 500),
      );

      const { result } = renderHook(() => useUserSettings());

      await waitFor(() => {
        expect(result.current.settings).not.toBeNull();
      });

      // Should throw error
      await expect(async () => {
        await act(async () => {
          await result.current.updateProfile({
            displayName: 'New Name',
            useProviderImage: true,
          });
        });
      }).rejects.toThrow();

      // isSaving should be false after error
      expect(result.current.isSaving).toBe(false);
    });
  });

  describe('refresh', () => {
    it('should manually refresh settings', async () => {
      vi.mocked(api.get).mockResolvedValue(mockUserSettings);

      const { result } = renderHook(() => useUserSettings());

      await waitFor(() => {
        expect(result.current.settings).not.toBeNull();
      });

      // Change mock data
      const updatedSettings: UserSettings = {
        ...mockUserSettings,
        theme: 'dark',
        version: 2,
      };
      vi.mocked(api.get).mockResolvedValue(updatedSettings);

      await act(async () => {
        await result.current.refresh();
      });

      expect(result.current.settings?.theme).toBe('dark');
      expect(result.current.settings?.version).toBe(2);
    });

    it('should set loading state during refresh', async () => {
      vi.mocked(api.get).mockResolvedValue(mockUserSettings);

      const { result } = renderHook(() => useUserSettings());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      let resolveRefresh: (value: UserSettings) => void;
      const refreshPromise = new Promise<UserSettings>((resolve) => {
        resolveRefresh = resolve;
      });
      vi.mocked(api.get).mockReturnValue(refreshPromise);

      act(() => {
        result.current.refresh();
      });

      expect(result.current.isLoading).toBe(true);

      await act(async () => {
        resolveRefresh!(mockUserSettings);
        await refreshPromise;
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });
    });

    it('should sync theme on refresh', async () => {
      vi.mocked(api.get).mockResolvedValue(mockUserSettings);

      const { result } = renderHook(() => useUserSettings());

      await waitFor(() => {
        expect(result.current.settings).not.toBeNull();
      });

      mockSetMode.mockClear();

      const updatedSettings: UserSettings = {
        ...mockUserSettings,
        theme: 'light',
      };
      vi.mocked(api.get).mockResolvedValue(updatedSettings);

      await act(async () => {
        await result.current.refresh();
      });

      expect(mockSetMode).toHaveBeenCalledWith('light');
    });
  });

  describe('Version Conflict Handling (409 errors)', () => {
    it('should handle 409 conflict error', async () => {
      vi.mocked(api.get).mockResolvedValue(mockUserSettings);

      const { result } = renderHook(() => useUserSettings());

      await waitFor(() => {
        expect(result.current.settings).not.toBeNull();
      });

      // Simulate 409 conflict
      vi.mocked(api.patch).mockRejectedValue(
        new ApiError('Version conflict', 409),
      );

      // Should throw specific error message for version conflict
      await expect(async () => {
        await act(async () => {
          await result.current.updateTheme('light');
        });
      }).rejects.toThrow('Settings were updated elsewhere. Please try again.');

      // Verify api.get was called to refresh settings
      expect(api.get).toHaveBeenCalledWith('/user-settings');
    });

    it('should refresh settings on 409 conflict', async () => {
      vi.mocked(api.get).mockResolvedValue(mockUserSettings);

      const { result } = renderHook(() => useUserSettings());

      await waitFor(() => {
        expect(result.current.settings).not.toBeNull();
      });

      // Count how many times get was called before the conflict
      const initialGetCalls = vi.mocked(api.get).mock.calls.length;

      const conflictError = new ApiError('Version conflict', 409);
      vi.mocked(api.patch).mockRejectedValue(conflictError);

      await expect(async () => {
        await act(async () => {
          await result.current.updateSettings({ theme: 'light' });
        });
      }).rejects.toThrow();

      // Verify that api.get was called again to refresh settings
      expect(vi.mocked(api.get).mock.calls.length).toBeGreaterThan(initialGetCalls);
    });

    it('should throw custom error message on version conflict', async () => {
      vi.mocked(api.get).mockResolvedValue(mockUserSettings);

      const { result } = renderHook(() => useUserSettings());

      await waitFor(() => {
        expect(result.current.settings).not.toBeNull();
      });

      vi.mocked(api.patch).mockRejectedValue(
        new ApiError('Version conflict', 409),
      );
      vi.mocked(api.get).mockResolvedValue({
        ...mockUserSettings,
        version: 2,
      });

      let thrownError: Error | null = null;
      try {
        await act(async () => {
          await result.current.updateTheme('dark');
        });
      } catch (error) {
        thrownError = error as Error;
      }

      expect(thrownError).not.toBeNull();
      expect(thrownError?.message).toBe(
        'Settings were updated elsewhere. Please try again.',
      );
    });
  });

  describe('Loading States During Updates', () => {
    it('should set isSaving during updateSettings', async () => {
      vi.mocked(api.get).mockResolvedValue(mockUserSettings);

      let resolvePatch: (value: UserSettings) => void;
      const patchPromise = new Promise<UserSettings>((resolve) => {
        resolvePatch = resolve;
      });
      vi.mocked(api.patch).mockReturnValue(patchPromise);

      const { result } = renderHook(() => useUserSettings());

      await waitFor(() => {
        expect(result.current.settings).not.toBeNull();
      });

      expect(result.current.isSaving).toBe(false);

      act(() => {
        result.current.updateSettings({ theme: 'dark' });
      });

      expect(result.current.isSaving).toBe(true);

      await act(async () => {
        resolvePatch!({ ...mockUserSettings, theme: 'dark', version: 2 });
        await patchPromise;
      });

      await waitFor(() => {
        expect(result.current.isSaving).toBe(false);
      });
    });

    it('should clear isSaving on error', async () => {
      vi.mocked(api.get).mockResolvedValue(mockUserSettings);

      const { result } = renderHook(() => useUserSettings());

      await waitFor(() => {
        expect(result.current.settings).not.toBeNull();
      });

      vi.mocked(api.patch).mockRejectedValue(
        new ApiError('Failed to save', 500),
      );

      await expect(async () => {
        await act(async () => {
          await result.current.updateSettings({ theme: 'dark' });
        });
      }).rejects.toThrow();

      expect(result.current.isSaving).toBe(false);
    });

    it('should clear isSaving even on version conflict', async () => {
      vi.mocked(api.get).mockResolvedValue(mockUserSettings);

      const { result } = renderHook(() => useUserSettings());

      await waitFor(() => {
        expect(result.current.settings).not.toBeNull();
      });

      vi.mocked(api.patch).mockRejectedValue(
        new ApiError('Version conflict', 409),
      );
      vi.mocked(api.get).mockResolvedValue({
        ...mockUserSettings,
        version: 2,
      });

      await expect(async () => {
        await act(async () => {
          await result.current.updateSettings({ theme: 'dark' });
        });
      }).rejects.toThrow();

      expect(result.current.isSaving).toBe(false);
    });

    it('should not update when settings is null', async () => {
      vi.mocked(api.get).mockRejectedValue(
        new ApiError('Failed to load', 500),
      );

      const { result } = renderHook(() => useUserSettings());

      await waitFor(() => {
        expect(result.current.settings).toBeNull();
      });

      await act(async () => {
        await result.current.updateSettings({ theme: 'dark' });
      });

      // Should not call patch if settings is null
      expect(api.patch).not.toHaveBeenCalled();
    });
  });

  describe('Error Clearing', () => {
    it('should clear error on successful update after previous error', async () => {
      vi.mocked(api.get).mockResolvedValue(mockUserSettings);

      const { result } = renderHook(() => useUserSettings());

      await waitFor(() => {
        expect(result.current.settings).not.toBeNull();
      });

      // First update fails
      vi.mocked(api.patch).mockRejectedValueOnce(
        new ApiError('Failed to save', 500),
      );

      await expect(async () => {
        await act(async () => {
          await result.current.updateTheme('dark');
        });
      }).rejects.toThrow();

      // Verify update failed (settings not changed)
      expect(result.current.settings?.theme).toBe('system');

      // Second update succeeds
      vi.mocked(api.patch).mockResolvedValue({
        ...mockUserSettings,
        theme: 'dark',
        version: 2,
      });

      await act(async () => {
        await result.current.updateTheme('dark');
      });

      // Verify update succeeded
      expect(result.current.settings?.theme).toBe('dark');
      expect(result.current.error).toBeNull();
    });

    it('should clear error when starting new update', async () => {
      vi.mocked(api.get).mockResolvedValue(mockUserSettings);

      const { result } = renderHook(() => useUserSettings());

      await waitFor(() => {
        expect(result.current.settings).not.toBeNull();
      });

      // First update fails
      vi.mocked(api.patch).mockRejectedValueOnce(
        new ApiError('Failed to save', 500),
      );

      await expect(async () => {
        await act(async () => {
          await result.current.updateTheme('dark');
        });
      }).rejects.toThrow();

      // Settings should not have changed
      expect(result.current.settings?.theme).toBe('system');

      // Second update succeeds
      vi.mocked(api.patch).mockResolvedValue({
        ...mockUserSettings,
        theme: 'light',
        version: 2,
      });

      await act(async () => {
        await result.current.updateTheme('light');
      });

      // Settings should now be updated with no error
      expect(result.current.settings?.theme).toBe('light');
      expect(result.current.error).toBeNull();
    });
  });

  describe('If-Match Header', () => {
    it('should send correct version in If-Match header', async () => {
      const settingsVersion3: UserSettings = {
        ...mockUserSettings,
        version: 3,
      };
      vi.mocked(api.get).mockResolvedValue(settingsVersion3);

      const { result } = renderHook(() => useUserSettings());

      await waitFor(() => {
        expect(result.current.settings?.version).toBe(3);
      });

      vi.mocked(api.patch).mockResolvedValue({
        ...settingsVersion3,
        theme: 'dark',
        version: 4,
      });

      await act(async () => {
        await result.current.updateTheme('dark');
      });

      expect(api.patch).toHaveBeenCalledWith(
        '/user-settings',
        { theme: 'dark' },
        {
          headers: {
            'If-Match': '3',
          },
        },
      );
    });
  });
});
