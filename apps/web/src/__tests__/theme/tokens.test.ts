/**
 * Theme tests — the design tokens, checked as color MATH rather than as
 * snapshots of hex strings.
 *
 * Epic #19. A snapshot of `#0E7490` proves nothing: it fails when someone
 * changes the color, which is allowed, and passes when someone changes the
 * background out from under it, which is not. What actually has to hold is a
 * set of relationships, and every one of them is stated here:
 *
 *  1. Every status color clears WCAG AA (4.5:1) against `background.paper`,
 *     against `background.default`, and against its own chip fill — in its own
 *     mode. Three surfaces, because status text appears on all three.
 *  2. The chip outline (which is the same value as the label color) clears the
 *     3:1 non-text floor, so the chip's boundary can never be the weak link.
 *  3. The chip fill is actually visible against the card it sits on.
 *  4. Statuses that share a color-vision confusion axis are separated in
 *     LUMINANCE, not only in hue — the property that survives greyscale,
 *     dichromacy, and a bad monitor.
 *  5. No status color equals the brand accent. This is the hue-allocation rule
 *     from `tokens.ts` made mechanical: the accent owns interactive chrome,
 *     the statuses own everything else, and the day those overlap the screen
 *     stops reading as status.
 *
 * The calculator is the shared pure one at `__tests__/utils/contrast.ts` — the
 * same module the DataTable contrast suite uses, deliberately not a second
 * copy.
 */

import { describe, it, expect } from 'vitest';
import {
  CONFUSABLE_STATUS_GROUPS,
  MIN_STATUS_LUMINANCE_SEPARATION,
  brand,
  fontFamily,
  fontFamilyMono,
  statusTokens,
  surface,
  text,
  type ThemeModeKey,
} from '../../theme/tokens';
import { lightTheme, darkTheme } from '../../theme';
import { RUN_STATUSES } from '../../types/cockpit';
import {
  contrastRatio,
  parseColor,
  relativeLuminance,
  WCAG_AA_NORMAL_TEXT,
  WCAG_AA_UI_COMPONENT,
} from '../utils/contrast';

const MODES: readonly ThemeModeKey[] = ['light', 'dark'];

/**
 * The minimum contrast between a chip's fill and the card behind it.
 *
 * Deliberately low. The fill is a WASH, not the thing that identifies the
 * chip — identification is the icon, the label, and the 4.5:1 outline. A fill
 * strong enough to hit 3:1 on its own would leave no headroom for the label
 * sitting on top of it, which is the assertion that actually matters. 1.03 is
 * "the operator can see there is a chip there", nothing more.
 */
const MIN_CHIP_FILL_SEPARATION = 1.03;

const luminanceOf = (color: string) => relativeLuminance(parseColor(color));

