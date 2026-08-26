/**
 * The Control Center's operator-settings read and write (#348, epic #332).
 *
 * ## One document, re-read rather than patched in place
 *
 * `PATCH /api/operator-settings` returns the registry re-resolved after the
 * write, so a successful save replaces the document wholesale. Nothing here
 * merges the request into the previous response: what a key resolves to after
 * a write is the API's answer to compute — clearing `github.userAgent` reveals
 * whatever `GITHUB_USER_AGENT` says, which this hook has no way to know — and
 * an optimistic merge would show a value that was never in force.
 *
 * ## The 409 is not an error to display, it is a re-read
 *
 * `useSystemSettings` already establishes the handling and this follows it:
 * refetch, then throw a message telling the operator their read went stale.
 * The refetch is what makes the retry meaningful, since the `If-Match` they
 * would send again is the one that was just rejected.
 *
 * ## The caller computes the diff
 *
 * `save` takes the sparse map and sends exactly it. That the map is sparse is
 * a property of `SettingsSection`'s draft comparison, asserted in its own
 * tests — but this hook refuses an empty one rather than sending a body the
 * API would reject, since an empty patch is always a form submitting nothing.
 */

import { useCallback, useEffect, useState } from 'react';

import {
  ApiError,
  getOperatorSettings,
  patchOperatorSettings,
} from '../services/api';
import type {
  OperatorSettingsDocument,
  OperatorSettingsPatch,
} from '../types/operatorSettings';
import { useIsMounted } from './useIsMounted';

export interface UseOperatorSettingsResult {
  document: OperatorSettingsDocument | null;
  isLoading: boolean;
  error: string | null;
  isSaving: boolean;
  /** Sends the given keys and nothing else. Rejects to the caller. */
  save: (changes: OperatorSettingsPatch) => Promise<void>;
  refresh: () => Promise<void>;
}

export function useOperatorSettings(): UseOperatorSettingsResult {
  // Named `settings` rather than `document` so nothing in this module can
  // shadow the DOM global by accident.
  const [settings, setSettings] = useState<OperatorSettingsDocument | null>(
    null,
  );
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  // Every `setState` past an `await` is guarded — a request settling after the
  // section is gone must not schedule an update on it.
  const isMounted = useIsMounted();

  const fetchSettings = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const data = await getOperatorSettings();
      if (isMounted()) setSettings(data);
    } catch (err) {
      if (isMounted()) setError(readFailureMessage(err));
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted]);

  // Load on mount. Both writes before the first `await` are no-ops on mount —
  // `isLoading` starts true and `error` starts null — so the rule's cascading
  // render does not exist here, while deferring them would delay the spinner
  // on every manual refetch instead. Same reasoning as `useSystemSettings`.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount, see above
    fetchSettings();
  }, [fetchSettings]);

  const save = useCallback(
    async (changes: OperatorSettingsPatch) => {
      if (Object.keys(changes).length === 0) return;

      try {
        setIsSaving(true);
        setError(null);

        const data = await patchOperatorSettings(
          changes,
          settings?.revision ?? null,
        );
        if (isMounted()) setSettings(data);
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          await fetchSettings();
          throw new Error(
            'These settings changed since this page read them, so nothing ' +
              'was written. The values below have been re-read — review them ' +
              'and re-apply your change.',
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

  return {
    document: settings,
    isLoading,
    error,
    isSaving,
    save,
    refresh: fetchSettings,
  };
}

/**
 * Why the read failed, in the operator's terms.
 *
 * A 403 is called out because it is the one failure that is not a fault: an
 * account with `system_settings:read` reaches this screen, and the API is
 * entitled to refuse anyway. Everything else carries the API's own message,
 * which for this endpoint is written for a human already.
 */
function readFailureMessage(err: unknown): string {
  if (err instanceof ApiError && err.status === 403) {
    return 'This account may not read operator settings.';
  }
  return err instanceof ApiError ? err.message : 'Failed to load settings';
}
