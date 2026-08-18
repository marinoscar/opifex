/**
 * DataTable — public component.
 *
 * A thin layout-switch shell over one shared column contract. It resolves ONE
 * of three layouts from the table's own container width and hands the same
 * `DataTableRendererProps` to whichever renderer serves it:
 *
 *   | layout    | renderer module              | `detail` columns          |
 *   | --------- | ---------------------------- | ------------------------- |
 *   | `mobile`  | `mobile/CardListRenderer`    | collapsed "More details"  |
 *   | `tablet`  | `desktop/DesktopGridRenderer`| hidden; row expansion     |
 *   | `desktop` | `desktop/DesktopGridRenderer`| visible                   |
 *
 * ## Container width, not viewport width
 *
 * The switch measures THIS table's wrapper. A DataTable in a 400px drawer on a
 * 1440px desktop gets cards; a viewport media query would give it the desktop
 * grid and it would be unusable. See `useContainerLayout.ts` for the mechanics
 * and the pre-measurement fallback.
 *
 * ## State lives above the renderers
 *
 * Selection, pagination, sort and filters are all controlled props owned by the
 * calling page. Nothing a user chose is stored inside a renderer, so rotating a
 * device, dragging a drawer wider, or resizing a window swaps the layout without
 * losing a single selected id, the current page, the active sort, or an applied
 * filter. The only state a renderer owns is which rows/cards happen to be
 * expanded right now — pure presentation, and meaningless in the layout being
 * switched to.
 *
 * ## The filter surface belongs here, not to a renderer
 *
 * `DataTableFilterBar` is drawn by this component, above whichever renderer is
 * active, because filtering is the one control whose SHAPE is decided by the
 * layout (a row / a collapsed panel / a full-screen sheet) rather than by how
 * rows are presented — and because a renderer owning the panel's open state
 * would discard it on every resize.
 *
 * `DataTableViewBar` (column visibility + density, #255) sits here for exactly
 * the same two reasons — and one more: the visible column SET must be resolved
 * once, from the layout baseline and the user's stored choice together, so the
 * two renderers can never disagree about which columns exist. It is also the one
 * bar that can be absent: see {@link shouldRenderViewBar} for why a table that
 * has definitively resolved to zero rows shows its empty state alone (#438).
 *
 * `DataTableExportControl` (CSV export, #256) rides in that bar's trailing slot
 * on the same logic: one code path serves every renderer, so a phone and a
 * desktop download byte-identical files, and the control's SHAPE (a button, or
 * an overflow menu at 360px) is the only thing the layout decides.
 *
 * ## `filterOnly` columns (#258)
 *
 * This is also the ONE seam where the filter surface and everything else see a
 * different column list. A `filterOnly` column is a query parameter with no
 * cell — `processedWithin` on the job queue is a window over
 * `COALESCE(finishedAt, createdAt)`, not a field — so the filter bar gets the
 * full declaration while the view bar, the export control, the layout-prefs
 * hook and both renderers get the drawable subset. Splitting here rather than
 * in five consumers is what keeps `filterOnly` a one-line contract addition.
 *
 * ## Layout persistence
 *
 * Supplying `tableId` stores the resolved layout under
 * `user_settings.dataTables[tableId]`; omitting it keeps every control working
 * but session-scoped. In-session state is authoritative either way — the write
 * is debounced and fire-and-forget, and its outcome never feeds back into what
 * is on screen. See `layout/useDataTableLayoutPrefs.ts`.
 */

import { useMemo, useRef } from 'react';
import { Box } from '@mui/material';
import type {
  DataTableColumn,
  DataTableFilterModel,
  DataTableLayout,
  DataTableProps,
  DataTableRendererKind,
  DataTableRendererMode,
} from './types';
import { DesktopGridRenderer } from './desktop/DesktopGridRenderer';
import { CardListRenderer } from './mobile/CardListRenderer';
import { DataTableFilterBar } from './filter/DataTableFilterBar';
import { DataTableViewBar } from './layout/DataTableViewBar';
import { DataTableExportControl } from './export/DataTableExportControl';
import { useDataTableLayoutPrefs } from './layout/useDataTableLayoutPrefs';
import { useDataTableLayout, useViewportLayout } from './useContainerLayout';

/** Stable identity so an unfiltered table never re-renders the bar needlessly. */
const NO_FILTERS: DataTableFilterModel = [];

/**
 * The columns that are actually DRAWN — everything except `filterOnly` ones.
 *
 * Returns the input array unchanged when no column opts out, so the common case
 * costs one `some()` and keeps its referential identity (a fresh array here
 * would invalidate every downstream `useMemo` keyed on `columns`).
 */
export function drawableColumns<Row>(
  columns: DataTableColumn<Row>[],
): DataTableColumn<Row>[] {
  return columns.some((column) => column.filterOnly)
    ? columns.filter((column) => !column.filterOnly)
    : columns;
}

/** The inputs that decide whether the view bar has anything to be about. */
export interface ViewBarVisibilityInput {
  rowCount: number;
  loading?: boolean;
  /** `true` when a filter or a quick-search term is currently applied. */
  hasActiveQuery: boolean;
  /** `pagination.total`, when the page is paginated at all. */
  total?: number;
}