describe('theme tokens — status palette', () => {
  it('covers exactly the RunStatus union in both modes', () => {
    for (const mode of MODES) {
      expect(Object.keys(statusTokens[mode]).sort()).toEqual([...RUN_STATUSES].sort());
    }
  });

  describe.each(MODES)('%s mode', (mode) => {
    const paper = surface[mode].paper;
    const pageBackground = surface[mode].default;

    it.each([...RUN_STATUSES])(
      '%s: label color clears AA normal text on paper, on the page, and on its own chip fill',
      (status) => {
        const { fg, surface: fill } = statusTokens[mode][status];

        // Status text inside a card or a table row.
        expect(contrastRatio(fg, paper), `${status} on background.paper`).toBeGreaterThanOrEqual(
          WCAG_AA_NORMAL_TEXT,
        );
        // Status text on the bare page — the dashboard panels' own background.
        // This is the TIGHTER of the two in light mode, because the page is a
        // 4% step below white, and it is the constraint that caps how light a
        // light-mode status color may be.
        expect(
          contrastRatio(fg, pageBackground),
          `${status} on background.default`,
        ).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
        // The label inside `StatusChip`, which paints its own fill.
        expect(contrastRatio(fg, fill), `${status} on its chip fill`).toBeGreaterThanOrEqual(
          WCAG_AA_NORMAL_TEXT,
        );
      },
    );

    it.each([...RUN_STATUSES])(
      '%s: chip outline clears the 3:1 non-text floor against both surfaces',
      (status) => {
        // `StatusChip` uses `token.fg` as the border color precisely so this
        // is implied by the assertion above rather than being a separate value
        // that can rot. Asserted anyway: it is the thing WCAG 1.4.11 requires,
        // and it would stop being implied the moment someone fades the border.
        const { fg } = statusTokens[mode][status];
        expect(contrastRatio(fg, paper)).toBeGreaterThanOrEqual(WCAG_AA_UI_COMPONENT);
        expect(contrastRatio(fg, pageBackground)).toBeGreaterThanOrEqual(WCAG_AA_UI_COMPONENT);
      },
    );

    it.each([...RUN_STATUSES])('%s: chip fill is distinguishable from the card', (status) => {
      const { surface: fill } = statusTokens[mode][status];
      expect(contrastRatio(fill, paper), `${status} fill vs paper`).toBeGreaterThanOrEqual(
        MIN_CHIP_FILL_SEPARATION,
      );
    });

    it('gives every status a distinct luminance', () => {
      const luminances = RUN_STATUSES.map((status) => luminanceOf(statusTokens[mode][status].fg));
      expect(new Set(luminances).size).toBe(RUN_STATUSES.length);
    });

    it.each(CONFUSABLE_STATUS_GROUPS.map((group) => [group.join(' / '), group] as const))(
      'separates %s in luminance, not only in hue',
      (_name, group) => {
        // The property that survives greyscale and dichromacy. Hue is what a
        // colorblind operator may not have; tone is what everybody has.
        for (let i = 0; i < group.length; i += 1) {
          for (let j = i + 1; j < group.length; j += 1) {
            const a = group[i];
            const b = group[j];
            const delta = Math.abs(
              luminanceOf(statusTokens[mode][a].fg) - luminanceOf(statusTokens[mode][b].fg),
            );
            expect(delta, `${mode}: ${a} vs ${b}`).toBeGreaterThanOrEqual(
              MIN_STATUS_LUMINANCE_SEPARATION,
            );
          }
        }
      },
    );

    it('never paints a status in the brand accent', () => {
      // The hue-allocation rule, mechanically. Equality is the crude form of
      // it; the human form ("indigo is chrome, everything else is status")
      // lives in `tokens.ts`.
      const theme = mode === 'light' ? lightTheme : darkTheme;
      const reserved = [
        theme.palette.primary.main.toLowerCase(),
        theme.palette.secondary.main.toLowerCase(),
        brand[mode].accent.toLowerCase(),
      ];
      for (const status of RUN_STATUSES) {
        expect(reserved, `${status} must not reuse the brand accent`).not.toContain(
          statusTokens[mode][status].fg.toLowerCase(),
        );
      }
    });
  });
});

describe('theme tokens — surfaces and text', () => {
  it.each(MODES)('%s: body text clears AA on both surfaces', (mode) => {
    const paper = surface[mode].paper;
    const pageBackground = surface[mode].default;
    for (const backing of [paper, pageBackground]) {
      // Third argument is mandatory here: both palettes state at least one
      // text tier with alpha, and a translucent foreground read as opaque
      // reports a contrast nobody sees (see `utils/contrast.ts`).
      expect(contrastRatio(text[mode].primary, backing, backing)).toBeGreaterThanOrEqual(
        WCAG_AA_NORMAL_TEXT,
      );
      expect(contrastRatio(text[mode].secondary, backing, backing)).toBeGreaterThanOrEqual(
        WCAG_AA_NORMAL_TEXT,
      );
    }
  });

  it.each(MODES)('%s: the brand accent is legible as link text on both surfaces', (mode) => {
    // The accent is used for LINK TEXT, not only for fills and borders, so it
    // is held to 4.5:1 rather than to the 3:1 UI-component floor.
    const accent = brand[mode].accent;
    expect(contrastRatio(accent, surface[mode].paper)).toBeGreaterThanOrEqual(
      WCAG_AA_NORMAL_TEXT,
    );
    expect(contrastRatio(accent, surface[mode].default)).toBeGreaterThanOrEqual(
      WCAG_AA_NORMAL_TEXT,
    );
  });

  it.each(MODES)('%s: text.secondary is measurably quieter than text.primary', (mode) => {
    // Guards the alpha-compositing mistake described in `utils/contrast.ts`:
    // drop the third argument and both tiers collapse to the same ratio.
    const paper = surface[mode].paper;
    const primary = contrastRatio(text[mode].primary, paper, paper);
    const secondary = contrastRatio(text[mode].secondary, paper, paper);
    expect(secondary).toBeLessThan(primary);
  });
});

