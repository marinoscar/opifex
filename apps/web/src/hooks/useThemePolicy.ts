/**
 * Whether this deployment lets a user choose their own theme (#79).
 *
 * ## Why the flag arrives on `/auth/me`
 *
 * `system_settings.ui.allowUserThemeOverride` has existed server-side and had
 * an admin UI since before this hook — and **nothing honoured it**. An
 * administrator could turn it off and every user kept their toggle: a setting
 * that appears to do something and does nothing.
 *
 * It could not simply be fetched, either. `GET /api/system-settings` requires
 * `system_settings:read` and 403s for non-admins — exactly the population the
 * flag constrains — so reading it from always-mounted chrome would guarantee a
 * 403 on every page load for every Viewer. It rides on `/auth/me` instead,
 * which every user already fetches and which already carries `permissions`.
 *
 * ## Defaults to allowed
 *
 * A user whose `/auth/me` has not landed yet, or an older API that does not
 * send the field, gets `true`. The failure mode of guessing wrong in this
 * direction is a toggle that briefly appears and then vanishes; guessing the
 * other way hides a control from everyone whenever the API is slow.
 */

import { useAuth } from '../contexts/AuthContext';

export interface ThemePolicy {
  /** False only when an administrator has pinned the theme for everyone. */
  canOverrideTheme: boolean;
}

export function useThemePolicy(): ThemePolicy {
  const { user } = useAuth();

  return {
    canOverrideTheme: user?.allowUserThemeOverride ?? true,
  };
}
