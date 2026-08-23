/**
 * DataTable — desktop column adapter.
 *
 * Maps the renderer-agnostic {@link DataTableColumn} contract onto MUI X
 * `GridColDef`. This is the ONLY place that knows about DataGrid's column
 * shape: the mobile card renderer (#253) reads the same `DataTableColumn`
 * objects directly and never sees a `GridColDef`.
 *
 * Deliberately JSX-free (`createElement`) so it stays a `.ts` mapping module —
 * cell components live in `./cells.tsx`.
 */

import { createElement } from 'react';
import type { ReactNode } from 'react';
import type { GridColDef, GridColumnVisibilityModel } from '@mui/x-data-grid';
import type { DataTableColumn } from '../types';
import { TruncatedCell } from './cells';

/** Minimum width applied to a flexing column that declares no `minWidth`. */
export const DEFAULT_COLUMN_MIN_WIDTH = 120;

/**
 * Extract the scalar behind a cell.
 *
 * Order of precedence:
 *   1. the column's explicit `value` extractor,
 *   2. `row[column.id]` when the row happens to carry that key,
 *   3. `null`.
 *
 * Non-scalar fallbacks (booleans, Dates, objects) are coerced to something
 * sortable/exportable rather than leaking a live object into the grid.
 */
export function extractColumnValue<Row>(
  column: DataTableColumn<Row>,
  row: Row,
): string | number | null {
  if (column.value) {
    return column.value(row);
  }
  const record = row as unknown as Record<string, unknown> | null | undefined;
  const raw = record == null ? undefined : record[column.id];
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string' || typeof raw === 'number') return raw;
  if (typeof raw === 'boolean') return raw ? 'true' : 'false';
  if (raw instanceof Date) return raw.toISOString();
  return String(raw);
}

/**
 * The scalar rendered as display text (`null`/empty becomes an em dash).
 *
 * Shared with the card renderer so an empty cell reads identically in both
 * layouts — a blank card field and an em-dashed grid cell would look like two
 * different states of the data.
 */
export function formatColumnValue(value: string | number | null): string {
  return value === null || value === '' ? '—' : String(value);
}

/** @deprecated internal alias kept for readability inside this module. */
const displayText = formatColumnValue;

/**
 * The accessible name for ONE row, shared by both renderers wherever a
 * control needs to disambiguate itself ("Select {row}", "Row actions for
 * {row}") — issue #257's accessibility pass.
 *
 * Derived from the first `primary` column still on screen (i.e. respecting
 * the user's #255 visibility choice, when supplied), mirroring exactly what a
 * user actually reads as "the row" in both the grid and the card headline
 * (`mobile/DataCard.tsx`'s `headlineText`). Falls back to the row id when
 * there is no primary column, or its scalar is null/empty — a bare em dash is
 * not a usable name.
 */
export function rowAccessibleName<Row>(
  columns: DataTableColumn<Row>[],
  row: Row,
  fallbackId: string,
  visibleColumnIds?: ReadonlySet<string>,
): string {
  const primary = columns.find(
    (column) =>
      column.priority === 'primary' &&
      (!visibleColumnIds || visibleColumnIds.has(column.id)),
  );
  if (!primary) return fallbackId;
  const text = formatColumnValue(extractColumnValue(primary, row));
  return text === '—' || text === '' ? fallbackId : text;
}

/**
 * Map one {@link DataTableColumn} to a `GridColDef`.
 *
 * Notable mapping decisions:
 * - `render` becomes `renderCell`, `value` becomes `valueGetter`, so DataGrid's
 *   own machinery (sort indicators, aria, copy-to-clipboard) sees the scalar
 *   while the user sees the rich cell.
 * - `sortable` defaults to **false**. Sorting is server-side, so an interactive
 *   header that nobody wired up would silently do nothing.
 * - `filterable` is hard-set to `false` on the grid side: DataGrid's built-in
 *   filtering is client-side and would only ever filter the current page. The
 *   `DataTableColumn.filterable` declaration is consumed by the server-backed
 *   filter UI in issue #254.
 */
export function toGridColDef<Row>(column: DataTableColumn<Row>): GridColDef {
  const align = column.align ?? 'left';

  const def: GridColDef = {
    field: column.id,
    headerName: column.label,
    align,
    headerAlign: align,
    sortable: column.sortable ?? false,
    hideable: column.hideable ?? true,
    // Grid-side (client) filtering is intentionally off — see #254.
    filterable: false,
    disableColumnMenu: true,
    valueGetter: (_value: unknown, row: unknown) =>
      extractColumnValue(column, row as Row),
  };

  // Sizing: an explicit width wins; otherwise the column flexes.
  if (column.width != null) {
    def.width = column.width;
    if (column.minWidth != null) def.minWidth = column.minWidth;
  } else {
    def.flex = column.flex ?? 1;
    def.minWidth = column.minWidth ?? DEFAULT_COLUMN_MIN_WIDTH;
  }

  const needsCustomCell = Boolean(column.render) || Boolean(column.truncate);
  if (needsCustomCell) {
    def.renderCell = (params) => {
      const row = params.row as Row;
      const scalar = extractColumnValue(column, row);
      const content: ReactNode = column.render
        ? column.render(row)
        : displayText(scalar);
      if (!column.truncate) return content;
      // TruncatedCellProps declares `children` as required, so the
      // three-argument createElement form does not typecheck against it
      // (TS2769). The rule is about JSX, where `children` as a prop is a
      // readability problem; this is a createElement call in a .ts file,
      // where props are the only place it can go.
      // eslint-disable-next-line react/no-children-prop
      return createElement(TruncatedCell, {
        title: scalar === null ? undefined : String(scalar),
        children: content,
      });
    };
  }

  return def;
}

/** Map a whole column set, preserving declaration order. */
export function toGridColumns<Row>(
  columns: DataTableColumn<Row>[],
): GridColDef[] {
  return columns.map((column) => toGridColDef(column));
}

/**
 * Column visibility for the grid.
 *
 * Two modes, and the difference is which question has already been answered:
 *
 * - `hideDetailColumns` — the LAYOUT baseline derived from `priority`: `detail`
 *   columns fold away once the grid is too narrow to show everything
 *   comfortably (they stay reachable through the row expander), while
 *   `primary`/`secondary` always stay.
 * - `visibleColumns` — the USER's persisted choice (#255), layout-independent.
 *   Omitted means "the user has hidden nothing", which is what a renderer used
 *   directly, outside `DataTable`, gets.
 *
 * The two are AND-ed, never overridden one by the other. A user's "hide this"
 * must win at every width; the tablet fold must survive a stored layout made on
 * a desktop, or a `detail` column marked visible there would reintroduce at
 * 800px exactly the horizontal scroll the fold exists to remove.
 */
export function buildColumnVisibilityModel<Row>(
  columns: DataTableColumn<Row>[],
  options: { hideDetailColumns: boolean; visibleColumns?: ReadonlySet<string> },
): GridColumnVisibilityModel {
  const model: GridColumnVisibilityModel = {};
  for (const column of columns) {
    const layoutShows = !(
      options.hideDetailColumns && column.priority === 'detail'
    );
    const userShows = options.visibleColumns
      ? options.visibleColumns.has(column.id)
      : true;
    model[column.id] = layoutShows && userShows;
  }
  return model;
}
