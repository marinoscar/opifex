/**
 * DataTable — grid row virtualization (issue #256, epic #238).
 *
 * MUI X's DataGrid virtualizes rows out of the box, but with ONE precondition
 * that is easy to miss and that this table tripped over from #252 onward:
 *
 * ```js
 * // @mui/x-data-grid/hooks/features/virtualization/useGridVirtualization.js
 * enabledForRows: !disableVirtualization && !autoHeight && HAS_LAYOUT
 * ```
 *
 * `autoHeight` **disables row virtualization**, and `autoHeight` is exactly what
 * this renderer uses whenever the caller omits `height` (the documented default,
 * §5: the table grows with its rows and the PAGE scrolls). So the default table
 * was rendering every loaded row, virtualizer or not.
 *
 * The fix is not "always take a fixed height" — auto-height is the right
 * behaviour for a 10- or 25-row page and turning every table into an internally
 * scrolling box would be a worse regression than the one being fixed. It is a
 * threshold: past {@link GRID_VIRTUALIZATION_ROW_THRESHOLD} loaded rows the grid
 * takes a bounded viewport, which is precisely the condition under which
 * virtualization pays for itself.
 *
 * ## Scale, honestly stated
 *
 * Every target table is server-paginated, and the MIT DataGrid throws above a
 * 100-row page, so the realistic worst case is 100 rows plus a few synthetic
 * tablet detail rows (§9.1). This is **robustness for large page sizes**, not
 * the performance strategy — the performance strategy is server-side
 * pagination, and it already shipped in #252.
 *
 * Nothing here needs a custom virtualizer. `disableVirtualization` is left at
 * its default (`false`) and the grid's own row/column windowing does the work;
 * this module only decides whether the grid is *allowed* to use it.
 *
 * (In jsdom `HAS_LAYOUT` is false, so virtualization is off in tests no matter
 * what — which is why the tests assert the *plan* and assert that selection is
 * row-set-derived rather than DOM-derived.)
 */

import type { DataTableDensity } from '../types';

/**
 * Loaded-row count above which the grid swaps auto-height for a bounded,
 * virtualizing viewport.
 *
 * 50 sits between the two page sizes that matter: the default 25-row page keeps
 * growing naturally, a 100-row page virtualizes.
 */
export const GRID_VIRTUALIZATION_ROW_THRESHOLD = 50;

/** Rows visible at once in a virtualized viewport, before scrolling. */
export const GRID_VIRTUALIZED_VISIBLE_ROWS = 12;

/** MUI X row heights per density preset, in px. */
export const GRID_ROW_HEIGHT: Record<DataTableDensity, number> = {
  compact: 36,
  standard: 52,
  comfortable: 67,
};

/** Column header (56px) + footer (53px) — the chrome a viewport must also fit. */
export const GRID_CHROME_HEIGHT = 109;

/** The height a virtualized viewport takes when the caller supplied none. */
export function virtualizedViewportHeight(
  density: DataTableDensity,
  rowCount: number,
  visibleRows: number = GRID_VIRTUALIZED_VISIBLE_ROWS,
): number {
  const rowHeight = GRID_ROW_HEIGHT[density] ?? GRID_ROW_HEIGHT.standard;
  return Math.min(rowCount, visibleRows) * rowHeight + GRID_CHROME_HEIGHT;
}

export interface GridVirtualizationPlan {
  /** Whether DataGrid's row virtualization is enabled for this render. */
  virtualized: boolean;
  /** What to pass as the grid's `autoHeight`. */
  autoHeight: boolean;
  /** Height for the scroll container, or `undefined` for auto-height. */
  height: number | string | undefined;
}

export interface GridVirtualizationInput {
  /** Rows handed to the grid, INCLUDING any synthetic tablet detail rows. */
  rowCount: number;
  /** The caller's explicit `height` prop, if any. */
  height?: number | string;
  density: DataTableDensity;
  /** Override for tests / unusual hosts. */
  threshold?: number;
}

/**
 * Decide how this render sizes itself, and therefore whether rows virtualize.
 *
 * Three cases:
 *
 * 1. **An explicit `height`** — the caller already asked for an internally
 *    scrolling body, so virtualization is on and nothing is overridden.
 * 2. **More loaded rows than the threshold** — auto-height is dropped in favour
 *    of a computed viewport so the grid may virtualize.
 * 3. **Anything else** — auto-height, unchanged from #252. The table grows with
 *    its rows and the page scrolls.
 */
export function planGridVirtualization({
  rowCount,
  height,
  density,
  threshold = GRID_VIRTUALIZATION_ROW_THRESHOLD,
}: GridVirtualizationInput): GridVirtualizationPlan {
  if (height != null) return { virtualized: true, autoHeight: false, height };
  if (rowCount > threshold) {
    return {
      virtualized: true,
      autoHeight: false,
      height: virtualizedViewportHeight(density, rowCount),
    };
  }
  return { virtualized: false, autoHeight: true, height: undefined };
}
