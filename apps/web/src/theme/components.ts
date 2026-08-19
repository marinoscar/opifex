/**
 * Component-level theme overrides.
 *
 * Epic #19. Two things changed here beyond the new entries:
 *
 *  1. **The `mode` parameter is gone.** Every override that needed to know the
 *     mode now takes MUI's `({ theme })` style callback and reads the palette,
 *     so the overrides cannot go out of sync with the palette the way the
 *     AppBar border did — it was a literal `#e0e0e0` / `#333333` chosen by a
 *     ternary on `mode`, matching neither palette's `divider`. It is now
 *     `theme.palette.divider`.
 *  2. **The box-shadow literals moved to `tokens.elevation`.** They were the
 *     only place in the app where a shadow was spelled out.
 *
 * `componentOverrides` is called once per theme in `index.ts`. It takes no
 * arguments; anything mode-dependent belongs in a callback, not in a branch.
 */

import { Components, Theme, alpha } from '@mui/material/styles';
import { elevation, fontFamilyMono } from './tokens';

export const componentOverrides = (): Components<Theme> => ({
  MuiCssBaseline: {
    styleOverrides: {
      body: {
        // Inter is a fairly high-contrast face; without smoothing hints it
        // renders noticeably heavier on macOS than the Roboto it replaces.
        WebkitFontSmoothing: 'antialiased',
        MozOsxFontSmoothing: 'grayscale',
      },
      /**
       * THE reason Inter is self-hosted (see `tokens.fontFamily`).
       *
       * Apply `className="opifex-num"` to every number that is refreshed in
       * place: metric tiles, durations, costs, token counts, queue depths.
       * With proportional figures a polled value visibly reflows its own
       * column on each tick — the cockpit's stat row would twitch every few
       * seconds, which reads as instability in the system being watched
       * rather than in the typography.
       *
       * `font-feature-settings` is the fallback for engines that do not
       * implement `font-variant-numeric` against a variable font.
       */
      '.opifex-num': {
        fontVariantNumeric: 'tabular-nums',
        fontFeatureSettings: '"tnum" 1',
      },
      /** Work-order ids, commit SHAs, run ids, URLs on the 404 page. */
      '.opifex-mono': {
        fontFamily: fontFamilyMono,
        fontVariantNumeric: 'tabular-nums',
      },
    },
  },

  MuiButton: {
    styleOverrides: {
      root: {
        textTransform: 'none',
        fontWeight: 500,
      },
    },
  },

  MuiCard: {
    styleOverrides: {
      root: ({ theme }) => ({
        boxShadow: elevation[theme.palette.mode].card,
        // Cards carry a hairline in addition to the shadow. In dark mode the
        // shadow alone cannot separate a card from the page (there is no
        // luminance left below the background), so the border is what actually
        // draws the edge there.
        border: `1px solid ${theme.palette.divider}`,
        backgroundImage: 'none',
      }),
    },
  },

  MuiAppBar: {
    styleOverrides: {
      root: ({ theme }) => ({
        boxShadow: 'none',
        // Was `1px solid ${mode === 'light' ? '#e0e0e0' : '#333333'}` — two
        // literals that tracked neither palette.
        borderBottom: `1px solid ${theme.palette.divider}`,
        backgroundImage: 'none',
      }),
    },
  },

  /**
   * Chip metrics tuned for `StatusChip`, which is the app's densest use of the
   * component: it appears once per row in the runs and queue tables.
   *
   * `borderRadius` is deliberately NOT the full pill MUI ships. A status chip
   * is a label, not an action, and a squarer corner keeps it from reading as a
   * button in a row that also contains buttons.
   */
  MuiChip: {
    styleOverrides: {
      root: ({ theme }) => ({
        borderRadius: 6,
        fontWeight: 500,
        // The icon inherits the chip's `color`, which is how the icon + label
        // + color triple stays a single decision at the call site.
        '& .MuiChip-icon': {
          marginLeft: theme.spacing(0.75),
          marginRight: theme.spacing(-0.25),
          color: 'inherit',
        },
      }),
      sizeSmall: {
        height: 22,
        fontSize: '0.75rem',
      },
      label: ({ theme }) => ({
        paddingLeft: theme.spacing(1),
        paddingRight: theme.spacing(1),
      }),
    },
  },

  /**
   * A single focus-visible ring for every navigation row.
   *
   * This was hand-rolled twice inside `NavigationRail.tsx` (the destination
   * rows and the collapse toggle), each with its own copy of the same two
   * declarations. Stating it here means a keyboard user cannot lose the ring
   * because one call site was missed — and both of the rail's local copies are
   * now deleted (issue #71).
   *
   * `outlineOffset: -2` keeps the ring INSIDE the row. A positive offset
   * overflows the 56px collapsed rail and gets clipped.
   */
  MuiListItemButton: {
    styleOverrides: {
      root: ({ theme }) => ({
        '&.Mui-focusVisible': {
          outline: `2px solid ${theme.palette.primary.main}`,
          outlineOffset: -2,
        },
        '&.Mui-selected': {
          backgroundColor: alpha(theme.palette.primary.main, 0.12),
          '&:hover': {
            backgroundColor: alpha(theme.palette.primary.main, 0.16),
          },
        },
      }),
    },
  },

  /**
   * The same ring for icon-only controls, because the rail's collapse toggle
   * is an `IconButton` rather than a `ListItemButton` and carried the SECOND
   * hand-rolled copy. Deleting that copy without stating the rule here would
   * have traded a duplicated ring for a missing one — and an icon-only button
   * is precisely where a keyboard user has the least context to recover from
   * losing track of focus.
   *
   * The offset is positive here: an `IconButton` is a circle with its own
   * padding, so an inset ring would cut across the glyph.
   */
  MuiIconButton: {
    styleOverrides: {
      root: ({ theme }) => ({
        '&.Mui-focusVisible': {
          outline: `2px solid ${theme.palette.primary.main}`,
          outlineOffset: 2,
        },
      }),
    },
  },
});
