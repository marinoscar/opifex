import {
  Card,
  CardContent,
  Typography,
  ToggleButtonGroup,
  ToggleButton,
  Box,
} from '@mui/material';
import {
  LightMode as LightIcon,
  DarkMode as DarkIcon,
  SettingsBrightness as SystemIcon,
} from '@mui/icons-material';
import { useThemePolicy } from '../../hooks/useThemePolicy';

interface ThemeSettingsProps {
  currentTheme: 'light' | 'dark' | 'system';
  onThemeChange: (theme: 'light' | 'dark' | 'system') => void;
  disabled?: boolean;
}

export function ThemeSettings({
  currentTheme,
  onThemeChange,
  disabled = false,
}: ThemeSettingsProps) {
  // On the settings page the control is DISABLED rather than hidden, unlike
  // the AppBar toggle (#79). The difference is that this page is a list of
  // settings a user came looking for: a missing row reads as "this app has no
  // theme setting", while a disabled one with a reason reads as "an
  // administrator decided this", which is the true statement.
  const { canOverrideTheme } = useThemePolicy();
  const locked = disabled || !canOverrideTheme;
  const handleChange = (
    _event: React.MouseEvent<HTMLElement>,
    newTheme: 'light' | 'dark' | 'system' | null,
  ) => {
    if (newTheme !== null) {
      onThemeChange(newTheme);
    }
  };

  return (
    <Card id="theme">
      <CardContent>
        <Typography variant="h6" gutterBottom>
          Appearance
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {canOverrideTheme
            ? 'Choose how the application looks to you'
            : 'Your administrator has set a fixed theme for this deployment.'}
        </Typography>

        <ToggleButtonGroup
          value={currentTheme}
          exclusive
          onChange={handleChange}
          aria-label="theme selection"
          disabled={locked}
          sx={{ mt: 1 }}
        >
          <ToggleButton value="light" aria-label="light mode">
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1 }}>
              <LightIcon />
              <span>Light</span>
            </Box>
          </ToggleButton>
          <ToggleButton value="dark" aria-label="dark mode">
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1 }}>
              <DarkIcon />
              <span>Dark</span>
            </Box>
          </ToggleButton>
          <ToggleButton value="system" aria-label="system preference">
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1 }}>
              <SystemIcon />
              <span>System</span>
            </Box>
          </ToggleButton>
        </ToggleButtonGroup>
      </CardContent>
    </Card>
  );
}
