/**
 * Component tests — DataTable color contrast, computed against the REAL
 * theme (issue #257).
 *
 * `axe-core`'s `color-contrast` rule is disabled in the conformance suite's
 * axe pass (`conformance/runDataTableConformanceSuite.tsx` documents why:
 * jsdom performs no real layout/paint, so the rule cannot resolve an
 * element's true effective background and is a well-known false-negative
 * trap there). This file is the real substitute: a pure WCAG 2.1
 * relative-luminance / contrast-ratio calculator
 * (`testUtils/contrast.ts`) run directly against the actual
 * `lightTheme` / `darkTheme` palette values the app ships
 * (`../../../theme/light.ts`, `dark.ts`) for the specific foreground/
 * background pairs THIS component paints — not a generic "is the theme
 * accessible" audit.
 *
 * ## Every ratio here is re-pinned against THIS repo's palette
 *
 * The measured ratios in the comments below were computed from
 * `theme/light.ts` / `theme/dark.ts` as they stand, NOT carried over from the
 * upstream palette this suite was ported from. They are recorded so that a
 * future palette change shows up as a diff in intent, not just as a pass/fail
 * flip.
 *
 * **Re-measured for the epic #19 cockpit palette.** Both palettes are now
 * assembled from `theme/tokens.ts` (brand indigo, a cool-neutral surface ramp,
 * and the semantic channels pinned to the run-status vocabulary), so every
 * ratio below moved. The headroom improved across the board — the old light
 * `primary.main` (#1976d2 on white) cleared AA normal text by 0.10, the indigo
 * that replaced it clears it by 3.40 — but the numbers are re-pinned rather
 * than dropped, because the point of recording them is to notice the NEXT
 * move, not to celebrate this one.
 *
 * The palette-wide properties (every STATUS color against every surface,
 * luminance separation between confusable statuses, brand-versus-status
 * collision) are asserted in `src/__tests__/theme/tokens.test.ts`. This file
 * stays scoped to the pairs the DataTable itself paints.
 *
 * ## Translucent FOREGROUNDS must be composited too
 *
 * This palette states its text colors as `rgba()` with alpha
 * (`text.primary` is `rgba(0, 0, 0, 0.87)`, `text.secondary` is
 * `rgba(0, 0, 0, 0.6)`, and the dark secondary tier is
 * `rgba(247, 248, 250, 0.7)`), where the upstream palette used opaque hex. That
 * difference is load-bearing here: `contrastRatio()` only composites a
 * translucent color when it is given the opaque surface behind it, so calling
 * it with two arguments would treat `rgba(0, 0, 0, 0.6)` as pure black and
 * report 21:1 — the same number as `text.primary`, and the same number as
 * black-on-white. That is a FALSE pass, not a strict one: it reports a
 * contrast the user never actually sees.
 *
 * So every assertion below passes the opaque backing surface explicitly, and
 * the "both text colors cannot be 21:1" property is itself asserted at the
 * bottom of this file so the mistake cannot silently return.
 */

import { describe, it, expect } from 'vitest';
import { lightPalette } from '../../../theme/light';
import { darkPalette } from '../../../theme/dark';
import {
  contrastRatio,
  WCAG_AA_LARGE_TEXT,
  WCAG_AA_NORMAL_TEXT,
  WCAG_AA_UI_COMPONENT,
} from './testUtils/contrast';

// Component-authored colors that are not part of the theme palette but ARE
// painted by DataTable — the selected-row tint (`DesktopGridRenderer.tsx`'s
// `.MuiDataGrid-row.Mui-selected` equivalent styling, `DataCard.tsx`'s
// selected background) and the bulk-action-bar tint (`BulkActionBar.tsx`).
//
// These are literals in the components themselves (`BulkActionBar.tsx:63-64`,
// `DataCard.tsx:160-161`), not palette lookups, so they are mirrored here
// verbatim rather than derived — verified to match those two files.
const SELECTED_ROW_TINT_LIGHT = 'rgba(25, 118, 210, 0.06)';
const SELECTED_ROW_TINT_DARK = 'rgba(144, 202, 249, 0.10)';

// The collapsed "More details" region's own backing wash (`DataCard.tsx:279-280`),
// painted over the card's `background.paper`.
const DETAIL_REGION_TINT_LIGHT = 'rgba(0, 0, 0, 0.02)';
const DETAIL_REGION_TINT_DARK = 'rgba(255, 255, 255, 0.03)';

