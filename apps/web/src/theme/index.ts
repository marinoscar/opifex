import { createTheme, ThemeOptions } from '@mui/material/styles';
import { lightPalette } from './light';
import { darkPalette } from './dark';
import { componentOverrides } from './components';
import { fontFamily, fontFamilyMono } from './tokens';

/**
 * Everything both themes share. Palette and component overrides are the only
 * mode-dependent parts, and the overrides now resolve the mode themselves
 * through MUI's style callback rather than taking it as an argument.
 */
const baseTheme: ThemeOptions = {
  typography: {
    fontFamily,
    /**
     * The mono stack, exposed on the theme so components can reach it as
     * `theme.typography.fontFamilyMono` instead of importing the token
     * directly. `Typography` does not know about this key, so it is used via
     * `sx`/`className="opifex-mono"` — see the `MuiCssBaseline` override.
     *
     * The module augmentation below is what makes it type-safe; without it
     * this key would be dropped by `ThemeOptions`.
     */
    fontFamilyMono,
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

declare module '@mui/material/styles' {
  interface TypographyVariants {
    fontFamilyMono: string;
  }
  interface TypographyVariantsOptions {
    fontFamilyMono?: string;
  }
}

export const lightTheme = createTheme({
  ...baseTheme,
  palette: {
    mode: 'light',
    ...lightPalette,
  },
  components: componentOverrides(),
});

export const darkTheme = createTheme({
  ...baseTheme,
  palette: {
    mode: 'dark',
    ...darkPalette,
  },
  components: componentOverrides(),
});

export type ThemeMode = 'light' | 'dark' | 'system';
