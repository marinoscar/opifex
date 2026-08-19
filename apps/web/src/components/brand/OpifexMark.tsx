/**
 * The Opifex mark — inline SVG, no image request, no second color.
 *
 * Epic #19.
 *
 * ## What it draws, and why that shape
 *
 * Three stacked horizontal bars of decreasing width (the QUEUE draining)
 * crossed by one ascending stroke (DISPATCH). That is the whole product in two
 * ideas: work waiting, and work being sent. Opifex is a control plane for
 * coding agents — a robot, a brain or a spark would all have said "AI", which
 * is the least distinguishing thing about it.
 *
 * ## Why inline SVG rather than an `<img>`
 *
 *  - `currentColor` for every stroke means the mark inverts with the theme for
 *    free. An `<img>` would need a light and a dark asset, plus a media query,
 *    plus a moment of the wrong one during hydration.
 *  - No network request, so it cannot be the thing that is missing on a cold
 *    load of the app bar.
 *  - `role="img"` with an accessible name is honest to a screen reader; a
 *    decorative CSS background is not reachable at all.
 *
 * ## Constraints the geometry has to respect
 *
 *  - 24x24 viewBox, `strokeWidth` 2, round caps. At the 16px favicon size a
 *    hairline disappears and a square cap turns three bars into a smudge.
 *  - The bars stop short of the ascending stroke's path at the top so the
 *    crossing reads as a crossing rather than as a filled triangle.
 *  - Nothing here is a `<text>` element: at 16px, glyphs do not survive.
 *
 * Keep this file and `public/favicon.svg` in sync — they are the same drawing
 * expressed twice, because a favicon cannot import a React component.
 */

import type { SVGProps } from 'react';

export interface OpifexMarkProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  /** Edge length in px (the mark is square). Defaults to 24, its native size. */
  size?: number;
  /**
   * Accessible name. Pass `null` when the mark sits next to a visible "Opifex"
   * label — repeating it makes a screen reader say the word twice — in which
   * case the SVG becomes `aria-hidden` and drops out of the tree entirely.
   */
  title?: string | null;
}

export function OpifexMark({ size = 24, title = 'Opifex', ...props }: OpifexMarkProps) {
  const decorative = title === null;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      // `currentColor` everywhere: the ONE thing that must not become a hex.
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      // Without this, IE/Edge legacy and some assistive tooling put the SVG in
      // the tab order. It is never interactive; its wrapper is.
      focusable="false"
      role={decorative ? undefined : 'img'}
      aria-hidden={decorative ? true : undefined}
      aria-label={decorative ? undefined : title}
      {...props}
    >
      {/* The queue: three bars, each shorter than the one above it. */}
      <line x1="3" y1="7" x2="14" y2="7" />
      <line x1="3" y1="12" x2="11" y2="12" />
      <line x1="3" y1="17" x2="8" y2="17" />
      {/* Dispatch: one ascending stroke, crossing the stack left to right. */}
      <path d="M6 20 L21 5" />
    </svg>
  );
}

export default OpifexMark;