describe('theme — the tokens actually reach the MUI themes', () => {
  it('wires the semantic channels to the status vocabulary', () => {
    // An `<Alert severity="error">` and a failed run are the same claim. Two
    // different reds is how a status vocabulary stops being a vocabulary.
    expect(lightTheme.palette.error.main).toBe(statusTokens.light.failed.fg);
    expect(lightTheme.palette.warning.main).toBe(statusTokens.light.stalled.fg);
    expect(lightTheme.palette.info.main).toBe(statusTokens.light.running.fg);
    expect(lightTheme.palette.success.main).toBe(statusTokens.light.succeeded.fg);

    expect(darkTheme.palette.error.main).toBe(statusTokens.dark.failed.fg);
    expect(darkTheme.palette.warning.main).toBe(statusTokens.dark.stalled.fg);
    expect(darkTheme.palette.info.main).toBe(statusTokens.dark.running.fg);
    expect(darkTheme.palette.success.main).toBe(statusTokens.dark.succeeded.fg);
  });

  it('uses the brand accent as primary in both modes', () => {
    expect(lightTheme.palette.primary.main).toBe(brand.light.accent);
    expect(darkTheme.palette.primary.main).toBe(brand.dark.accent);
  });

  it('ships a self-hosted Inter first and a system mono stack', () => {
    // If "Inter Variable" ever stops being first, the `@fontsource-variable`
    // import in `main.tsx` is dead weight and every user silently gets the
    // fallback — which is exactly the bug this replaced, where the stack named
    // "Inter" and nothing ever loaded it.
    expect(lightTheme.typography.fontFamily).toBe(fontFamily);
    expect(fontFamily.startsWith('"Inter Variable"')).toBe(true);
    expect(lightTheme.typography.fontFamilyMono).toBe(fontFamilyMono);
    // System fonts only: no second webfont download for a dozen short ids.
    expect(fontFamilyMono).not.toMatch(/Inter/);
  });

  it('draws the AppBar border from the palette, not from a literal', () => {
    // The specific regression: `components.ts` used to hardcode `#e0e0e0` /
    // `#333333` behind a ternary on the mode, matching neither palette's
    // divider.
    for (const theme of [lightTheme, darkTheme]) {
      const root = theme.components?.MuiAppBar?.styleOverrides?.root;
      expect(typeof root, 'MuiAppBar root override must be a theme callback').toBe('function');
      const styles = (root as (props: { theme: typeof theme }) => Record<string, unknown>)({
        theme,
      });
      expect(styles.borderBottom).toBe(`1px solid ${theme.palette.divider}`);
      expect(String(styles.borderBottom)).not.toMatch(/#e0e0e0|#333333/i);
    }
  });

  it('exposes the tabular-numeral utility class through CssBaseline', () => {
    // `.opifex-num` is the whole reason Inter is self-hosted: without tabular
    // figures a polled metric reflows its own column on every tick.
    const baseline = lightTheme.components?.MuiCssBaseline?.styleOverrides as
      | Record<string, Record<string, unknown>>
      | undefined;
    expect(baseline?.['.opifex-num']?.fontVariantNumeric).toBe('tabular-nums');
    expect(baseline?.['.opifex-mono']?.fontFamily).toBe(fontFamilyMono);
  });
});
