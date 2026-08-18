import { useState, useEffect } from 'react';
import {
  Box,
  Typography,
  TextField,
  Button,
  Alert,
} from '@mui/material';
import { SystemSettings } from '../../types';

interface SystemSettingsEditorProps {
  settings: SystemSettings;
  onSave: (updates: Partial<SystemSettings>) => Promise<void>;
  disabled?: boolean;
}

export function SystemSettingsEditor({
  settings,
  onSave,
  disabled,
}: SystemSettingsEditorProps) {
  const editableSettings = {
    ui: settings.ui,
    features: settings.features,
  };

  const [jsonValue, setJsonValue] = useState(
    JSON.stringify(editableSettings, null, 2),
  );
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    setJsonValue(JSON.stringify(editableSettings, null, 2));
  }, [settings]);

  const validateJson = (): Record<string, unknown> | null => {
    try {
      const parsed = JSON.parse(jsonValue);

      // Basic structure validation
      if (typeof parsed !== 'object' || parsed === null) {
        throw new Error('Settings must be an object');
      }

      if (parsed.ui && typeof parsed.ui.allowUserThemeOverride !== 'boolean') {
        throw new Error('ui.allowUserThemeOverride must be a boolean');
      }

      setError(null);
      return parsed;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid JSON');
      return null;
    }
  };

  const handleSave = async () => {
    const parsed = validateJson();
    if (!parsed) return;

    setIsSaving(true);
    try {
      await onSave(parsed as Partial<SystemSettings>);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setIsSaving(false);
    }
  };

  const hasChanges = jsonValue !== JSON.stringify(editableSettings, null, 2);

  return (
    <Box>
      <Typography variant="h6" gutterBottom>
        Advanced JSON Editor
      </Typography>

      <Alert severity="info" sx={{ mb: 2 }}>
        Edit the raw JSON settings. Be careful - invalid values may cause issues.
      </Alert>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      <TextField
        multiline
        fullWidth
        minRows={15}
        maxRows={30}
        value={jsonValue}
        onChange={(e) => setJsonValue(e.target.value)}
        disabled={disabled}
        sx={{
          fontFamily: 'monospace',
          '& .MuiInputBase-input': {
            fontFamily: 'monospace',
            fontSize: '0.875rem',
          },
        }}
      />

      <Box sx={{ mt: 2 }}>
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
