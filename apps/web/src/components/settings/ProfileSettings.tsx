import { useState, useEffect } from 'react';
import {
  Card,
  CardContent,
  Typography,
  TextField,
  Button,
  Box,
  Switch,
  FormControlLabel,
  Avatar,
  Stack,
} from '@mui/material';
import { useAuth } from '../../contexts/AuthContext';
import { ImageUpload } from './ImageUpload';

interface ProfileSettingsProps {
  profile: {
    displayName?: string;
    useProviderImage: boolean;
    customImageUrl?: string | null;
  };
  onSave: (profile: ProfileSettingsProps['profile']) => Promise<void>;
  disabled?: boolean;
}

export function ProfileSettings({
  profile,
  onSave,
  disabled = false,
}: ProfileSettingsProps) {
  const { user, refreshUser } = useAuth();
  const [displayName, setDisplayName] = useState(profile.displayName || '');
  const [useProviderImage, setUseProviderImage] = useState(profile.useProviderImage);
  const [customImageUrl, setCustomImageUrl] = useState(profile.customImageUrl || '');
  const [hasChanges, setHasChanges] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // Reset form when profile changes
  useEffect(() => {
    setDisplayName(profile.displayName || '');
    setUseProviderImage(profile.useProviderImage);
    setCustomImageUrl(profile.customImageUrl || '');
    setHasChanges(false);
  }, [profile]);

  // Track changes
  useEffect(() => {
    const changed =
      displayName !== (profile.displayName || '') ||
      useProviderImage !== profile.useProviderImage ||
      customImageUrl !== (profile.customImageUrl || '');
    setHasChanges(changed);
  }, [displayName, useProviderImage, customImageUrl, profile]);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await onSave({
        displayName: displayName || undefined,
        useProviderImage,
        customImageUrl: customImageUrl || null,
      });
      // Refresh user to get updated profile
      await refreshUser();
    } finally {
      setIsSaving(false);
    }
  };

  const handleImageUpload = (url: string) => {
    setCustomImageUrl(url);
    setUseProviderImage(false);
  };

  const currentImageUrl = useProviderImage
    ? user?.profileImageUrl
    : customImageUrl || user?.profileImageUrl;

  return (
    <Card>
      <CardContent>
        <Typography variant="h6" gutterBottom>
          Profile
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Customize how you appear to others
        </Typography>

        <Stack spacing={3}>
          {/* Profile Image */}
          <Box>
            <Typography variant="subtitle2" gutterBottom>
              Profile Image
            </Typography>
            <Stack direction="row" spacing={3} sx={{ alignItems: 'center' }}>
              <Avatar
                src={currentImageUrl || undefined}
                alt={user?.displayName || user?.email}
                sx={{ width: 80, height: 80 }}
              />
              <Box sx={{ flexGrow: 1 }}>
                <FormControlLabel
                  control={
                    <Switch
                      checked={useProviderImage}
                      onChange={(e) => setUseProviderImage(e.target.checked)}
                      disabled={disabled}
                    />
                  }
                  label="Use Google profile image"
                />
                {!useProviderImage && (
                  <ImageUpload
                    onUpload={handleImageUpload}
                    disabled={disabled || isSaving}
                  />
                )}
              </Box>
            </Stack>
          </Box>

          {/* Display Name */}
          <TextField
            label="Display Name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder={user?.email?.split('@')[0]}
            helperText="Leave empty to use your Google name"
            disabled={disabled}
            fullWidth
          />

          {/* Email (read-only) */}
          <TextField
            label="Email"
            value={user?.email || ''}
            disabled
            fullWidth
            helperText="Email cannot be changed"
          />

          {/* Save Button */}
          <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button
              variant="contained"
              onClick={handleSave}
              disabled={disabled || !hasChanges || isSaving}
            >
              {isSaving ? 'Saving...' : 'Save Changes'}
            </Button>
          </Box>
        </Stack>
      </CardContent>
    </Card>
  );
}
