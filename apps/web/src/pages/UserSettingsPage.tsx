import {
  Container,
  Typography,
  Box,
  Alert,
  Snackbar,
} from '@mui/material';
import { useState } from 'react';
import { ThemeSettings } from '../components/settings/ThemeSettings';
import { ProfileSettings } from '../components/settings/ProfileSettings';
import { PersonalAccessTokens } from '../components/settings/PersonalAccessTokens';
import { useUserSettings } from '../hooks/useUserSettings';
import { LoadingSpinner } from '../components/common/LoadingSpinner';

export default function UserSettingsPage() {
  const {
    settings,
    isLoading,
    error,
    isSaving,
    updateTheme,
    updateProfile,
  } = useUserSettings();

  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const handleThemeChange = async (theme: 'light' | 'dark' | 'system') => {
    try {
      await updateTheme(theme);
      setSuccessMessage('Theme updated');
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Failed to update theme');
    }
  };

  const handleProfileSave = async (
    profile: NonNullable<typeof settings>['profile']
  ) => {
    try {
      await updateProfile(profile);
      setSuccessMessage('Profile updated');
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Failed to update profile');
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
