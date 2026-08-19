/**
 * Design tokens — the single source both palettes and `components.ts` read.
 *
 * Epic #19. Before this file existed the palette was six literal hexes in
 * `light.ts`/`dark.ts` and two more hardcoded in `components.ts` (an AppBar
 * border of `#e0e0e0` / `#333333` that no longer matched either palette's
 * divider). Anything a component needs to paint that is not already a
 * `theme.palette.*` lookup belongs here, not inline.
 *
 * ## The hue-allocation rule — the load-bearing decision in this file
 *
 * > The brand accent owns exactly ONE hue and is used only for interactive
 * > chrome (rail active state, links, primary buttons, focus rings). It is
 * > never used to paint a status. All remaining hue belongs to the status
 * > vocabulary.
 *
 * Opifex is a status-dense cockpit (VISION §10: the app "exists primarily to
 * show" six metrics about runs). A brand color that collides with a status
 * color stops the screen reading as status at all — the operator learns to
 * ignore the accent because it means two things. Hence indigo for the brand
 * and nothing else, and a deliberately quiet desaturated slate-teal for
 * `secondary` (the app uses `secondary` essentially nowhere; the previous loud
 * purple `#9c27b0` was one more thing competing with `quarantined`).
 *
 * `src/__tests__/theme/tokens.test.ts` asserts the rule mechanically: no
 * status token may equal `palette.primary.main` or `palette.secondary.main`.
 *
 * ## Colorblind safety is a code rule, not a hue choice
 *
 * > Every status renders through `StatusChip` and always carries icon + text
 * > label + color. Color is never the sole channel.
 *
 * That is what makes the palette defensible, and it reduces what remains to a
 * testable **luminance separation** problem between the statuses that share a
 * confusion axis. Those separations, and the WCAG AA floors below, are all
 * asserted in `tokens.test.ts` — the measured values quoted in the comments
 * here are recorded so a future palette edit shows up as a diff in intent
 * rather than only as a pass/fail flip.
 *
 * MUI's 8px spacing base and the existing `borderRadius: 8` are NOT forked.
 * This file adds color and elevation only.
 */

import type { RunStatus } from '../types/cockpit';

/** The two palette modes these tokens are defined for. */
export type ThemeModeKey = 'light' | 'dark';

// ---------------------------------------------------------------------------
// Neutral ramp
// ---------------------------------------------------------------------------

/**
 * A single cool-neutral (slate) ramp, used for surfaces, dividers, text and
 * the `blocked` status alike.
 *
 * One ramp rather than a warm/cool pair: the dark theme's surfaces are built
 * from `800`/`900` and the light theme's from `0`/`50`, so a second ramp would
 * only create the possibility of two greys that are almost, but not quite, the
 * same — the classic way a dark theme develops a seam between the app bar and
 * the page.
 */
export const neutral = {
  0: '#FFFFFF',
  50: '#F7F8FA',
  100: '#F1F5F9',
  200: '#E2E8F0',
  300: '#CBD5E1',
  400: '#94A3B8',
  500: '#64748B',
  600: '#475569',
  700: '#334155',
  800: '#1E293B',
  900: '#0F172A',
  950: '#020617',
} as const;

// ---------------------------------------------------------------------------
// Brand
// ---------------------------------------------------------------------------

/**
 * The brand accent: indigo, and only indigo.
 *
 * Measured against the surfaces below: `#4338CA` on white is 7.90:1 and on the
 * light page background 7.44:1; `#A5B4FC` on the dark card is 7.34:1 and on
 * the dark page background 8.96:1. All four clear WCAG AA for normal text,
 * which matters because the accent is used for link text, not only for borders
 * and fills.
 *
 * `accentSubtle` is the wash behind an active rail row / selected list item —
 * a tint, never a fill that text has to be read against on its own.
 */