const LIGHT_PAPER = lightPalette.background!.paper!;
const DARK_PAPER = darkPalette.background!.paper!;

describe('DataTable — WCAG contrast (computed against the real theme)', () => {
  describe('body text on the card / paper surface', () => {
    // Measured: 16.07:1. `text.primary` is rgba(0,0,0,0.87) composited over #ffffff.
    it('light theme: text.primary on background.paper meets AA normal text (4.5:1)', () => {
      const ratio = contrastRatio(
        lightPalette.text!.primary!,
        LIGHT_PAPER,
        LIGHT_PAPER,
      );
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    });

    // Measured: 5.74:1 — the tightest of the four, and the reason the alpha
    // must be composited: read as opaque black it would report 21:1.
    it('light theme: text.secondary on background.paper meets AA normal text (4.5:1)', () => {
      const ratio = contrastRatio(
        lightPalette.text!.secondary!,
        LIGHT_PAPER,
        LIGHT_PAPER,
      );
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    });

    // Measured: 13.77:1. `text.primary` is opaque #F7F8FA (`neutral[50]`) on
    // the #1E293B card — no longer pure white on near-black.
    it('dark theme: text.primary on background.paper meets AA normal text (4.5:1)', () => {
      const ratio = contrastRatio(
        darkPalette.text!.primary!,
        DARK_PAPER,
        DARK_PAPER,
      );
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    });

    // Measured: 7.50:1. rgba(247,248,250,0.7) composited over #1E293B.
    it('dark theme: text.secondary on background.paper meets AA normal text (4.5:1)', () => {
      const ratio = contrastRatio(
        darkPalette.text!.secondary!,
        DARK_PAPER,
        DARK_PAPER,
      );
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    });
  });

  describe('body text over the SELECTED-row tint (translucent, composited)', () => {
    // The tint is painted over `background.paper` (the Card / DataGrid row's
    // own surface); text.primary is what sits on top of it in both
    // `DataCard.tsx` and the grid's selected-row styling. A translucent tint
    // is the one case a naive two-color contrast check gets wrong — the
    // ACTUAL rendered background is the tint alpha-composited over paper, not
    // the tint's own (mostly-transparent) color read in isolation.

    // Measured: 14.87:1.
    it('light theme: text.primary over the selected-row tint (composited over paper) meets AA', () => {
      const ratio = contrastRatio(
        lightPalette.text!.primary!,
        SELECTED_ROW_TINT_LIGHT,
        LIGHT_PAPER,
      );
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    });

    // Measured: 11.02:1.
    it('dark theme: text.primary over the selected-row tint (composited over paper) meets AA', () => {
      const ratio = contrastRatio(
        darkPalette.text!.primary!,
        SELECTED_ROW_TINT_DARK,
        DARK_PAPER,
      );
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    });
  });

  describe('detail-region body text (the card’s collapsed "More details" wash)', () => {
    // The region's `secondary`-column label/value pairs are `text.secondary`
    // over the detail wash over paper — a THREE-layer stack, and the pair with
    // the least headroom in the light theme once alpha is honoured.

    // Measured: 5.50:1.
    it('light theme: text.secondary over the detail wash (composited over paper) meets AA', () => {
      const ratio = contrastRatio(
        lightPalette.text!.secondary!,
        DETAIL_REGION_TINT_LIGHT,
        LIGHT_PAPER,
      );
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    });

    // Measured: 6.87:1.
    it('dark theme: text.secondary over the detail wash (composited over paper) meets AA', () => {
      const ratio = contrastRatio(
        darkPalette.text!.secondary!,
        DETAIL_REGION_TINT_DARK,
        DARK_PAPER,
      );
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    });
  });

  describe('primary-colored UI elements (chips, links, focus/selection accents)', () => {
    // `primary.main` is what `DataCard.tsx`'s "More details" control, the
    // filter chips (`variant="outlined" color="primary"`), and the selected
    // row's border all use. WCAG 1.4.11 (non-text contrast) sets the floor at
    // 3:1 against its background, not the stricter 4.5:1 for body text.

    // Measured: 7.90:1 — the brand indigo #4338CA on #ffffff. This pair used
    // to be the tightest in the file (#1976d2 cleared AA normal text by 0.10).
    // The accent is additionally held to 4.5:1 against BOTH surfaces in
    // `tokens.test.ts`, because it paints link text and not only borders.
    it('light theme: primary.main on background.paper meets the UI-component floor (3:1)', () => {
      const ratio = contrastRatio(lightPalette.primary!.main!, LIGHT_PAPER);
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_UI_COMPONENT);
    });

    // Measured: 7.34:1 — #A5B4FC on #1E293B.
    it('dark theme: primary.main on background.paper meets the UI-component floor (3:1)', () => {
      const ratio = contrastRatio(darkPalette.primary!.main!, DARK_PAPER);
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_UI_COMPONENT);
    });

    // The "More details" / "Fewer details" toggle and filter-chip labels are
    // `body2`-sized text COLORED with `primary.main`, not just a border or
    // icon — held to the stricter large-text-or-better floor as a matter of
    // this suite's own discipline, even though WCAG's text rule technically
    // only requires 4.5:1 for genuinely small text.
    it('light theme: primary.main text on background.paper clears the large-text floor (3:1)', () => {
      const ratio = contrastRatio(lightPalette.primary!.main!, LIGHT_PAPER);
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_LARGE_TEXT);
    });

    it('dark theme: primary.main text on background.paper clears the large-text floor (3:1)', () => {
      const ratio = contrastRatio(darkPalette.primary!.main!, DARK_PAPER);
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_LARGE_TEXT);
    });
  });

  describe('error (destructive) palette', () => {
    // Destructive row/bulk actions (`destructive: true`) paint in
    // `theme.palette.error.main`. That is no longer MUI's default: epic #19
    // pins `error` to the `failed` RUN-STATUS token, so a destructive action
    // and a failed run are the same red. The previous version of this block
    // anticipated exactly that — "if a future palette change ever adds a custom
    // override, this test starts exercising it for free".
    //
    // The '#d32f2f' / '#f44336' literals are therefore gone: the values are
    // read from the palette, and the pinning test below asserts WHICH token
    // they come from. Hardcoding the new hexes would just recreate the coupling
    // this change resolved.

    // Measured: 6.47:1 — #B91C1C on #ffffff.
    it('light theme: error.main on background.paper meets the UI-component floor', async () => {
      const { lightTheme } = await import('../../../theme');
      const ratio = contrastRatio(lightTheme.palette.error.main, LIGHT_PAPER);
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_UI_COMPONENT);
      // A destructive action's LABEL is colored text, not just an icon, so it
      // is held to the stricter normal-text floor too.
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    });

    // Measured: 5.29:1 — #F87171 on #1E293B.
    it('dark theme: error.main on background.paper meets the UI-component floor', async () => {
      const { darkTheme } = await import('../../../theme');
      const ratio = contrastRatio(darkTheme.palette.error.main, DARK_PAPER);
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_UI_COMPONENT);
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    });

    // Pins WHERE error.main comes from. Re-point `error` at a bespoke red and
    // the two tests above keep passing (any legible red would) while the design
    // rule they exist to protect is quietly broken — a destructive action and a
    // failed run drifting into two different reds.
    it('sources error.main from the failed run-status token', async () => {
      const { lightTheme, darkTheme } = await import('../../../theme');
      const { statusTokens } = await import('../../../theme/tokens');
      expect(lightTheme.palette.error.main).toBe(statusTokens.light.failed.fg);
      expect(darkTheme.palette.error.main).toBe(statusTokens.dark.failed.fg);
    });
  });

  describe('the calculator itself honours alpha', () => {
    // Guards the porting mistake this file's docblock describes: if a future
    // edit drops the third argument, `text.secondary` collapses onto
    // `text.primary`'s ratio and every assertion above silently over-reports.
    it('light theme: text.secondary is measurably LOWER contrast than text.primary', () => {
      const primary = contrastRatio(
        lightPalette.text!.primary!,
        LIGHT_PAPER,
        LIGHT_PAPER,
      );
      const secondary = contrastRatio(
        lightPalette.text!.secondary!,
        LIGHT_PAPER,
        LIGHT_PAPER,
      );
      expect(secondary).toBeLessThan(primary);
    });

    it('dark theme: text.secondary is measurably LOWER contrast than text.primary', () => {
      const primary = contrastRatio(
        darkPalette.text!.primary!,
        DARK_PAPER,
        DARK_PAPER,
      );
      const secondary = contrastRatio(
        darkPalette.text!.secondary!,
        DARK_PAPER,
        DARK_PAPER,
      );
      expect(secondary).toBeLessThan(primary);
    });

    // The palette-independent anchor (§17): pure black on pure white is
    // exactly 21:1 by definition, so this pins the calculator rather than the
    // theme and stays valid through any palette change.
    it('black on white is exactly 21:1 regardless of palette', () => {
      expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    });
  });
});
