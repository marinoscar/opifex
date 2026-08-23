import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useNavigationPrefs } from '../../hooks/useNavigationPrefs';
import type { UserSettings, UserSettingsUpdate } from '../../types';

/**
 * The three contracts that make this hook worth its size, and that nothing
 * else in the app would notice breaking:
 *
 *  1. Absent means default, and a default is NEVER written back.
 *  2. The toggle is optimistic, and a late write from an earlier click cannot
 *     clear a newer overlay.
 *  3. No settings ⇒ no write AND no overlay, because without a `version` the
 *     PATCH would no-op and the UI would be showing a change never sent.
 */

vi.mock('../../hooks/useUserSettings', () => ({
  useUserSettings: vi.fn(),
}));

import { useUserSettings } from '../../hooks/useUserSettings';

const mockUseUserSettings = vi.mocked(useUserSettings);

function settingsWith(navigation?: UserSettings['navigation']): UserSettings {
  return {
    theme: 'system',
    profile: { useProviderImage: true },
    ...(navigation === undefined ? {} : { navigation }),
    updatedAt: new Date().toISOString(),
    version: 3,
  };
}

// Typed rather than a bare `vi.fn()`, so the payload assertions below are
// checked against the real `UserSettingsUpdate` shape instead of `any`.
let updateSettings: ReturnType<
  typeof vi.fn<(updates: UserSettingsUpdate) => Promise<void>>
>;

function mockSettings(settings: UserSettings | null, isLoading = false) {
  mockUseUserSettings.mockReturnValue({
    settings,
    isLoading,
    error: null,
    isSaving: false,
    updateSettings,
    updateTheme: vi.fn(),
    updateProfile: vi.fn(),
    refresh: vi.fn(),
  });
}

