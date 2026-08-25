import {
  Box,
  Typography,
  Switch,
  FormControlLabel,
  Button,
} from '@mui/material';
import { useState } from 'react';

interface UISettingsProps {
  settings: {
    allowUserThemeOverride: boolean;
  };
  onSave: (settings: UISettingsProps['settings']) => Promise<void>;
  disabled?: boolean;
}

export function UISettings({ settings, onSave, disabled }: UISettingsProps) {
  const [allowThemeOverride, setAllowThemeOverride] = useState(
    settings.allowUserThemeOverride,
  );
  const [isSaving, setIsSaving] = useState(false);

  // Re-seed the draft when a fresh `settings` object arrives (a save landing,
  // a refetch). Adjusted during render rather than in an effect: React
  // re-renders with the new draft before committing, so the switch never
  // paints the stale position for a frame, and there is no second commit.
  // See "You might not need an Effect" — react-hooks/set-state-in-effect.
  const [seededFrom, setSeededFrom] = useState(settings);
  if (settings !== seededFrom) {
    setSeededFrom(settings);
    setAllowThemeOverride(settings.allowUserThemeOverride);
  }

  const hasChanges = allowThemeOverride !== settings.allowUserThemeOverride;

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await onSave({ allowUserThemeOverride: allowThemeOverride });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Box>
      <Typography variant="h6" gutterBottom>
        User Interface
      </Typography>

      <FormControlLabel
        control={
          <Switch
            checked={allowThemeOverride}
            onChange={(e) => setAllowThemeOverride(e.target.checked)}
            disabled={disabled}
          />
        }
        label="Allow users to override system theme"
      />
      <Typography variant="body2" color="text.secondary" sx={{ ml: 4, mb: 2 }}>
        When disabled, all users will use the system-defined theme
      </Typography>

      <Box sx={{ mt: 3 }}>
        <Button
          variant="contained"
          onClick={handleSave}
          disabled={disabled || !hasChanges || isSaving}
        >
          {isSaving ? 'Saving...' : 'Save Changes'}
        </Button>
      </Box>
    </Box>
  );
}