export const brand = {
  light: {
    accent: '#4338CA',
    accentHover: '#3730A3',
    accentSubtle: '#EEF2FF',
    onAccent: '#FFFFFF',
  },
  dark: {
    accent: '#A5B4FC',
    accentHover: '#C7D2FE',
    accentSubtle: '#252C4B',
    onAccent: '#1E1B4B',
  },
} as const satisfies Record<ThemeModeKey, Record<string, string>>;

/**
 * `secondary`. Deliberately quiet, deliberately not a second brand.
 *
 * A desaturated slate-teal: adjacent to the neutral ramp, far from indigo, and
 * far from every status hue. If this ever starts looking like a second accent
 * on a screen, the screen is using it wrongly.
 */
export const brandSecondary = {
  light: { main: '#375E63', contrastText: '#FFFFFF' },
  dark: { main: '#94B8BC', contrastText: '#0F172A' },
} as const satisfies Record<ThemeModeKey, Record<string, string>>;

// ---------------------------------------------------------------------------
// Surfaces and text
// ---------------------------------------------------------------------------

/**
 * Page background (`default`) and card/app-bar background (`paper`).
 *
 * The light page background is `neutral.50` rather than pure white so cards
 * read as raised without needing a heavy shadow. It is only a 4% luminance
 * step below white, which is the reason **every status color is checked
 * against BOTH surfaces** in `tokens.test.ts`: a status that clears 4.5:1 on
 * `paper` can miss it on `default`, and status text appears on both.
 */
export const surface = {
  light: {
    default: neutral[50],
    paper: neutral[0],
    /** Hairline dividers and card outlines. Alpha so it works over any wash. */
    divider: 'rgba(15, 23, 42, 0.12)',
  },
  dark: {
    default: neutral[900],
    paper: neutral[800],
    divider: 'rgba(226, 232, 240, 0.14)',
  },
} as const satisfies Record<ThemeModeKey, Record<string, string>>;

/**
 * Text colors.
 *
 * The light values keep the alpha form (`rgba(0, 0, 0, 0.87)` /
 * `rgba(0, 0, 0, 0.6)`) that the DataTable contrast suite already composites
 * correctly — see the docblock in
 * `components/datatable/__tests__/DataTableContrast.test.tsx` on why a
 * translucent foreground read as opaque reports a contrast the user never
 * sees. The dark values switch from pure `#ffffff` to `neutral.50` at 70%
 * alpha for the secondary tier, measured at 13.77:1 and 7.50:1 on the dark
 * card.
 */
export const text = {
  light: {
    primary: 'rgba(0, 0, 0, 0.87)',
    secondary: 'rgba(0, 0, 0, 0.6)',
    disabled: 'rgba(0, 0, 0, 0.38)',
  },
  dark: {
    primary: neutral[50],
    secondary: 'rgba(247, 248, 250, 0.7)',
    disabled: 'rgba(247, 248, 250, 0.38)',
  },
} as const satisfies Record<ThemeModeKey, Record<string, string>>;

// ---------------------------------------------------------------------------
// Status vocabulary
// ---------------------------------------------------------------------------

/**
 * The two colors a status needs.
 *
 * `fg` paints the icon, the label, AND the chip outline — one value for all
 * three, so the outline can never be the weak link: it inherits the same
 * >= 4.5:1 floor the label is held to, and the chip is discernible as a
 * component (WCAG 1.4.11 asks only 3:1) for free.
 *
 * `surface` is the chip fill: an opaque token, computed as a 6–10% wash of
 * `fg` over `background.paper` (chips live inside cards and tables). It is
 * stored opaque rather than as an alpha so it can be asserted directly, and so
 * a chip rendered over an unusual background still has a known contrast with
 * its own label.
 */
export interface StatusToken {
  readonly fg: string;
  readonly surface: string;
}

/**
 * A status token key. Identical to `RunStatus` today, but named separately
 * because the mapping is a *choice* made in `config/runStatus.ts` — a future
 * status ("cancelled", say) may deliberately reuse an existing token rather
 * than claim a seventh hue, and the type should not pretend otherwise.
 */
