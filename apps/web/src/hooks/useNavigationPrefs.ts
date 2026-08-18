/**
 * `user_settings.navigation` — the navigation rail's collapse preference.
 *
 * Issue #55, epic #51. **No new endpoint and no new request pattern**: this
 * reads and writes the same `GET`/`PATCH /api/user-settings` the rest of the
 * app already uses, through the same `useUserSettings` hook, exactly like the
 * `dataTables` namespace. The server side already merges this namespace
 * field-wise, so only the changed field ever goes on the wire.
 *
 * TWO CONTRACTS THIS FILE EXISTS TO HOLD
 * --------------------------------------
 *
 * 1. **ABSENT MEANS DEFAULT, and a default is never written back.** An absent
 *    namespace or an absent field means "rail expanded". We do not PATCH that
 *    back on load: the API deliberately ships this namespace with no
 *    `.default()` anywhere so a later change to the defaults still reaches
 *    users who never touched navigation, and materialising today's default
 *    into their blob would silently opt them out of that forever. The read is
 *    `=== true`, never truthy, so absent is indistinguishable from an explicit
 *    `false` — both mean expanded.
 *
 * 2. **The toggle is optimistic.** Waiting a round trip to animate a 164px
 *    column is the kind of lag users read as a broken button. The overlay is
 *    cleared once the write settles, at which point `stored` either carries the
 *    new value (success) or still carries the old one (failure) — so the revert
 *    is the same code path as the commit, with no separate error branch to rot.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import { useUserSettings } from './useUserSettings';
import { useIsMounted } from './useIsMounted';

interface NavigationState {
  railCollapsed: boolean;
}

export interface UseNavigationPrefsResult {
  /** Desktop rail collapse preference. Absent ⇒ `false` ⇒ expanded. */
  railCollapsed: boolean;
  toggleRailCollapsed: () => void;
  /** True until the first settings read resolves; the rail renders defaults meanwhile. */
  isLoading: boolean;
}

export function useNavigationPrefs(): UseNavigationPrefsResult {
  // `syncTheme: false` — this hook is mounted by the ALWAYS-PRESENT navigation
  // rail, and it is here for the `navigation` namespace only. Left on, it would
  // quietly make the STORED theme authoritative on every page load and stamp
  // over the AppBar's local light/dark toggle on the next navigation. The
  // opt-out exists on `useUserSettings` for precisely this caller.
  const { settings, isLoading, updateSettings } = useUserSettings({ syncTheme: false });
  const isMounted = useIsMounted();

  // What the server currently says. Absent anywhere in the chain collapses to
  // the built-in default, and nothing is written back to make it explicit.
  const stored = useMemo<NavigationState>(
    () => ({
      railCollapsed: settings?.navigation?.railCollapsed === true,
    }),
    [settings],
  );

  const [overlay, setOverlay] = useState<NavigationState | null>(null);
  // Guards against a late write from a PREVIOUS click clearing a NEWER overlay:
  // two quick toggles race, and without the sequence check the first response to
  // land would drop the second click's optimistic state back to `stored`.
  const writeSeq = useRef(0);

  const effective = overlay ?? stored;

  const toggleRailCollapsed = useCallback(() => {
    // No settings yet means no `version` for the If-Match header, so
    // `updateSettings` would no-op. Skipping the overlay too keeps the UI
    // honest rather than showing a change that was never sent.
    if (!settings) return;

    const railCollapsed = !effective.railCollapsed;
    const seq = ++writeSeq.current;
    setOverlay({ railCollapsed });

    // Only the `navigation` namespace goes on the wire, and inside it only the
    // field that changed — PATCH merges field-wise, so a concurrent change to
    // another field is preserved rather than clobbered.
    void updateSettings({ navigation: { railCollapsed } })
      .catch(() => undefined)
      .finally(() => {
        if (!isMounted()) return;
        if (writeSeq.current !== seq) return;
        setOverlay(null);
      });
  }, [settings, effective, updateSettings, isMounted]);

  return {
    railCollapsed: effective.railCollapsed,
    toggleRailCollapsed,
    isLoading,
  };
}
