/**
 * Shared test utility — WCAG 2.1 relative-luminance / contrast-ratio
 * calculator (issue #257, epic #19).
 *
 * Pure color math, no rendering, no jsdom dependency. Two suites use it:
 *
 *  - `components/datatable/__tests__/DataTableContrast.test.tsx` — the
 *    specific foreground/background pairs the DataTable paints.
 *  - `__tests__/theme/tokens.test.ts` — the status palette's AA floors and
 *    luminance separations.
 *
 * It lives here rather than under the DataTable suites (where it started, and
 * where a re-export shim still points at it) because two copies of color math
 * is how two suites end up disagreeing about what 4.5:1 means.
 *
 * ## Why this exists at all instead of axe-core's `color-contrast` rule
 *
 * That rule needs real layout/paint to resolve an element's *effective*
 * background (it walks up the DOM compositing translucent layers), which jsdom
 * fundamentally cannot provide — every element reports a 0x0 box, so the rule
 * either short-circuits every node as "incomplete" or, worse, resolves a wrong
 * background through an always-empty bounding rect. Running it under jsdom is
 * a known false-negative trap, which is why the DataTable conformance suite's
 * axe pass disables it (`conformance/runDataTableConformanceSuite.tsx`
 * documents the exact justification alongside the `axe.run` call).
 *
 * ## Translucent colors must be composited
 *
 * `contrastRatio()` only flattens a translucent color when it is given the
 * opaque surface behind it. Called with two arguments, `rgba(0, 0, 0, 0.6)` is
 * treated as pure black and reports 21:1 — a FALSE pass reporting a contrast
 * the user never sees. Always pass the backing surface as the third argument
 * when either color has alpha.
 */

/** Parses `#rgb`, `#rrggbb`, `rgb(r,g,b)` and `rgba(r,g,b,a)` into 0–255 channels + alpha. */
export function parseColor(input: string): { r: number; g: number; b: number; a: number } {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(input.trim());
  if (hex) {
    const value = hex[1];
    const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value;
    const num = Number.parseInt(full, 16);
    return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255, a: 1 };
  }
  const fn = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(
    input.trim(),
  );
  if (fn) {
    return {
      r: Number.parseFloat(fn[1]),
      g: Number.parseFloat(fn[2]),
      b: Number.parseFloat(fn[3]),
      a: fn[4] !== undefined ? Number.parseFloat(fn[4]) : 1,
    };
  }
  throw new Error(`contrast.ts: unrecognized color format "${input}"`);
}

/** Alpha-composites `fg` (which may be translucent) over an OPAQUE `bg`. */
export function flattenOver(
  fg: { r: number; g: number; b: number; a: number },
  bg: { r: number; g: number; b: number },
): { r: number; g: number; b: number } {
  const mix = (a: number, b: number) => a * fg.a + b * (1 - fg.a);
  return { r: mix(fg.r, bg.r), g: mix(fg.g, bg.g), b: mix(fg.b, bg.b) };
}

/** WCAG relative luminance of an sRGB color (0–255 channels). */
export function relativeLuminance(color: { r: number; g: number; b: number }): number {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const r = channel(color.r);
  const g = channel(color.g);
  const b = channel(color.b);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * WCAG contrast ratio between two colors, each possibly given as a CSS color
 * string. A translucent `foreground` is flattened over `backgroundFallback`
 * (the true opaque surface behind it) before luminance is computed — exactly
 * what a browser does compositing an overlay tint.
 */
export function contrastRatio(
  foreground: string,
  background: string,
  backgroundFallback?: string,
): number {
  const fg = parseColor(foreground);
  const bg = parseColor(background);
  const flattenedFg =
    fg.a < 1 && backgroundFallback ? flattenOver(fg, parseColor(backgroundFallback)) : fg;
  const flattenedBg = bg.a < 1 && backgroundFallback ? flattenOver(bg, parseColor(backgroundFallback)) : bg;

  const l1 = relativeLuminance(flattenedFg);
  const l2 = relativeLuminance(flattenedBg);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/** WCAG AA thresholds. Large text is >=18pt, or >=14pt bold. */
export const WCAG_AA_NORMAL_TEXT = 4.5;
export const WCAG_AA_LARGE_TEXT = 3.0;
/** Non-text UI components / graphical objects (WCAG 1.4.11). */
export const WCAG_AA_UI_COMPONENT = 3.0;
