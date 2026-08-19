/**
 * The light palette, built entirely from `tokens.ts`.
 *
 * Nothing here is a literal. Every value is a token lookup so that the palette
 * and the component overrides cannot disagree — the bug this replaces was an
 * AppBar border of `#e0e0e0` hardcoded in `components.ts` while the divider
 * said something else.
 *
 * The semantic MUI channels (`error`, `warning`, `info`, `success`) are pinned
 * to the STATUS tokens rather than left at MUI's defaults. That is the
 * hue-allocation rule applied one level up: an `<Alert severity="error">` and
 * a failed run are the same claim, and painting them in two different reds is
 * how a status vocabulary stops being a vocabulary. It also means the
 * destructive DataTable actions inherit the `failed` red for free.
 *
 * `light`/`dark`/`contrastText` are deliberately left for MUI to compute from
 * `main` — hand-writing them is how the two ends of a channel drift.
 */

import { PaletteOptions } from '@mui/material/styles';
import { brand, brandSecondary, statusTokens, surface, text } from './tokens';

export const lightPalette: PaletteOptions = {
  primary: {
    main: brand.light.accent,
    dark: brand.light.accentHover,
    contrastText: brand.light.onAccent,
  },
  secondary: {
    main: brandSecondary.light.main,
    contrastText: brandSecondary.light.contrastText,
  },
  error: { main: statusTokens.light.failed.fg },
  warning: { main: statusTokens.light.stalled.fg },
  info: { main: statusTokens.light.running.fg },
  success: { main: statusTokens.light.succeeded.fg },
  background: {
    default: surface.light.default,
    paper: surface.light.paper,
  },
  text: {
    primary: text.light.primary,
    secondary: text.light.secondary,
    disabled: text.light.disabled,
  },
  divider: surface.light.divider,
};
