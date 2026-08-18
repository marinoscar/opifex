import { createTheme, ThemeOptions } from '@mui/material/styles';
import { lightPalette } from './light';
import { darkPalette } from './dark';
import { componentOverrides } from './components';

const baseTheme: ThemeOptions = {
  typography: {
    fontFamily: '"Inter", "Roboto", "Helvetica", "Arial", sans-serif',
    h1: { fontWeight: 600 },
    h2: { fontWeight: 600 },
    h3: { fontWeight: 600 },
    h4: { fontWeight: 600 },
    h5: { fontWeight: 600 },
    h6: { fontWeight: 600 },
  },
  shape: {
    borderRadius: 8,
  },
};

export const lightTheme = createTheme({
  ...baseTheme,
  palette: {
    mode: 'light',
    ...lightPalette,
  },
  components: componentOverrides('light'),
});

export const darkTheme = createTheme({
  ...baseTheme,
  palette: {
    mode: 'dark',
    ...darkPalette,
  },
  components: componentOverrides('dark'),
});

export type ThemeMode = 'light' | 'dark' | 'system';