describe('useNavigationPrefs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateSettings = vi
      .fn<(updates: UserSettingsUpdate) => Promise<void>>()
      .mockResolvedValue(undefined);
  });

  describe('Reading — absent means default', () => {
    it('reports expanded when the whole namespace is absent', () => {
      mockSettings(settingsWith(undefined));

      const { result } = renderHook(() => useNavigationPrefs());

      expect(result.current.railCollapsed).toBe(false);
    });

    it('reports expanded when the field is absent from a present namespace', () => {
      mockSettings(settingsWith({}));

      const { result } = renderHook(() => useNavigationPrefs());

      expect(result.current.railCollapsed).toBe(false);
    });

    it('reports expanded when settings have not loaded yet', () => {
      mockSettings(null, true);

      const { result } = renderHook(() => useNavigationPrefs());

      expect(result.current.railCollapsed).toBe(false);
      expect(result.current.isLoading).toBe(true);
    });

    it('makes an explicit false indistinguishable from absent', () => {
      // The read is `=== true`, never truthy — so nothing downstream can tell
      // "the user chose expanded" from "the user never chose", which is exactly
      // what lets the default change later.
      mockSettings(settingsWith({ railCollapsed: false }));

      const { result } = renderHook(() => useNavigationPrefs());

      expect(result.current.railCollapsed).toBe(false);
    });

    it('honours an explicit true', () => {
      mockSettings(settingsWith({ railCollapsed: true }));

      const { result } = renderHook(() => useNavigationPrefs());

      expect(result.current.railCollapsed).toBe(true);
    });
  });

  describe('Never writes a default back', () => {
    it('sends nothing on mount when the namespace is absent', async () => {
      // Materialising today's default into the user's blob would silently opt
      // them out of every future change to that default.
      mockSettings(settingsWith(undefined));

      renderHook(() => useNavigationPrefs());

      await waitFor(() => expect(updateSettings).not.toHaveBeenCalled());
    });

    it('sends nothing on mount when settings are present and explicit', async () => {
      mockSettings(settingsWith({ railCollapsed: true }));

      renderHook(() => useNavigationPrefs());

      await waitFor(() => expect(updateSettings).not.toHaveBeenCalled());
    });
  });

  describe('Writing', () => {
    it('sends only the navigation namespace, and inside it only the changed field', async () => {
      // PATCH merges field-wise, so a narrow payload preserves a concurrent
      // change made from another tab rather than clobbering it.
      mockSettings(settingsWith({ railCollapsed: false }));

      const { result } = renderHook(() => useNavigationPrefs());
      act(() => result.current.toggleRailCollapsed());

      expect(updateSettings).toHaveBeenCalledWith({
        navigation: { railCollapsed: true },
      });
      expect(updateSettings).toHaveBeenCalledTimes(1);
    });

    it('toggles back off the stored value', async () => {
      mockSettings(settingsWith({ railCollapsed: true }));

      const { result } = renderHook(() => useNavigationPrefs());
      act(() => result.current.toggleRailCollapsed());

      expect(updateSettings).toHaveBeenCalledWith({
        navigation: { railCollapsed: false },
      });
    });

    it('applies the new value immediately, before the write resolves', () => {
      // Waiting a round trip to animate a 164px column reads as a broken button.
      let resolveWrite: () => void = () => {};
      updateSettings.mockReturnValue(
        new Promise<void>((res) => {
          resolveWrite = res;
        }),
      );
      mockSettings(settingsWith({ railCollapsed: false }));

      const { result } = renderHook(() => useNavigationPrefs());
      act(() => result.current.toggleRailCollapsed());

      expect(result.current.railCollapsed).toBe(true);
      act(() => resolveWrite());
    });

    it('falls back to the stored value when the write fails', async () => {
      // The revert is the same code path as the commit: clear the overlay and
      // let `stored` speak. There is no separate error branch to rot.
      updateSettings.mockRejectedValue(new Error('nope'));
      mockSettings(settingsWith({ railCollapsed: false }));

      const { result } = renderHook(() => useNavigationPrefs());
      await act(async () => {
        result.current.toggleRailCollapsed();
      });

      await waitFor(() => expect(result.current.railCollapsed).toBe(false));
    });

    it('does not let a late write from an earlier click clear a newer overlay', async () => {
      const resolvers: Array<() => void> = [];
      updateSettings.mockImplementation(
        () =>
          new Promise<void>((res) => {
            resolvers.push(res);
          }),
      );
      mockSettings(settingsWith({ railCollapsed: false }));

      const { result } = renderHook(() => useNavigationPrefs());

      act(() => result.current.toggleRailCollapsed()); // → true
      act(() => result.current.toggleRailCollapsed()); // → false (overlay)
      expect(result.current.railCollapsed).toBe(false);

      // The FIRST write settles last. Without the sequence guard it would clear
      // the second click's overlay and the rail would jump.
      await act(async () => {
        resolvers[0]();
      });

      expect(result.current.railCollapsed).toBe(false);
      expect(updateSettings).toHaveBeenLastCalledWith({
        navigation: { railCollapsed: false },
      });
    });
  });

  describe('No settings, no write', () => {
    it('sends nothing and shows nothing when settings have not loaded', () => {
      // Without a `version` there is no If-Match header, so `updateSettings`
      // would no-op. Skipping the overlay too keeps the UI honest rather than
      // animating a change that was never sent.
      mockSettings(null, true);

      const { result } = renderHook(() => useNavigationPrefs());
      act(() => result.current.toggleRailCollapsed());

      expect(updateSettings).not.toHaveBeenCalled();
      expect(result.current.railCollapsed).toBe(false);
    });
  });

  describe('Theme sync', () => {
    it('opts out of theme syncing', () => {
      // This hook is mounted by the always-present rail. Left on, syncing would
      // make the STORED theme authoritative on every page load and stamp over
      // the AppBar's light/dark toggle.
      mockSettings(settingsWith(undefined));

      renderHook(() => useNavigationPrefs());

      expect(mockUseUserSettings).toHaveBeenCalledWith({ syncTheme: false });
    });
  });
});