export type StatusTokenKey = RunStatus;

/**
 * The status palette.
 *
 * Hues, and why each one:
 *
 * | status        | hue     | reading                                        |
 * |---------------|---------|------------------------------------------------|
 * | `running`     | cyan    | active, neutral-positive; not the brand indigo  |
 * | `succeeded`   | green   | done, calm — deep rather than bright on purpose |
 * | `stalled`     | amber   | the loudest warm color: this one wants a kill   |
 * | `blocked`     | slate   | the QUIETEST in the set (see below)             |
 * | `failed`      | red     | terminal                                        |
 * | `quarantined` | fuchsia | off the red/green/amber axis entirely           |
 *
 * **`blocked` is deliberately the quietest color here.** VISION §9 gives it
 * "park, auto-resume with jitter" — it resolves itself without a human, so it
 * must not compete with `stalled` for the operator's eye. Both light and dark
 * `blocked` sit almost exactly on the muted body-text color, so a blocked run
 * reads as ordinary text with an icon, which is the intended amount of
 * attention.
 *
 * Measured luminances (asserted in `tokens.test.ts`):
 *
 *   light — succeeded .065 · quarantined .078 · blocked .089 ·
 *           failed .112 · running .146 · stalled .159
 *   dark  — failed .330 · succeeded .496 · quarantined .547 ·
 *           stalled .636 · blocked .657 · running .674
 *
 * Two of the six deviate from the first-draft spec table, and both deviations
 * are forced by the separation test rather than by taste:
 *
 *   - light `succeeded` is `#14532D`, not `#15803D`. At `#15803D` its
 *     luminance (.159) is within .0002 of `stalled` and .013 of `running` —
 *     for a monochromat, and on a greyscale printout, green and amber became
 *     literally the same tone.
 *   - light `quarantined` is `#86198F`, not `#A21CAF`, whose luminance (.116)
 *     sat .004 from `failed`. Magenta-vs-red at equal tone is the single worst
 *     pair in this set to confuse, because the responses are opposite:
 *     `failed` re-runs automatically, `quarantined` must not.
 *
 * The dark set is separated far more easily — a dark background leaves the
 * whole .27–1.0 luminance range usable, where the light set is squeezed into
 * .05–.16 by the 4.5:1 floor against a near-white page.
 */
export const statusTokens: Record<ThemeModeKey, Record<StatusTokenKey, StatusToken>> = {
  light: {
    running: { fg: '#0E7490', surface: '#ECFEFF' },
    succeeded: { fg: '#14532D', surface: '#F0FDF4' },
    // `neutral[100]` rather than `neutral[50]`: the light page background IS
    // `neutral[50]`, so a `50` fill would make the quietest chip in the set
    // literally invisible on the dashboard's own background.
    blocked: { fg: '#475569', surface: '#F1F5F9' },
    stalled: { fg: '#B45309', surface: '#FFFBEB' },
    failed: { fg: '#B91C1C', surface: '#FEF2F2' },
    quarantined: { fg: '#86198F', surface: '#FDF4FF' },
  },
  dark: {
    running: { fg: '#67E8F9', surface: '#253C4E' },
    succeeded: { fg: '#34D399', surface: '#203A44' },
    blocked: { fg: '#CBD5E1', surface: '#2F3A4C' },
    stalled: { fg: '#FACC15', surface: '#343937' },
    failed: { fg: '#F87171', surface: '#343040' },
    quarantined: { fg: '#F0ABFC', surface: '#33364E' },
  },
};

/**
 * Status pairs that share a color-vision confusion axis, and are therefore
 * held to a minimum luminance separation on top of the WCAG floors.
 *
 * The first two groups come from the design spec. The last two are added here
 * because green-vs-amber and green-vs-red are the deuteranope/protanope
 * confusions — the most common CVD by a wide margin — and `succeeded` versus
 * `failed` is the pair whose meanings are furthest apart.
 *
 * `running`/`stalled` is knowingly NOT in this list: in the light theme the
 * 4.5:1 ceiling leaves no luminance room to separate a legible cyan from a
 * legible amber as well, and this is precisely the case the icon + label rule
 * exists to cover (a play glyph reading "Running" against an hourglass
 * reading "Stalled"). Recorded rather than silently omitted.
 */
