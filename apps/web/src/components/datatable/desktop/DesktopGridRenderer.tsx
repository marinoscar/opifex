/**
 * DataTable — grid renderer (MUI X DataGrid). Serves TWO layouts.
 *
 * Everything is server-driven: pagination, sorting and the row set all come in
 * as controlled props and every user gesture is reported back out. The grid
 * itself never sorts, filters, or paginates a row — it only draws what it is
 * handed. That is what makes the same contract work against a 150k-item
 * library where client-side anything is off the table.
 *
 * `variant` selects between the two grid layouts:
 *
 *   - `'desktop'` — every column visible.
 *   - `'tablet'`  — `detail`-priority columns hidden, and a leading expander
 *     column that reveals them as label/value pairs in an expanded row. This
 *     is the intermediate case: still a real grid, but nothing it hides becomes
 *     unreachable. See `./detailRow.tsx` for why expansion is built from
 *     synthetic rows rather than `getDetailPanelContent` (a Pro-only feature).
 *
 * When `variant` is omitted the renderer falls back to its historical
 * viewport-based behaviour, so using it directly (outside `DataTable`) still
 * works.
 *
 * ## Row virtualization (#256)
 *
 * DataGrid virtualizes rows for free — but not while `autoHeight` is on, which
 * is this table's default sizing. `virtualization/gridVirtualization.ts` decides
 * per render whether to trade auto-height for a bounded viewport (past a
 * loaded-row threshold, or whenever the caller passed an explicit `height`), and
 * the decision is published as `data-virtualized` on the scroll container.
 */

