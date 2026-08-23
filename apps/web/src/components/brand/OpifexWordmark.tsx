/**
 * The Opifex wordmark — the mark plus the name, as one inline SVG.
 *
 * Epic #19. Everything in `OpifexMark`'s header about `currentColor`,
 * `role="img"` and inline-versus-`<img>` applies here unchanged; only the
 * wordmark-specific decisions are recorded below.
 *
 * ## Why the name is SVG `<text>` and not a `<Typography>` next to the mark
 *
 * A DOM pairing would need the mark's optical baseline aligned to a text
 * baseline that changes with the theme's font size — the two drift apart the
 * first time anyone renders this at a size the CSS was not tuned for. Inside
 * one SVG the relationship is fixed by the viewBox at every size.
 *
 * `fontFamily="inherit"` keeps the name in Inter (the app font) rather than
 * the SVG default, and `textLength` + `lengthAdjust="spacingAndGlyphs"` pins
 * the drawn width to the viewBox so the element's box is correct even before
 * the webfont has loaded, or if it never does. Without that pin the wordmark
 * visibly resizes when Inter swaps in.
 *
 * The single `<svg>` also means ONE accessible name for the whole lockup. A
 * mark and a text node side by side announce twice.
 */

import type { SVGProps } from 'react';

export interface OpifexWordmarkProps extends Omit<
  SVGProps<SVGSVGElement>,
  'children'
> {
  /** Rendered height in px. Width follows the 132:24 viewBox aspect ratio. */
  height?: number;
  /** Accessible name. `null` marks the lockup decorative (`aria-hidden`). */
  title?: string | null;
}

const VIEWBOX_WIDTH = 132;
const VIEWBOX_HEIGHT = 24;

export function OpifexWordmark({
  height = 24,
  title = 'Opifex',
  ...props
}: OpifexWordmarkProps) {
  const decorative = title === null;

  return (
    <svg
      height={height}
      width={(height * VIEWBOX_WIDTH) / VIEWBOX_HEIGHT}
      viewBox={`0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`}
      fill="none"
      focusable="false"
      role={decorative ? undefined : 'img'}
      aria-hidden={decorative ? true : undefined}
      aria-label={decorative ? undefined : title}
      {...props}
    >
      {/* The mark, drawn identically to `OpifexMark` so the two never drift. */}
      <g
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <line x1="3" y1="7" x2="14" y2="7" />
        <line x1="3" y1="12" x2="11" y2="12" />
        <line x1="3" y1="17" x2="8" y2="17" />
        <path d="M6 20 L21 5" />
      </g>
      {/*
        `fill` (not `stroke`) is what colors glyphs, so the text needs its own
        `currentColor` — it does not inherit the group's stroke above.
      */}
      <text
        x="32"
        y="17"
        fill="currentColor"
        stroke="none"
        fontFamily="inherit"
        fontSize="15"
        fontWeight="600"
        letterSpacing="2.4"
        textLength="97"
        lengthAdjust="spacingAndGlyphs"
      >
        OPIFEX
      </text>
    </svg>
  );
}

export default OpifexWordmark;
