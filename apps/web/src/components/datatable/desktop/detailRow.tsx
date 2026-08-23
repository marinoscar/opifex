/**
 * DataTable — tablet row expansion.
 *
 * The intermediate case, and the one that is easiest to skip: between the
 * mobile and desktop breakpoints the grid is still the right control (rows are
 * scannable at 800px in a way cards are not), but it cannot show every column,
 * so `detail`-priority columns fold away. Folding them away with no way back
 * makes them *unreachable* rather than *deprioritised* — which is a data-loss
 * bug dressed up as responsive design.
 *
 * ## Why synthetic rows rather than a detail panel
 *
 * MUI X's `getDetailPanelContent` is declared on the community `DataGrid`'s
 * prop types but is **not implemented** in the MIT package (grep the built
 * package: the only occurrence is in `propTypes`). It is a Pro feature.
 *
 * So expansion is built from two primitives the MIT grid *does* implement:
 *
 *   1. A synthetic row is spliced in directly after its parent when that
 *      parent is expanded. It carries the parent row on a symbol-ish key so
 *      nothing in the caller's `Row` type can collide with it.
 *   2. The leading expander column declares `colSpan` covering every visible
 *      column for that synthetic row, so one cell renders the whole panel.
 *
 * `paginationMode="server"` is what makes this safe: the grid never slices the
 * `rows` array in server mode (`gridPaginationRowRangeSelector` short-circuits
 * unless client-side pagination is enabled), so injecting a row cannot push a
 * real row onto a phantom next page.
 */

import type { ReactNode } from 'react';
import { Box, Stack, Typography } from '@mui/material';
import type { DataTableColumn } from '../types';
import { extractColumnValue, formatColumnValue } from './columnAdapter';

/** Field name of the synthetic leading expander column. */
export const EXPANDER_FIELD = '__datatable_expander__';

/**
 * Class applied to a synthetic detail row.
 *
 * Used to suppress the grid's own selection checkbox on that row. `colSpan`
 * only ever spans *forward*, and DataGrid injects `__check__` ahead of every
 * user column, so the one cell the panel cannot absorb has to be dealt with in
 * CSS. It is removed with `display: none` — not `opacity: 0` — precisely so it
 * leaves the accessibility tree and stops being hit-testable, rather than
 * becoming the invisible-but-tappable control issue #243 was filed about.
 */
export const DETAIL_ROW_CLASS = 'datatable-detail-row';

/** Key marking a synthetic detail row; also holds the parent's row id. */
export const DETAIL_ROW_KEY = '__datatableDetailFor';
/** Key holding the parent row object on a synthetic detail row. */
export const DETAIL_ROW_SOURCE = '__datatableDetailSource';

export interface DetailRow<Row> {
  [DETAIL_ROW_KEY]: string;
  [DETAIL_ROW_SOURCE]: Row;
}

export function isDetailRow<Row>(row: unknown): row is DetailRow<Row> {
  return (
    typeof row === 'object' &&
    row !== null &&
    typeof (row as Record<string, unknown>)[DETAIL_ROW_KEY] === 'string'
  );
}

export function makeDetailRow<Row>(parentId: string, row: Row): DetailRow<Row> {
  return { [DETAIL_ROW_KEY]: parentId, [DETAIL_ROW_SOURCE]: row };
}

/** The grid row id for a synthetic detail row — namespaced so it cannot clash. */
export function detailRowId(parentId: string): string {
  return `__datatable_detail__${parentId}`;
}

/**
 * Row height for an expanded detail row.
 *
 * Computed rather than `getRowHeight: () => 'auto'` on purpose: auto-height
 * rows depend on a measurement pass, and a panel that measures 0px in a
 * layout-free environment (jsdom, a `display: none` ancestor) would clip its
 * own content. An arithmetic height is deterministic everywhere, and the panel
 * scrolls internally if a value is longer than the estimate.
 */
export function detailRowHeight(fieldCount: number): number {
  const HEADER_AND_PADDING = 24;
  const PER_FIELD = 46;
  return HEADER_AND_PADDING + Math.max(1, fieldCount) * PER_FIELD;
}

export interface DetailRowPanelProps<Row> {
  row: Row;
  columns: DataTableColumn<Row>[];
}

/**
 * The expanded region's content: the hidden `detail` columns as label/value
 * pairs, in declaration order — the same shape the card renderer's collapsed
 * region uses, so a value looks the same wherever it was folded away to.
 */
export function DetailRowPanel<Row>({
  row,
  columns,
}: DetailRowPanelProps<Row>) {
  return (
    <Box
      data-testid="datatable-row-detail-panel"
      sx={{
        width: '100%',
        height: '100%',
        minWidth: 0,
        overflow: 'auto',
        px: 2,
        py: 1.5,
        bgcolor: (theme) =>
          theme.palette.mode === 'dark'
            ? 'rgba(255, 255, 255, 0.04)'
            : 'rgba(0, 0, 0, 0.025)',
      }}
    >
      <Stack spacing={1.25} sx={{ minWidth: 0 }}>
        {columns.map((column) => {
          const content: ReactNode = column.render
            ? column.render(row)
            : formatColumnValue(extractColumnValue(column, row));
          return (
            <Box
              key={column.id}
              data-testid={`datatable-detail-field-${column.id}`}
              sx={{ minWidth: 0 }}
            >
              <Typography
                variant="caption"
                component="div"
                color="text.secondary"
                sx={{ fontWeight: 600 }}
              >
                {column.label}
              </Typography>
              <Typography
                variant="body2"
                component="div"
                sx={{ minWidth: 0, overflowWrap: 'anywhere' }}
              >
                {content}
              </Typography>
            </Box>
          );
        })}
      </Stack>
    </Box>
  );
}
