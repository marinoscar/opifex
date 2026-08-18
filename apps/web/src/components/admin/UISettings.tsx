import {
  Box,
  Typography,
  Switch,
  FormControlLabel,
  Button,
} from '@mui/material';
import { useState, useEffect } from 'react';

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

  useEffect(() => {
    setAllowThemeOverride(settings.allowUserThemeOverride);
  }, [settings]);

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