import { useCallback, useMemo, useState } from 'react';
import {
  DataGrid,
  type GridColDef,
  type GridPaginationModel,
  type GridRenderCellParams,
  type GridRowId,
  type GridRowSelectionModel,
  type GridSortModel,
  type GridValidRowModel,
} from '@mui/x-data-grid';
import {
  GRID_CHECKBOX_SELECTION_FIELD,
  gridRowSelectionManagerSelector,
  useGridApiContext,
  useGridSelector,
} from '@mui/x-data-grid';
import {
  Alert,
  Box,
  Checkbox,
  IconButton,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import visuallyHidden from '@mui/utils/visuallyHidden';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight';
import type { DataTableRendererProps } from '../types';
import {
  buildColumnVisibilityModel,
  rowAccessibleName,
  toGridColumns,
} from './columnAdapter';

/**
 * The per-row selection checkbox.
 *
 * ## Why this is a COMPONENT, and why it subscribes
 *
 * It overrides DataGrid's own checkbox cell, whose built-in locale text names
 * every row's checkbox "Select row" — indistinguishable to a screen reader
 * with twenty rows on screen (issue #257). `checkboxColDef` is DataGrid's
 * public seam for that.
 *
 * What the first version got wrong, and what this fixes (issue #67): it was an
 * inline `<Checkbox checked={Boolean(params.value)} />` rendered straight from
 * `renderCell`. `params.value` is a SNAPSHOT — a custom cell renderer only
 * sees a fresh one when DataGrid happens to re-render that cell, and a
 * selection change on its own does not cause that. MUI's built-in checkbox
 * cell does not have the problem because it subscribes to the grid's selection
 * state internally; ours did not.
 *
 * The result was invisible in the component's own test suite (which asserts
 * the emitted id set, with a STATIC `selectedIds`) and invisible to any page
 * that rebuilt `columns` or `rowActions` on every render — the fresh column
 * identity forced the repaint by accident. It appeared the moment a page
 * memoized both, which is exactly what the migration guidance asks pages to
 * do: the bulk bar counted "1 of 2 selected" while the checkbox stayed
 * visually unchecked.
 *
 * Subscribing through `useGridSelector` is what MUI's own cell does, so the
 * checkbox now repaints on every selection change from any source — a click, a
 * select-all, or a controlled `selectedIds` set by the page.
 */
function SelectionCheckboxCell({
  id,
  label,
  tabIndex,
  size,
}: {
  id: GridRowId;
  label: string;
  tabIndex: 0 | -1 | null;
  size: 'small' | 'medium';
}) {
  const apiRef = useGridApiContext();
  const selectionManager = useGridSelector(
    apiRef,
    gridRowSelectionManagerSelector,
  );

  return (
    <Checkbox
      size={size}
      checked={selectionManager.has(id)}
      tabIndex={tabIndex ?? undefined}
      onClick={(event) => event.stopPropagation()}
      // Mirrors the built-in renderer: without this a Space press bubbles to
      // the grid's own cell keydown handler and can trigger a second toggle.
      onKeyDown={(event) => {
        if (event.key === ' ') event.stopPropagation();
      }}
      onChange={(event) => {
        apiRef.current.selectRow(id, event.target.checked, false);
      }}
      slotProps={{
        input: { 'aria-label': `Select ${label}`, name: 'select_row' },
      }}
    />
  );
}
import { DataTableEmptyOverlay, DataTableLoadingOverlay } from './cells';
import { RowActionsCell } from './RowActionsCell';
import { BulkActionBar } from '../BulkActionBar';
import { useRowActionConfirm } from '../shared/rowActionConfirm';
import { IndeterminateCheckbox } from '../shared/IndeterminateCheckbox';
import { planGridVirtualization } from '../virtualization/gridVirtualization';
import {
  DETAIL_ROW_CLASS,
  DETAIL_ROW_SOURCE,
  DetailRowPanel,
  EXPANDER_FIELD,
  detailRowHeight,
  detailRowId,
  isDetailRow,
  makeDetailRow,
} from './detailRow';

/** Field name of the synthetic trailing actions column. */
export const ACTIONS_FIELD = '__datatable_actions__';

const DEFAULT_PAGE_SIZE_OPTIONS = [10, 25, 50, 100];
/** MIT DataGrid caps a page at 100 rows. */
const MAX_UNPAGINATED_ROWS = 100;
const EMPTY_SELECTION: ReadonlySet<string> = new Set<string>();

export interface DesktopGridRendererProps<
  Row,
> extends DataTableRendererProps<Row> {
  /**
   * Which grid layout to draw. Omit to fall back to a viewport media query
   * (the pre-#253 behaviour) — `DataTable` always passes it explicitly.
   */
  variant?: 'desktop' | 'tablet';
}

export function DesktopGridRenderer<Row>({
  columns,
  rows,
  rowId,
  loading = false,
  error = null,
  emptyState,
  pagination,
  sort,
  selection,
  rowActions,
  bulkActions,
  density = 'standard',
  ariaLabel,
  height,
  variant,
  visibleColumnIds,
}: DesktopGridRendererProps<Row>) {
  const theme = useTheme();
  // Fallback only: `DataTable` resolves this from the CONTAINER width and
  // passes `variant` explicitly, so this media query never decides anything
  // for a table rendered through the public component.
  const viewportIsNarrow = useMediaQuery(theme.breakpoints.down('lg'));
  const isTablet = variant ? variant === 'tablet' : viewportIsNarrow;

  const { run: runAction, dialog: confirmDialog } = useRowActionConfirm<Row>();

  const selectable = selection ? (selection.selectable ?? true) : false;
  const selectedIds = selection?.selectedIds ?? EMPTY_SELECTION;

  // --- Row expansion (tablet only) ------------------------------------------

  // The `detail` columns the expander panel reveals — minus any the user has
  // hidden (#255). A column hidden on a desktop must not silently reappear
  // inside the tablet expander; hidden means hidden at every width.
  const detailColumns = useMemo(
    () =>
      columns.filter(
        (column) =>
          column.priority === 'detail' &&
          (!visibleColumnIds || visibleColumnIds.has(column.id)),
      ),
    [columns, visibleColumnIds],
  );
  // Nothing is hidden when there are no `detail` columns, so there is nothing
  // to expand and no expander column is added.
  const expandable = isTablet && detailColumns.length > 0;

  const [expandedIds, setExpandedIds] =
    useState<ReadonlySet<string>>(EMPTY_SELECTION);

  const toggleExpanded = useCallback((id: string) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // --- Rows -----------------------------------------------------------------

  const rowIds = useMemo(() => rows.map((row) => rowId(row)), [rows, rowId]);

  const gridRows = useMemo(() => {
    if (!expandable || expandedIds.size === 0) {
      return rows as unknown as readonly GridValidRowModel[];
    }
    const out: unknown[] = [];
    rows.forEach((row, index) => {
      out.push(row);
      const id = rowIds[index];
      if (expandedIds.has(id)) out.push(makeDetailRow(id, row));
    });
    return out as readonly GridValidRowModel[];
  }, [rows, rowIds, expandable, expandedIds]);

  const getRowId = useCallback(
    (row: GridValidRowModel) =>
      isDetailRow<Row>(row)
        ? detailRowId(row.__datatableDetailFor)
        : rowId(row as Row),
    [rowId],
  );

  const getRowHeight = useCallback(
    ({ model }: { model: GridValidRowModel }) =>
      isDetailRow<Row>(model) ? detailRowHeight(detailColumns.length) : null,
    [detailColumns.length],
  );

  // A synthetic row is a presentation artefact, never a selectable entity.
  const isRowSelectable = useCallback(
    ({ row }: { row: GridValidRowModel }) => !isDetailRow<Row>(row),
    [],
  );

  const getRowClassName = useCallback(
    ({ row }: { row: GridValidRowModel }) =>
      isDetailRow<Row>(row) ? DETAIL_ROW_CLASS : '',
    [],
  );

  // --- Columns --------------------------------------------------------------

  const gridColumns: GridColDef[] = useMemo(() => {
    const mapped = toGridColumns(columns);
    // The expander's `colSpan` must cover exactly the columns actually on
    // screen: the layout baseline AND the user's #255 visibility choice.
    const visibleDataColumnCount = columns.filter((column) => {
      if (isTablet && column.priority === 'detail') return false;
      return !visibleColumnIds || visibleColumnIds.has(column.id);
    }).length;

    const withActions: GridColDef[] = [...mapped];
    if (rowActions && rowActions.length > 0) {
      withActions.push({
        field: ACTIONS_FIELD,
        headerName: 'Actions',
        // Header text is visually redundant next to icon buttons but is what a
        // screen reader announces when navigating cells, so it stays.
        sortable: false,
        filterable: false,
        hideable: false,
        disableColumnMenu: true,
        align: 'right',
        headerAlign: 'right',
        width: rowActions.length === 1 ? 72 : 64,
        renderCell: (params) =>
          isDetailRow<Row>(params.row) ? null : (
            <RowActionsCell
              row={params.row as Row}
              actions={rowActions}
              // Disambiguates the button/menu name across rows — "Retry for
              // auto_tagging" rather than a bare "Retry" repeated on every row
              // (issue #257). Mirrors the card renderer, which has always
              // passed this.
              rowLabel={rowAccessibleName(
                columns,
                params.row as Row,
                String(params.id),
                visibleColumnIds,
              )}
              onRun={runAction}
            />
          ),
      });
    }

    if (!expandable) return withActions;

    // Every column the expander's spanned cell must cover: itself, the visible
    // data columns, and the actions column if present.
    const spannedColumns =
      1 + visibleDataColumnCount + (rowActions?.length ? 1 : 0);

    const expanderColumn: GridColDef = {
      field: EXPANDER_FIELD,
      headerName: '',
      // A column with no visible header text still needs a discernible name
      // (axe's `empty-table-header`, issue #257) — text that is visually
      // hidden but present for assistive tech, the same technique as the
      // filter bar's result-count live region.
      renderHeader: () => (
        <Box component="span" sx={visuallyHidden}>
          Row details
        </Box>
      ),
      sortable: false,
      filterable: false,
      hideable: false,
      resizable: false,
      disableColumnMenu: true,
      width: 48,
      align: 'center',
      headerAlign: 'center',
      colSpan: (_value, row) => (isDetailRow<Row>(row) ? spannedColumns : 1),
      renderCell: (params) => {
        if (isDetailRow<Row>(params.row)) {
          return (
            <DetailRowPanel
              row={params.row[DETAIL_ROW_SOURCE] as Row}
              columns={detailColumns}
            />
          );
        }
        const id = String(params.id);
        const open = expandedIds.has(id);
        // Disambiguated per row for the same reason the row-actions button is
        // (issue #257): several rows' expander buttons with the identical bare
        // name "Show details" are indistinguishable to a screen reader tabbing
        // through them.
        const rowLabel = rowAccessibleName(
          columns,
          params.row as Row,
          id,
          visibleColumnIds,
        );
        return (
          <IconButton
            size="small"
            aria-label={`${open ? 'Hide' : 'Show'} details for ${rowLabel}`}
            aria-expanded={open}
            data-testid="datatable-row-expander"
            // A tablet is a touch device, and this is the ONLY route to the
            // hidden `detail` columns — so it gets a comfortable target
            // wherever the row is tall enough to hold one. `compact` rows are
            // 36px, so they keep the grid's own density instead.
            sx={
              density === 'compact'
                ? undefined
                : { minWidth: 44, minHeight: 44 }
            }
            onClick={(event) => {
              event.stopPropagation();
              toggleExpanded(id);
            }}
          >
            {open ? (
              <KeyboardArrowDownIcon fontSize="small" />
            ) : (
              <KeyboardArrowRightIcon fontSize="small" />
            )}
          </IconButton>
        );
      },
    };

    return [expanderColumn, ...withActions];
  }, [
    columns,
    detailColumns,
    rowActions,
    runAction,
    expandable,
    expandedIds,
    toggleExpanded,
    isTablet,
    density,
    visibleColumnIds,
  ]);

  const columnVisibilityModel = useMemo(
    () =>
      buildColumnVisibilityModel(columns, {
        hideDetailColumns: isTablet,
        visibleColumns: visibleColumnIds,
      }),
    [columns, isTablet, visibleColumnIds],
  );

  // --- Pagination (server) --------------------------------------------------

  const paginationModel: GridPaginationModel = useMemo(
    () =>
      pagination
        ? { page: pagination.page, pageSize: pagination.pageSize }
        : {
            page: 0,
            pageSize: Math.min(
              Math.max(gridRows.length, 1),
              MAX_UNPAGINATED_ROWS,
            ),
          },
    [pagination, gridRows.length],
  );

  const handlePaginationModelChange = useCallback(
    (model: GridPaginationModel) => {
      pagination?.onPaginationChange({
        page: model.page,
        pageSize: model.pageSize,
      });
    },
    [pagination],
  );

  // --- Sorting (server) -----------------------------------------------------

  const sortModel: GridSortModel = useMemo(
    () =>
      sort?.sort ? [{ field: sort.sort.field, sort: sort.sort.direction }] : [],
    [sort],
  );

  const handleSortModelChange = useCallback(
    (model: GridSortModel) => {
      if (!sort) return;
      const next = model[0];
      if (!next || !next.sort) {
        sort.onSortChange(null);
        return;
      }
      sort.onSortChange({ field: next.field, direction: next.sort });
    },
    [sort],
  );

  // --- Selection ------------------------------------------------------------

  const rowSelectionModel: GridRowSelectionModel = useMemo(
    () => ({ type: 'include', ids: new Set<GridRowId>(selectedIds) }),
    [selectedIds],
  );

  const handleRowSelectionModelChange = useCallback(
    (model: GridRowSelectionModel) => {
      if (!selection) return;
      const ids = new Set(Array.from(model.ids, (id) => String(id)));
      if (model.type === 'include') {
        selection.onSelectionChange(ids);
        return;
      }
      // MUI X v9 reports "select all" as an *exclude* model: everything except
      // `ids`. With server-side pagination "everything" can only mean the rows
      // this table has actually loaded, so materialise it against the current
      // page rather than pretending we selected rows we have never seen.
      selection.onSelectionChange(new Set(rowIds.filter((id) => !ids.has(id))));
    },
    [selection, rowIds],
  );

  const clearSelection = useCallback(() => {
    selection?.onSelectionChange(new Set<string>());
  }, [selection]);

  const selectedIdList = useMemo(() => Array.from(selectedIds), [selectedIds]);

  // --- Row virtualization ---------------------------------------------------

  // MUI X disables row virtualization whenever `autoHeight` is on
  // (`enabledForRows: !disableVirtualization && !autoHeight && HAS_LAYOUT`), and
  // auto-height is this table's documented default. So past a threshold the grid
  // takes a bounded viewport instead — the only condition under which the
  // built-in virtualizer can actually run. `disableVirtualization` is left at
  // its default (false) throughout; see `virtualization/gridVirtualization.ts`.
  const virtualization = useMemo(
    () =>
      planGridVirtualization({ rowCount: gridRows.length, height, density }),
    [gridRows.length, height, density],
  );

  // --- Overlays -------------------------------------------------------------

  const slots = useMemo(
    () => ({
      noRowsOverlay: () => (
        <DataTableEmptyOverlay>{emptyState}</DataTableEmptyOverlay>
      ),
      loadingOverlay: () => <DataTableLoadingOverlay />,
      // Fixes a real axe violation (`aria-conditional-attr`, issue #257): the
      // grid's own header "select all" checkbox goes indeterminate but never
      // sets the native DOM property behind its `aria-checked="mixed"` — see
      // `shared/IndeterminateCheckbox.tsx`. `baseCheckbox` is DataGrid's own
      // public slot for this, not an internal reach-around.
      baseCheckbox: IndeterminateCheckbox,
    }),
    [emptyState],
  );

  // --- Selection checkbox column ---------------------------------------------

  /**
   * Overrides DataGrid's own per-row checkbox cell, whose built-in locale text
   * is the single static string "Select row" for EVERY row on the grid (see
   * `@mui/x-data-grid`'s `checkboxSelectionSelectRow`) — indistinguishable to a
   * screen reader tabbing through them, and the exact bug this issue (#257)
   * requires fixing. `checkboxColDef` is DataGrid's public, documented
   * extension point for this (merged into `GRID_CHECKBOX_SELECTION_COL_DEF`
   * rather than replacing it), so this stays forward-compatible rather than
   * reaching into an internal component.
   *
   * `params.value` is already the selection boolean (the built-in column's own
   * `valueGetter` calls `apiRef.current.isRowSelected`), so no extra selector
   * plumbing is needed. The `onKeyDown` guard mirrors the built-in renderer:
   * without it, a Space press bubbles to the grid's own cell keydown handler
   * and can trigger a second, redundant toggle/scroll.
   */
  const checkboxColDef = useMemo(
    () =>
      selectable
        ? {
            renderCell: (params: GridRenderCellParams) => {
              if (isDetailRow<Row>(params.row)) return null;
              const row = params.row as Row;
              const label = rowAccessibleName(
                columns,
                row,
                String(params.id),
                visibleColumnIds,
              );
              return (
                <SelectionCheckboxCell
                  id={params.id}
                  label={label}
                  tabIndex={params.tabIndex}
                  size={density === 'compact' ? 'small' : 'medium'}
                />
              );
            },
          }
        : undefined,
    [selectable, columns, visibleColumnIds, density],
  );

  return (
    <Box sx={{ width: '100%', maxWidth: '100%', minWidth: 0 }}>
      {error && (
        <Alert severity="error" sx={{ mb: 1 }} data-testid="datatable-error">
          {error}
        </Alert>
      )}

      {selectable && (
        <BulkActionBar
          ids={selectedIdList}
          actions={bulkActions}
          onClear={clearSelection}
          // Page-scoped, like the selection itself (§5.3): "3 of 47 selected"
          // means 3 of the 47 rows loaded on THIS page, not the server total.
          total={rowIds.length}
        />
      )}

      {/*
        Non-negotiable: wide content scrolls HERE, never on <body>. The grid
        already owns a horizontal virtual scroller; `minWidth: 0` is what stops
        a flex parent from letting this box grow past the viewport, and
        `overflowX: 'auto'` contains anything the grid itself does not.
      */}
      <Box
        data-testid="datatable-scroll-container"
        // Whether the grid's own row virtualization is live for this render.
        // jsdom never lays out, so MUI X keeps it off in tests regardless —
        // this attribute is how the DECISION stays assertable.
        data-virtualized={virtualization.virtualized ? 'true' : 'false'}
        sx={{
          width: '100%',
          maxWidth: '100%',
          minWidth: 0,
          overflowX: 'auto',
          ...(virtualization.height != null
            ? { height: virtualization.height }
            : {}),
        }}
      >
        <DataGrid
          rows={gridRows}
          columns={gridColumns}
          getRowId={getRowId}
          loading={loading}
          density={density}
          aria-label={ariaLabel}
          autoHeight={virtualization.autoHeight}
          columnVisibilityModel={columnVisibilityModel}
          disableColumnFilter
          disableColumnMenu
          disableRowSelectionOnClick
          {...(expandable
            ? { getRowHeight, isRowSelectable, getRowClassName }
            : {})}
          // Pagination — server-side.
          paginationMode="server"
          rowCount={pagination?.total ?? rows.length}
          paginationModel={paginationModel}
          onPaginationModelChange={handlePaginationModelChange}
          pageSizeOptions={
            pagination?.pageSizeOptions ?? DEFAULT_PAGE_SIZE_OPTIONS
          }
          hideFooter={!pagination}
          // Sorting — server-side.
          sortingMode="server"
          sortModel={sortModel}
          onSortModelChange={handleSortModelChange}
          // Selection.
          checkboxSelection={selectable}
          checkboxColDef={checkboxColDef}
          rowSelectionModel={rowSelectionModel}
          onRowSelectionModelChange={handleRowSelectionModelChange}
          slots={slots}
          sx={{
            minWidth: 0,
            // Keep the grid's own scroller the horizontal scroll owner.
            '& .MuiDataGrid-virtualScroller': { overflowX: 'auto' },
            '& .MuiDataGrid-cell:focus, & .MuiDataGrid-cell:focus-within': {
              outlineOffset: -2,
            },
            // The expanded panel owns its whole cell, with no cell padding.
            [`& .MuiDataGrid-cell[data-field="${EXPANDER_FIELD}"]`]: { p: 0 },
            // A detail row is not a row of data: drop the grid's own selection
            // checkbox from it entirely (see DETAIL_ROW_CLASS for why this is
            // `display: none` and not `opacity: 0`).
            [`& .${DETAIL_ROW_CLASS} .MuiDataGrid-cell[data-field="${GRID_CHECKBOX_SELECTION_FIELD}"] .MuiCheckbox-root`]:
              { display: 'none' },
          }}
        />
      </Box>

      {confirmDialog}
    </Box>
  );
}
