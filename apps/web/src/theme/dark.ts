/**
 * The dark palette, built entirely from `tokens.ts`. See `light.ts` for the
 * reasoning that applies to both files; only the dark-specific notes are here.
 *
 * The surfaces move from the old `#121212`/`#1e1e1e` pure greys to the cool
 * neutral ramp (`neutral[900]` page, `neutral[800]` card). A status-dense
 * screen needs a background with a slight hue so that the six status hues read
 * as deliberate rather than as tint on a dead grey; the step between page and
 * card also does more work in dark mode than any shadow can (see
 * `tokens.elevation`).
 */

import { PaletteOptions } from '@mui/material/styles';
import { brand, brandSecondary, statusTokens, surface, text } from './tokens';

export const darkPalette: PaletteOptions = {
  primary: {
    main: brand.dark.accent,
    light: brand.dark.accentHover,
    contrastText: brand.dark.onAccent,
  },
  secondary: {
    main: brandSecondary.dark.main,
    contrastText: brandSecondary.dark.contrastText,
  },
  error: { main: statusTokens.dark.failed.fg },
  warning: { main: statusTokens.dark.stalled.fg },
  info: { main: statusTokens.dark.running.fg },
  success: { main: statusTokens.dark.succeeded.fg },
  background: {
    default: surface.dark.default,
    paper: surface.dark.paper,
  },
  text: {
    primary: text.dark.primary,
    secondary: text.dark.secondary,
    disabled: text.dark.disabled,
  },
  divider: surface.dark.divider,
};