/**
 * Whether the view bar is drawn (#438).
 *
 * The bar is chrome ABOUT rows — pick columns, set density, export. With no
 * rows it is chrome about nothing: the node-credentials table shipped a
 * "View" button opening a column picker for a table with no columns on screen,
 * plus a permanently-disabled export kebab, floating above "No node credentials
 * yet". The empty state is the whole message at that point.
 *
 * Three cases are deliberately NOT treated as empty, because in each of them
 * hiding the bar is either a lie or a layout jump:
 *
 *  - **`loading`** — a page that clears `rows` while refetching would otherwise
 *    flash the bar out and back on every poll. Both #258's job queue and #259's
 *    worker nodes render unconditionally through a 5s auto-refresh precisely to
 *    avoid remount churn (docs/specs/datatable.md §18.4); this must not
 *    reintroduce it one row higher.
 *  - **an active filter or quick search** — zero rows is then a RESULT, not an
 *    empty table. The controls must stay put while the user narrows a query,
 *    and the bar disappearing the moment a filter matches nothing is the worst
 *    possible moment for the layout to shift.
 *  - **`pagination.total > 0`** — the table HAS rows, this page just isn't
 *    showing any (a stale page index past the end). Export's "all matching
 *    rows" scope is still meaningful.
 */
export function shouldRenderViewBar({
  rowCount,
  loading,
  hasActiveQuery,
  total,
}: ViewBarVisibilityInput): boolean {
  if (rowCount > 0) return true;
  if (loading) return true;
  if (hasActiveQuery) return true;
  return (total ?? 0) > 0;
}

/**
 * The card-list registration. This is the seam #252 left behind; it now points
 * at the real renderer.
 */
const MOBILE_RENDERER = CardListRenderer;

/** Which renderer module serves a given layout. */
export function rendererForLayout(layout: DataTableLayout): DataTableRendererKind {
  return layout === 'mobile' ? 'mobile' : 'desktop';
}

/**
 * Viewport-based renderer resolution.
 *
 * Retained as the public, ref-free helper (and used as the layout hook's
 * pre-measurement fallback). Prefer `DataTable`'s own container-driven switch:
 * this one cannot see that its table is inside a narrow drawer.
 */
export function useDataTableRenderer(
  mode: DataTableRendererMode = 'auto',
): DataTableRendererKind {
  const viewportLayout = useViewportLayout();
  if (mode !== 'auto') return rendererForLayout(mode);
  return rendererForLayout(viewportLayout);
}

export function DataTable<Row>(props: DataTableProps<Row>) {
  const {
    renderer = 'auto',
    mobileBreakpoint,
    tabletBreakpoint,
    filters,
    onFiltersChange,
    quickSearch,
    tableId,
    csvExport,
    disableExport = false,
    density: densityProp,
    'data-testid': testId,
    ...rendererProps
  } = props;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const layout = useDataTableLayout(containerRef, renderer, {
    mobile: mobileBreakpoint,
    tablet: tabletBreakpoint,
  });
  const mode = rendererForLayout(layout);

  // The filter bar sees every declared column; everything that paints, picks or
  // exports a column sees only the drawable ones (#258).
  const painted = useMemo(() => drawableColumns(props.columns), [props.columns]);

  // Zero rows with nothing applied and nothing in flight: the view bar is
  // chrome about rows that do not exist, so the empty state stands alone
  // (#438). The renderers below are untouched — they own the empty state.
  const viewBarVisible = shouldRenderViewBar({
    rowCount: props.rows.length,
    loading: props.loading,
    hasActiveQuery: (filters?.length ?? 0) > 0 || Boolean(quickSearch?.value),
    total: props.pagination?.total,
  });

  const prefs = useDataTableLayoutPrefs({
    tableId,
    columns: painted,
    layout,
    densityProp,
    sort: props.sort,
    pagination: props.pagination,
  });

  return (
    <Box
      ref={containerRef}
      data-testid={testId ?? 'datatable'}
      // `data-renderer` is which module drew this (two values); `data-layout`
      // is which of the three layouts it drew. Both are test hooks and
      // debugging aids.
      data-renderer={mode}
      data-layout={layout}
      // The effective density, after the user's own choice has overridden the
      // page's default — the one place both renderers' density is observable.
      data-density={prefs.density}
      // The horizontal-containment contract starts here: no DataTable may ever
      // make the document body scroll sideways, at any viewport width.
      sx={{ width: '100%', maxWidth: '100%', minWidth: 0 }}
    >
      {viewBarVisible && (
        <DataTableViewBar
          columns={painted}
          layout={layout}
          visibleColumnIds={prefs.userVisibleColumnIds}
          density={prefs.density}
          onToggleColumn={prefs.toggleColumn}
          onDensityChange={prefs.setDensity}
          onReset={prefs.reset}
          trailing={
            disableExport ? undefined : (
              <DataTableExportControl
                layout={layout}
                columns={painted}
                rows={props.rows}
                // The USER's choice, not the layout's fold: a `detail` column the
                // tablet tucks into its row expander is still on screen, so a CSV
                // must not change shape because the window got narrower.
                visibleColumnIds={prefs.userVisibleColumnIds}
                config={csvExport}
                filenameBase={csvExport?.filename ?? tableId ?? props.ariaLabel}
                total={props.pagination?.total}
              />
            )
          }
        />
      )}

      <DataTableFilterBar
        columns={props.columns}
        layout={layout}
        filters={filters ?? NO_FILTERS}
        onFiltersChange={onFiltersChange}
        quickSearch={quickSearch}
        resultCount={props.pagination?.total}
      />

      {mode === 'mobile' ? (
        <MOBILE_RENDERER
          {...rendererProps}
          columns={painted}
          density={prefs.density}
          visibleColumnIds={prefs.userVisibleColumnIds}
        />
      ) : (
        <DesktopGridRenderer
          {...rendererProps}
          columns={painted}
          density={prefs.density}
          visibleColumnIds={prefs.userVisibleColumnIds}
          variant={layout === 'tablet' ? 'tablet' : 'desktop'}
        />
      )}
    </Box>
  );
}
