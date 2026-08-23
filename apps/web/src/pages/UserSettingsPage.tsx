/**
 * `/settings` — the signed-in user's own preferences.
 *
 * Two changes landed here with the cockpit rewrite (epic #19, issues #75/#78):
 *
 *  1. **The identity header.** `UserProfileCard` used to sit on the old home
 *     page, where it competed with cockpit content; this page — the one page
 *     that is entirely about the current user — had no indication of WHOSE
 *     settings were being edited. The component moved here unchanged, minus
 *     its "Account Settings" button, which would have pointed at this page.
 *  2. **`/settings#theme` works.** See `hooks/useHashScroll.ts` for why it did
 *     not: the anchor always existed, but react-router does no hash scrolling
 *     and this page returns a spinner until settings resolve, so the target is
 *     not in the DOM when the navigation happens. Hence `ready` — the hook must
 *     fire on the render where the theme card actually exists, not on mount.
 */

import { Container, Typography, Box, Alert, Snackbar } from '@mui/material';
import { useState } from 'react';
import { UserProfileCard } from '../components/user/UserProfileCard';
import { ThemeSettings } from '../components/settings/ThemeSettings';
import { ProfileSettings } from '../components/settings/ProfileSettings';
import { PersonalAccessTokens } from '../components/settings/PersonalAccessTokens';
import { NotificationSettings } from '../components/settings/NotificationSettings';
import { useUserSettings } from '../hooks/useUserSettings';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { useHashScroll } from '../hooks/useHashScroll';

export default function UserSettingsPage() {
  const { settings, isLoading, error, isSaving, updateTheme, updateProfile } =
    useUserSettings();

  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  // Called unconditionally, ABOVE the `isLoading` early return below — hooks
  // cannot live after a conditional return, and this one specifically needs to
  // observe the transition INTO the ready state, which is the render the early
  // return stops happening on.
  useHashScroll(!isLoading && !!settings);

  const handleThemeChange = async (theme: 'light' | 'dark' | 'system') => {
    try {
      await updateTheme(theme);
      setSuccessMessage('Theme updated');
    } catch (err) {
      setLocalError(
        err instanceof Error ? err.message : 'Failed to update theme',
      );
    }
  };

  const handleProfileSave = async (
    profile: NonNullable<typeof settings>['profile'],
  ) => {
    try {
      await updateProfile(profile);
      setSuccessMessage('Profile updated');
    } catch (err) {
      setLocalError(
        err instanceof Error ? err.message : 'Failed to update profile',
      );
    }
  };

  if (isLoading) {
    return <LoadingSpinner />;
  }

  return (
    <Container maxWidth="md">
      <Box sx={{ py: 4 }}>
        <Typography variant="h4" component="h1" gutterBottom>
          Settings
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 2 }}>
          Manage your account preferences
        </Typography>

        {error && (
          <Alert severity="error" sx={{ mb: 3 }}>
            {error}
          </Alert>
        )}

        {/* Identity first: whose settings these are, before what they are.
            The card renders nothing when there is no user, so it needs no
            guard of its own here. */}
        <Box sx={{ mb: 3 }}>
          <UserProfileCard showSettingsAction={false} />
        </Box>

        {settings && (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {/* Theme Settings */}
            <ThemeSettings
              currentTheme={settings.theme}
              onThemeChange={handleThemeChange}
              disabled={isSaving}
            />

            {/* Profile Settings */}
            <ProfileSettings
              profile={settings.profile}
              onSave={handleProfileSave}
              disabled={isSaving}
            />

            {/* Phone notifications (#58) — where escalations reach the
                operator. Placed ABOVE tokens deliberately: this is the one
                setting on the page whose absence makes the rest of the system
                quietly useless. */}
            <NotificationSettings />

            {/* Personal Access Tokens */}
            <PersonalAccessTokens />
          </Box>
        )}

        {/* Success Snackbar */}
        <Snackbar
          open={!!successMessage}
          autoHideDuration={3000}
          onClose={() => setSuccessMessage(null)}
          message={successMessage}
        />

        {/* Error Snackbar */}
        <Snackbar
          open={!!localError}
          autoHideDuration={5000}
          onClose={() => setLocalError(null)}
        >
          <Alert severity="error" onClose={() => setLocalError(null)}>
            {localError}
          </Alert>
        </Snackbar>
      </Box>
    </Container>
  );
}
