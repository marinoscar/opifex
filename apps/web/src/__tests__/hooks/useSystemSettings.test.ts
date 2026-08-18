import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useSystemSettings } from '../../hooks/useSystemSettings';
import { server } from '../mocks/server';
import { http, HttpResponse } from 'msw';
import type { SystemSettings } from '../../types';

// Mock system settings - match the default from handlers.ts
const mockSystemSettings: SystemSettings = {
  ui: {
    allowUserThemeOverride: true,
  },
  features: {},
  updatedAt: new Date().toISOString(),
  updatedBy: null,
  version: 1,
};

describe('useSystemSettings', () => {
  beforeEach(() => {
    // Reset to default successful handlers
    server.resetHandlers();
  });

  describe('Initial Loading State', () => {
    it('should start with loading state', () => {
      const { result } = renderHook(() => useSystemSettings());

      expect(result.current.isLoading).toBe(true);
      expect(result.current.settings).toBeNull();
      expect(result.current.error).toBeNull();
    });

    it('should not be in saving state initially', () => {
      const { result } = renderHook(() => useSystemSettings());

      expect(result.current.isSaving).toBe(false);
    });
  });

  describe('Successful Settings Fetch', () => {
    it('should fetch and set settings on mount', async () => {
      const { result } = renderHook(() => useSystemSettings());

      await waitFor(() => {
        expect(result.current?.isLoading).toBe(false);
      });

      expect(result.current?.settings).not.toBeNull();
      expect(result.current.settings).toMatchObject({
        ui: { allowUserThemeOverride: true },
        features: {},
        updatedBy: null,
        version: 1,
      });
      expect(result.current.error).toBeNull();
    });

    it('should have all expected settings properties', async () => {
      const { result } = renderHook(() => useSystemSettings());

      await waitFor(() => {
        expect(result.current?.settings).not.toBeNull();
      });

      expect(result.current.settings).toHaveProperty('ui');
      expect(result.current.settings).toHaveProperty('features');
      expect(result.current.settings).toHaveProperty('version');
      expect(result.current.settings).toHaveProperty('updatedAt');
      expect(result.current.settings).toHaveProperty('updatedBy');
    });
  });

  describe('Error Handling on Fetch Failure', () => {
    it('should handle generic fetch error', async () => {
      server.use(
        http.get('*/api/system-settings', () => {
          return HttpResponse.json(
            { message: 'Internal server error' },
            { status: 500 }
          );
        })
      );

      const { result } = renderHook(() => useSystemSettings());

      await waitFor(() => {
        expect(result.current?.isLoading).toBe(false);
      });

      expect(result.current.settings).toBeNull();
      expect(result.current.error).toBe('Internal server error');
    });

    it('should handle network error', async () => {
      server.use(
        http.get('*/api/system-settings', () => {
          return HttpResponse.error();
        })
      );

      const { result } = renderHook(() => useSystemSettings());

      await waitFor(() => {
        expect(result.current?.isLoading).toBe(false);
      });

      expect(result.current.settings).toBeNull();
      expect(result.current.error).toBe('Failed to load settings');
    });

    it('should handle 403 permission error with specific message', async () => {
      server.use(
        http.get('*/api/system-settings', () => {
          return HttpResponse.json(
            { message: 'Forbidden' },
            { status: 403 }
          );
        })
      );

      const { result } = renderHook(() => useSystemSettings());

      await waitFor(() => {
        expect(result.current?.isLoading).toBe(false);
      });

      expect(result.current.settings).toBeNull();
      expect(result.current.error).toBe('You do not have permission to view system settings');
    });
  });

  describe('updateSettings - Partial Update with PATCH', () => {
    it('should successfully update settings with PATCH', async () => {
      const { result } = renderHook(() => useSystemSettings());

      // Wait for initial load
      await waitFor(() => {
        expect(result.current?.settings).not.toBeNull();
      });

      const updates = {
        ui: { allowUserThemeOverride: false },
      };

      await act(async () => {
        await result.current.updateSettings(updates);
      });

      expect(result.current.settings?.ui.allowUserThemeOverride).toBe(false);
      expect(result.current.settings?.version).toBe(2);
      expect(result.current.error).toBeNull();
    });

    it('should set isSaving state during update', async () => {
      const { result } = renderHook(() => useSystemSettings());

      await waitFor(() => {
        expect(result.current?.settings).not.toBeNull();
      });

      let resolveRequest: (value: unknown) => void;
      const requestPromise = new Promise((resolve) => {
        resolveRequest = resolve;
      });

      server.use(
        http.patch('*/api/system-settings', async ({ request }) => {
          const body = await request.json();
          await requestPromise;
          return HttpResponse.json({
            data: {
              ...mockSystemSettings,
              ...body,
              version: 2,
            },
          });
        })
      );

      let updatePromise: Promise<void>;
      act(() => {
        updatePromise = result.current.updateSettings({ ui: { allowUserThemeOverride: false } });
      });

      // Should be saving
      await waitFor(() => {
        expect(result.current?.isSaving).toBe(true);
      });

      resolveRequest!(null);
      await act(async () => {
        await updatePromise;
      });

      // Should no longer be saving
      expect(result.current.isSaving).toBe(false);
    });

    it('should include If-Match header with version', async () => {
      const { result } = renderHook(() => useSystemSettings());

      await waitFor(() => {
        expect(result.current?.settings).not.toBeNull();
      });

      let requestHeaders: Headers | undefined;

      server.use(
        http.patch('*/api/system-settings', async ({ request }) => {
          requestHeaders = request.headers;
          const body = await request.json();
          return HttpResponse.json({
            data: {
              ...mockSystemSettings,
              ...body,
              version: 2,
            },
          });
        })
      );

      await act(async () => {
        await result.current.updateSettings({ ui: { allowUserThemeOverride: false } });
      });

      expect(requestHeaders?.get('if-match')).toBe('1');
    });

    it('should not update if settings is null', async () => {
      // Start with a failed initial fetch
      server.use(
        http.get('*/api/system-settings', () => {
          return HttpResponse.json(
            { message: 'Not found' },
            { status: 404 }
          );
        })
      );

      const { result } = renderHook(() => useSystemSettings());

      await waitFor(() => {
        expect(result.current?.isLoading).toBe(false);
      });

      expect(result.current.settings).toBeNull();

      // This should not throw or make a request - it should just return early
      await act(async () => {
        await result.current.updateSettings({ ui: { allowUserThemeOverride: false } });
      });

      // Should still be null
      expect(result.current.settings).toBeNull();
    });

    it('should handle update error', async () => {
      const { result } = renderHook(() => useSystemSettings());

      await waitFor(() => {
        expect(result.current?.settings).not.toBeNull();
      });

      server.use(
        http.patch('*/api/system-settings', () => {
          return HttpResponse.json(
            { message: 'Update failed' },
            { status: 500 }
          );
        })
      );

      // Should throw when update fails
      await expect(
        act(async () => {
          await result.current.updateSettings({ ui: { allowUserThemeOverride: false } });
        })
      ).rejects.toThrow();

      // isSaving should be false after error
      expect(result.current.isSaving).toBe(false);
    });
  });

  describe('replaceSettings - Full Replacement with PUT', () => {
    it('should successfully replace settings with PUT', async () => {
      const { result } = renderHook(() => useSystemSettings());

      await waitFor(() => {
        expect(result.current?.settings).not.toBeNull();
      });

      const newSettings = {
        ui: { allowUserThemeOverride: false },
        features: { newFeature: true },
      };

      await act(async () => {
        await result.current.replaceSettings(newSettings);
      });

      expect(result.current.settings?.ui.allowUserThemeOverride).toBe(false);
      expect(result.current.settings?.features).toEqual({ newFeature: true });
      expect(result.current.error).toBeNull();
    });

    it('should set isSaving state during replace', async () => {
      const { result } = renderHook(() => useSystemSettings());

      await waitFor(() => {
        expect(result.current?.settings).not.toBeNull();
      });

      let resolveRequest: (value: unknown) => void;
      const requestPromise = new Promise((resolve) => {
        resolveRequest = resolve;
      });

      server.use(
        http.put('*/api/system-settings', async ({ request }) => {
          const body = await request.json();
          await requestPromise;
          return HttpResponse.json({
            data: {
              ...body,
              updatedAt: new Date().toISOString(),
              updatedBy: null,
              version: 1,
            },
          });
        })
      );

      const newSettings = {
        ui: { allowUserThemeOverride: false },
        features: {},
      };

      let updatePromise: Promise<void>;
      act(() => {
        updatePromise = result.current.replaceSettings(newSettings);
      });

      await waitFor(() => {
        expect(result.current?.isSaving).toBe(true);
      });

      resolveRequest!(null);
      await act(async () => {
        await updatePromise;
      });

      expect(result.current.isSaving).toBe(false);
    });

    it('should handle replace error', async () => {
      const { result } = renderHook(() => useSystemSettings());

      await waitFor(() => {
        expect(result.current?.settings).not.toBeNull();
      });

      server.use(
        http.put('*/api/system-settings', () => {
          return HttpResponse.json(
            { message: 'Replace failed' },
            { status: 500 }
          );
        })
      );

      const newSettings = {
        ui: { allowUserThemeOverride: false },
        features: {},
      };

      // Should throw when replace fails
      await expect(
        act(async () => {
          await result.current.replaceSettings(newSettings);
        })
      ).rejects.toThrow();

      // isSaving should be false after error
      expect(result.current.isSaving).toBe(false);
    });
  });

  describe('refresh - Manual Refresh Capability', () => {
    it('should refresh settings on demand', async () => {
      const { result } = renderHook(() => useSystemSettings());

      await waitFor(() => {
        expect(result.current?.settings).not.toBeNull();
      });

      const initialSettings = result.current.settings;

      // Mock updated settings
      server.use(
        http.get('*/api/system-settings', () => {
          return HttpResponse.json({
            data: {
              ...mockSystemSettings,
              version: 5,
              updatedAt: new Date().toISOString(),
            },
          });
        })
      );

      await act(async () => {
        await result.current.refresh();
      });

      expect(result.current.settings?.version).toBe(5);
      expect(result.current.settings).not.toEqual(initialSettings);
    });

    it('should set loading state during refresh', async () => {
      const { result } = renderHook(() => useSystemSettings());

      await waitFor(() => {
        expect(result.current?.settings).not.toBeNull();
      });

      let resolveRequest: (value: unknown) => void;
      const requestPromise = new Promise((resolve) => {
        resolveRequest = resolve;
      });

      server.use(
        http.get('*/api/system-settings', async () => {
          await requestPromise;
          return HttpResponse.json({ data: mockSystemSettings });
        })
      );

      let refreshPromise: Promise<void>;
      act(() => {
        refreshPromise = result.current.refresh();
      });

      await waitFor(() => {
        expect(result.current?.isLoading).toBe(true);
      });

      resolveRequest!(null);
      await act(async () => {
        await refreshPromise;
      });

      expect(result.current.isLoading).toBe(false);
    });

    it('should clear error on successful refresh', async () => {
      const { result } = renderHook(() => useSystemSettings());

      // Wait for successful initial load
      await waitFor(() => {
        expect(result.current?.settings).not.toBeNull();
      });

      // Make the first GET fail to set an error on initial load
      server.resetHandlers();
      server.use(
        http.get('*/api/system-settings', () => {
          return HttpResponse.json(
            { message: 'Server error' },
            { status: 500 }
          );
        })
      );

      // Refresh to trigger the error
      await act(async () => {
        await result.current.refresh();
      });

      // Should have an error now
      await waitFor(() => {
        expect(result.current?.error).not.toBeNull();
      });

      // Now make the request succeed
      server.resetHandlers();

      await act(async () => {
        await result.current.refresh();
      });

      // Error should be cleared
      expect(result.current.error).toBeNull();
      expect(result.current.settings).not.toBeNull();
    });
  });

  describe('Version Conflict Handling (409 Errors)', () => {
    it('should handle version conflict on update', async () => {
      const { result } = renderHook(() => useSystemSettings());

      await waitFor(() => {
        expect(result.current?.settings).not.toBeNull();
      });

      server.use(
        http.patch('*/api/system-settings', () => {
          return HttpResponse.json(
            { message: 'Version conflict', code: 'VERSION_CONFLICT' },
            { status: 409 }
          );
        })
      );

      await expect(
        act(async () => {
          await result.current.updateSettings({ ui: { allowUserThemeOverride: false } });
        })
      ).rejects.toThrow('Settings were updated elsewhere. Please review and try again.');

      // Should have refreshed settings after conflict
      await waitFor(() => {
        expect(result.current?.settings).not.toBeNull();
      });
    });

    it('should refresh settings when 409 occurs', async () => {
      const { result } = renderHook(() => useSystemSettings());

      await waitFor(() => {
        expect(result.current?.settings).not.toBeNull();
      });

      let getCallCount = 0;

      server.use(
        http.patch('*/api/system-settings', () => {
          return HttpResponse.json(
            { message: 'Version conflict' },
            { status: 409 }
          );
        }),
        http.get('*/api/system-settings', () => {
          getCallCount++;
          return HttpResponse.json({
            data: {
              ...mockSystemSettings,
              version: getCallCount + 1,
            },
          });
        })
      );

      const initialGetCount = getCallCount;

      try {
        await act(async () => {
          await result.current.updateSettings({ ui: { allowUserThemeOverride: false } });
        });
      } catch {
        // Expected to throw
      }

      // Should have made an additional GET request to refresh
      expect(getCallCount).toBeGreaterThan(initialGetCount);
    });
  });

  describe('Loading States During Updates', () => {
    it('should not set isLoading during update', async () => {
      const { result } = renderHook(() => useSystemSettings());

      await waitFor(() => {
        expect(result.current?.settings).not.toBeNull();
      });

      await act(async () => {
        await result.current.updateSettings({ ui: { allowUserThemeOverride: false } });
      });

      // isLoading should only be true during initial fetch and refresh
      // isSaving should be true during updates
      expect(result.current.isLoading).toBe(false);
    });

    it('should clear isSaving state after update completes', async () => {
      const { result } = renderHook(() => useSystemSettings());

      await waitFor(() => {
        expect(result.current?.settings).not.toBeNull();
      });

      await act(async () => {
        await result.current.updateSettings({ ui: { allowUserThemeOverride: false } });
      });

      expect(result.current.isSaving).toBe(false);
    });

    it('should clear isSaving state even when update fails', async () => {
      const { result } = renderHook(() => useSystemSettings());

      await waitFor(() => {
        expect(result.current?.settings).not.toBeNull();
      });

      server.use(
        http.patch('*/api/system-settings', () => {
          return HttpResponse.json(
            { message: 'Update failed' },
            { status: 500 }
          );
        })
      );

      try {
        await act(async () => {
          await result.current.updateSettings({ ui: { allowUserThemeOverride: false } });
        });
      } catch {
        // Expected to throw
      }

      expect(result.current.isSaving).toBe(false);
    });
  });

  describe('Permission Error Handling (403)', () => {
    it('should handle 403 on update', async () => {
      const { result } = renderHook(() => useSystemSettings());

      await waitFor(() => {
        expect(result.current?.settings).not.toBeNull();
      });

      server.use(
        http.patch('*/api/system-settings', () => {
          return HttpResponse.json(
            { message: 'Forbidden' },
            { status: 403 }
          );
        })
      );

      // Should throw when permission is denied
      await expect(
        act(async () => {
          await result.current.updateSettings({ ui: { allowUserThemeOverride: false } });
        })
      ).rejects.toThrow();

      // isSaving should be false after error
      expect(result.current.isSaving).toBe(false);
    });

    it('should handle 403 on replace', async () => {
      const { result } = renderHook(() => useSystemSettings());

      await waitFor(() => {
        expect(result.current?.settings).not.toBeNull();
      });

      server.use(
        http.put('*/api/system-settings', () => {
          return HttpResponse.json(
            { message: 'Forbidden' },
            { status: 403 }
          );
        })
      );

      const newSettings = {
        ui: { allowUserThemeOverride: false },
        features: {},
      };

      // Should throw when permission is denied
      let thrownError: Error | null = null;
      await act(async () => {
        try {
          await result.current.replaceSettings(newSettings);
        } catch (err) {
          thrownError = err as Error;
        }
      });

      expect(thrownError).not.toBeNull();

      // isSaving should be false after error
      expect(result.current?.isSaving).toBe(false);
    });
  });

  describe('Concurrent Updates', () => {
    it('should handle multiple concurrent updates', async () => {
      const { result } = renderHook(() => useSystemSettings());

      await waitFor(() => {
        expect(result.current?.settings).not.toBeNull();
      });

      // Both updates should complete without errors
      await act(async () => {
        await Promise.all([
          result.current.updateSettings({ ui: { allowUserThemeOverride: false } }),
          result.current.updateSettings({ features: { testFeature: true } }),
        ]);
      });

      // Both should complete without errors
      expect(result.current.error).toBeNull();
    });
  });

  describe('Error Recovery', () => {
    it('should clear error after successful update', async () => {
      const { result } = renderHook(() => useSystemSettings());

      // Wait for successful initial load
      await waitFor(() => {
        expect(result.current?.settings).not.toBeNull();
      });

      // First, create an error by making a fetch fail
      server.use(
        http.get('*/api/system-settings', () => {
          return HttpResponse.json(
            { message: 'Server error' },
            { status: 500 }
          );
        })
      );

      // Refresh to trigger the error
      await act(async () => {
        await result.current.refresh();
      });

      // Should have an error now
      await waitFor(() => {
        expect(result.current?.error).not.toBeNull();
      });

      // Now restore handlers and do a successful update to clear the error
      server.resetHandlers();

      await act(async () => {
        await result.current.updateSettings({ ui: { allowUserThemeOverride: false } });
      });

      // Error should be cleared by the successful update
      expect(result.current.error).toBeNull();
    });
  });
});
