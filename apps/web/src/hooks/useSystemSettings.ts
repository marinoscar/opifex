import { useState, useEffect, useCallback } from 'react';
import { api, ApiError } from '../services/api';
import { SystemSettings } from '../types';
import { useIsMounted } from './useIsMounted';

interface UseSystemSettingsReturn {
  settings: SystemSettings | null;
  isLoading: boolean;
  error: string | null;
  isSaving: boolean;
  updateSettings: (updates: Partial<SystemSettings>) => Promise<void>;
  replaceSettings: (
    settings: Omit<SystemSettings, 'updatedAt' | 'updatedBy' | 'version'>,
  ) => Promise<void>;
  refresh: () => Promise<void>;
}

export function useSystemSettings(): UseSystemSettingsReturn {
  const [settings, setSettings] = useState<SystemSettings | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  // Every `setState` past an `await` is guarded: a request that settles after
  // the component is gone must not schedule an update on it. Only the state
  // write is skipped — what these functions return or throw is unchanged.
  const isMounted = useIsMounted();

  const fetchSettings = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const data = await api.get<SystemSettings>('/system-settings');
      if (isMounted()) setSettings(data);
    } catch (err) {
      if (isMounted()) {
        if (err instanceof ApiError && err.status === 403) {
          setError('You do not have permission to view system settings');
        } else {
          const message =
            err instanceof ApiError ? err.message : 'Failed to load settings';
          setError(message);
        }
      }
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted]);

  // Load on mount. `fetchSettings` flips `isLoading` and clears `error` before
  // its first `await`, which the rule reads as a synchronous setState in an
  // effect. On mount both writes are no-ops — `isLoading` already starts
  // `true` and `error` already `null` — so there is no cascading render to
  // remove, while deferring them past the await would delay the spinner on
  // every manual refetch instead. The fix this rule really wants is a
  // fetch-on-render data layer, which is not something a hook can adopt alone.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount, see above
    fetchSettings();
  }, [fetchSettings]);

  const updateSettings = useCallback(
    async (updates: Partial<SystemSettings>) => {
      if (!settings) return;

      try {
        setIsSaving(true);
        setError(null);

        const data = await api.patch<SystemSettings>(
          '/system-settings',
          updates,
          {
            headers: {
              'If-Match': settings.version.toString(),
            },
          },
        );

        if (isMounted()) setSettings(data);
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          await fetchSettings();
          throw new Error(
            'Settings were updated elsewhere. Please review and try again.',
          );
        }
        const message =
          err instanceof ApiError ? err.message : 'Failed to save settings';
        if (isMounted()) setError(message);
        throw err;
      } finally {
        if (isMounted()) setIsSaving(false);
      }
    },
    [settings, fetchSettings, isMounted],
  );

  const replaceSettings = useCallback(
    async (
      newSettings: Omit<SystemSettings, 'updatedAt' | 'updatedBy' | 'version'>,
    ) => {
      try {
        setIsSaving(true);
        setError(null);

        const data = await api.put<SystemSettings>(
          '/system-settings',
          newSettings,
        );
        if (isMounted()) setSettings(data);
      } catch (err) {
        const message =
          err instanceof ApiError ? err.message : 'Failed to save settings';
        if (isMounted()) setError(message);
        throw err;
      } finally {
        if (isMounted()) setIsSaving(false);
      }
    },
    [isMounted],
  );

  return {
    settings,
    isLoading,
    error,
    isSaving,
    updateSettings,
    replaceSettings,
    refresh: fetchSettings,
  };
}