export const CONFUSABLE_STATUS_GROUPS: readonly (readonly StatusTokenKey[])[] = [
  ['succeeded', 'running'],
  ['failed', 'quarantined', 'stalled'],
  ['succeeded', 'stalled'],
  ['succeeded', 'failed'],
];

/**
 * Minimum WCAG relative-luminance difference required between any two statuses
 * inside a `CONFUSABLE_STATUS_GROUPS` entry.
 *
 * 0.03 is not a standards number — no standard covers this — it is the largest
 * value the light palette can actually satisfy while every status still clears
 * 4.5:1 against a near-white page. The tightest real pair is light
 * `failed`/`quarantined` at 0.0348. Raising this constant requires darkening
 * the light page background or giving up the AA floor; do not raise it without
 * re-running the search.
 */
export const MIN_STATUS_LUMINANCE_SEPARATION = 0.03;

// ---------------------------------------------------------------------------
// Elevation
// ---------------------------------------------------------------------------

/**
 * Named shadows, replacing the two box-shadow strings that were inlined in
 * `components.ts` behind a `mode === 'light' ? … : …` ternary.
 *
 * Dark-mode shadows are stronger because a shadow on a dark surface has almost
 * no luminance range to work in; the separation there comes mostly from the
 * `paper`/`default` step, with the shadow only softening the edge.
 */
export const elevation = {
  light: {
    /** Cards, panels, the metric tiles. */
    card: '0 1px 2px rgba(15, 23, 42, 0.06), 0 2px 8px rgba(15, 23, 42, 0.08)',
    /** Menus, popovers, the bottom-nav overflow sheet. */
    overlay: '0 4px 12px rgba(15, 23, 42, 0.12), 0 12px 32px rgba(15, 23, 42, 0.12)',
  },
  dark: {
    card: '0 1px 2px rgba(0, 0, 0, 0.4), 0 2px 8px rgba(0, 0, 0, 0.32)',
    overlay: '0 4px 12px rgba(0, 0, 0, 0.5), 0 12px 32px rgba(0, 0, 0, 0.44)',
  },
} as const satisfies Record<ThemeModeKey, Record<string, string>>;

// ---------------------------------------------------------------------------
// Typography
// ---------------------------------------------------------------------------

/**
 * Body font stack.
 *
 * `Inter Variable` is SELF-HOSTED via `@fontsource-variable/inter`, imported
 * once in `src/main.tsx`. This is not a style preference:
 *
 *  1. The production CSP (`infra/nginx/csp.conf`) is
 *     `font-src 'self' data:` — a Google Fonts link is blocked outright, and
 *     the CSP is not being relaxed for a font.
 *  2. Inter ships **tabular numerals**. A metrics cockpit that polls would
 *     visibly jitter its stat tiles on every refresh with proportional
 *     figures. `components.ts` exposes that as the `.opifex-num` utility class.
 *
 * Until this file, the stack named `"Inter"` first and never loaded it — every
 * user got Roboto and none of the above.
 */
export const fontFamily =
  '"Inter Variable", "Inter", "Roboto", "Helvetica", "Arial", sans-serif';

/**
 * Monospace stack for identifiers the app displays constantly — work-order ids
 * (`wo_opifex_312_a3f91c2_a1`, VISION §4), commit SHAs, run ids, the attempted
 * path on the 404 page.
 *
 * System fonts only, on purpose: a second webfont download to render a dozen
 * short strings is not worth the bytes or the layout shift.
 */
export const fontFamilyMono =
  'ui-monospace, "SFMono-Regular", "SF Mono", "Menlo", "Consolas", "Liberation Mono", monospace';
