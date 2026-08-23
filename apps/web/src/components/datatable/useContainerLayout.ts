/**
 * DataTable — container-driven layout resolution.
 *
 * The renderer switch is driven by the width of the table's OWN container, not
 * by the viewport. That distinction is the entire point of this module:
 *
 *   A DataTable inside the Workflow runs drawer is 400px wide on a 1440px
 *   desktop. A viewport-based `useMediaQuery` would hand that drawer the full
 *   desktop grid and it would be unusable; a ResizeObserver on the wrapper
 *   hands it cards, which is correct.
 *
 * Container queries would express this natively, but CSS container queries
 * cannot change *which component tree renders* — only how an already-rendered
 * one is styled. A card list and a DataGrid are genuinely different trees, so
 * measurement has to reach JavaScript, and `ResizeObserver` is the cheapest way
 * to get there.
 *
 * ## Before the first measurement
 *
 * `ResizeObserver` reports nothing during SSR and nothing on the very first
 * paint. Rather than flash the wrong renderer (or worse, mount a DataGrid and
 * immediately throw it away), the hook falls back to a viewport `useMediaQuery`
 * until a real, non-zero width arrives. On a normal page the viewport and the
 * container agree, so the fallback is right; in a drawer it is wrong for
 * exactly one frame, which is strictly better than being wrong forever.
 *
 * A measured width of `0` is treated as "not measured yet" — that is what a
 * `display: none` ancestor, a not-yet-laid-out node, and jsdom's layout-free
 * DOM all report, and none of them mean "this table is 0px wide".
 */

import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import type { RefObject } from 'react';
import { useMediaQuery, useTheme } from '@mui/material';
import type { DataTableLayout, DataTableRendererMode } from './types';

// ---------------------------------------------------------------------------
// Breakpoints
// ---------------------------------------------------------------------------

/**
 * Below 600px a table cannot show a headline plus one supporting column
 * without either horizontal scrolling or unreadable truncation — that is where
 * cards win. 600 is also MUI's `sm`, so a container that happens to match the
 * viewport lands on the same pivot the rest of the app uses.
 */
export const DEFAULT_MOBILE_BREAKPOINT = 600;

/**
 * 1200px (MUI's `lg`) is where the grid stops having to hide anything. It is
 * deliberately the SAME threshold the desktop renderer already used to fold
 * `detail` columns away, so the tablet band is exactly "the widths at which
 * columns are being hidden" — and therefore exactly the band that needs a row
 * expander to make them reachable again.
 */
export const DEFAULT_TABLET_BREAKPOINT = 1200;

export interface DataTableBreakpoints {
  /** Below this container width, render cards. */
  mobile: number;
  /** Below this container width (and at/above `mobile`), run the tablet grid. */
  tablet: number;
}

export const DEFAULT_BREAKPOINTS: DataTableBreakpoints = {
  mobile: DEFAULT_MOBILE_BREAKPOINT,
  tablet: DEFAULT_TABLET_BREAKPOINT,
};

/**
 * Pure width → layout mapping. Exported so it can be unit-tested without a DOM
 * and reused by anything that already knows its width.
 */
export function layoutForWidth(
  width: number,
  breakpoints: DataTableBreakpoints = DEFAULT_BREAKPOINTS,
): DataTableLayout {
  if (width < breakpoints.mobile) return 'mobile';
  if (width < breakpoints.tablet) return 'tablet';
  return 'desktop';
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

/**
 * Observe an element's inline size.
 *
 * Returns `null` until a real (non-zero) width has been observed, which is the
 * caller's signal to use a viewport fallback instead of guessing.
 */
export function useContainerWidth(
  ref: RefObject<HTMLElement | null>,
): number | null {
  const [width, setWidth] = useState<number | null>(null);

  // Ignore a 0/absent measurement rather than resolving to `mobile` for a
  // hidden or not-yet-laid-out container.
  const record = useCallback((next: number | undefined) => {
    if (typeof next !== 'number' || !Number.isFinite(next) || next <= 0) return;
    setWidth((current) => (current === next ? current : next));
  }, []);

  // Layout effect: measure before paint so a correctly-sized container never
  // shows a frame of the fallback layout.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    record(element.getBoundingClientRect().width);
  }, [ref, record]);

  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (!entry) return;
      // `contentBoxSize` is the spec'd field; `contentRect` is the older one
      // and is what most test doubles provide.
      const inline = Array.isArray(entry.contentBoxSize)
        ? entry.contentBoxSize[0]?.inlineSize
        : undefined;
      record(inline ?? entry.contentRect?.width);
    });

    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, record]);

  return width;
}

// ---------------------------------------------------------------------------
// Layout resolution
// ---------------------------------------------------------------------------

/**
 * Viewport-based layout — the pre-measurement fallback only.
 *
 * Mirrors {@link layoutForWidth}'s thresholds using MUI's own breakpoints so
 * the fallback and the measured answer agree whenever the container happens to
 * be the full viewport.
 */
export function useViewportLayout(): DataTableLayout {
  const theme = useTheme();
  const isPhone = useMediaQuery(theme.breakpoints.down('sm'));
  const isBelowDesktop = useMediaQuery(theme.breakpoints.down('lg'));
  if (isPhone) return 'mobile';
  return isBelowDesktop ? 'tablet' : 'desktop';
}

/**
 * Resolve the layout for one DataTable instance.
 *
 * @param ref         wrapper element to measure
 * @param mode        `'auto'` measures; anything else is returned verbatim
 * @param breakpoints per-instance overrides (`undefined` entries keep defaults)
 */
export function useDataTableLayout(
  ref: RefObject<HTMLElement | null>,
  mode: DataTableRendererMode = 'auto',
  breakpoints?: Partial<DataTableBreakpoints>,
): DataTableLayout {
  const width = useContainerWidth(ref);
  const viewportLayout = useViewportLayout();

  const mobile = breakpoints?.mobile ?? DEFAULT_MOBILE_BREAKPOINT;
  const tablet = breakpoints?.tablet ?? DEFAULT_TABLET_BREAKPOINT;

  if (mode !== 'auto') return mode;
  if (width === null) return viewportLayout;
  // A caller that sets `mobile` above `tablet` gets mobile-wins rather than an
  // unreachable band; clamping here keeps `layoutForWidth` a total function.
  return layoutForWidth(width, { mobile, tablet: Math.max(mobile, tablet) });
}
