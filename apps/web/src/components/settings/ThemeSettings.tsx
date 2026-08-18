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
          Choose how the application looks to you
        </Typography>

        <ToggleButtonGroup
          value={currentTheme}
          exclusive
          onChange={handleChange}
          aria-label="theme selection"
          disabled={disabled}
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
