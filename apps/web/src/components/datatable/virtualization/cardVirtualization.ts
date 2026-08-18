/**
 * DataTable — card-list render skipping (issue #256, epic #238).
 *
 * ## What this is, and what it deliberately is not
 *
 * Cards are variable height: a card's body grows with its `secondary` column
 * count and its detail region expands in place. A windowing virtualizer needs a
 * height estimate per item, and a WRONG estimate is not a small inefficiency —
 * it is a scroll position that jumps under the user's thumb. Issue #237 is that
 * bug, shipped: a gallery placeholder computed for the wrong column count made
 * scrolling jump. An incorrect virtualizer is worse than none.
 *
 * So this is not a virtualizer. It is the browser's own render-skipping:
 *
 * - **`content-visibility: auto`** lets the engine skip layout, paint and style
 *   for a card that is outside the viewport, and un-skip it when it approaches.
 *   Unlike `display: none` the subtree stays focusable and find-in-page-able —
 *   the browser force-renders it when focus or a find lands inside — so
 *   keyboard navigation and Ctrl-F are unaffected.
 * - **`contain-intrinsic-size: auto <measured>px`** supplies the placeholder
 *   height while a card is skipped. The `auto` keyword makes the browser
 *   remember each card's LAST RENDERED size and prefer it over the estimate, so
 *   the estimate only ever has to be right for cards that have never been on
 *   screen — and it is a *measurement* of a real card in this table, not a
 *   guess derived from a column count.
 * - **`loading="lazy"` on card images**, applied to whatever a column's `render`
 *   produced. A card list of thumbnails otherwise fetches every image on the
 *   page at once.
 *
 * ## Why the first card is excluded
 *
 * It is the one being measured. A card that may skip its own layout is a card
 * whose `getBoundingClientRect()` can legitimately report the placeholder size,
 * which would feed the measurement back into itself. The first card is on screen
 * by definition, so skipping it would buy nothing anyway.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Rows below which nothing is applied.
 *
 * `content-visibility` costs a containment context per card; below ~20 cards
 * there is nothing to skip and the plain list is both simpler and faster.
 */
export const CARD_VIRTUALIZATION_MIN_ROWS = 20;

/**
 * Placeholder height used until a real card has been measured, in px.
 *
 * Only ever visible for the frames between mount and the first measurement, and
 * only for cards that are already off screen.
 */
export const CARD_FALLBACK_INTRINSIC_HEIGHT = 168;

/** Re-measure only past this delta, so a 1px reflow cannot loop the state. */
const MEASURE_EPSILON_PX = 4;

/** Whether a card list of this size is worth skipping renders for. */
export function shouldVirtualizeCards(
  rowCount: number,
  minRows: number = CARD_VIRTUALIZATION_MIN_ROWS,
): boolean {
  return rowCount >= minRows;
}

/**
 * The `contain-intrinsic-size` value for a measured card height.
 *
 * `auto <length>` rather than a bare length: the browser then remembers each
 * card's real rendered size and uses the length only for cards it has never
 * laid out. That is what keeps the scrollbar honest as the user scrolls through
 * cards of genuinely different heights.
 */
export function containIntrinsicSize(height: number | null | undefined): string {
  const px = Math.max(1, Math.round(height ?? CARD_FALLBACK_INTRINSIC_HEIGHT));
  return `auto ${px}px`;
}

/**
 * Measure one real card and report its height.
 *
 * A callback ref plus a `ResizeObserver`, so a card that reflows (a wider
 * container, a density change, a longer value) updates the placeholder instead
 * of pinning it to the first paint.
 */
export function useMeasuredCardHeight(enabled: boolean): {
  measureRef: (node: HTMLElement | null) => void;
  height: number | null;
} {
  const [height, setHeight] = useState<number | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);

  const record = useCallback((next: number) => {
    if (!Number.isFinite(next) || next <= 0) return;
    setHeight((current) =>
      current !== null && Math.abs(current - next) < MEASURE_EPSILON_PX ? current : next,
    );
  }, []);

  const measureRef = useCallback(
    (node: HTMLElement | null) => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      if (!node || !enabled) return;

      record(node.getBoundingClientRect().height);

      if (typeof ResizeObserver === 'undefined') return;
      const observer = new ResizeObserver((entries) => {
        for (const entry of entries) record(entry.contentRect.height);
      });
      observer.observe(node);
      observerRef.current = observer;
    },
    [enabled, record],
  );

  useEffect(() => () => observerRef.current?.disconnect(), []);

  return { measureRef, height: enabled ? height : null };
}

/**
 * Mark every image inside a subtree lazy, unless the author already said
 * otherwise.
 *
 * A column's `render` is used verbatim (§3) and belongs to the calling page, so
 * the card cannot rewrite it — but it can annotate what that render produced.
 * An explicit `loading` attribute is never overwritten: a page that deliberately
 * wrote `loading="eager"` on an above-the-fold thumbnail keeps it.
 */
export function useLazyImages(
  ref: { current: HTMLElement | null },
  enabled: boolean = true,
): void {
  useEffect(() => {
    const root = ref.current;
    if (!enabled || !root) return;
    for (const image of Array.from(root.querySelectorAll('img'))) {
      if (!image.hasAttribute('loading')) image.setAttribute('loading', 'lazy');
      if (!image.hasAttribute('decoding')) image.setAttribute('decoding', 'async');
    }
  });
}
