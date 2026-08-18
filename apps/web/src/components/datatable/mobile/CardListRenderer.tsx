/**
 * DataTable — mobile renderer (card list).
 *
 * Consumes the exact same `DataTableRendererProps` the desktop grid does, from
 * the exact same `DataTableColumn[]`. A page never declares a card layout: the
 * `priority` field it already wrote for the grid is what produces the headline,
 * the body, and the collapsed detail region.
 *
 * What is shared verbatim with the desktop renderer, rather than reimplemented:
 *   - `BulkActionBar` — identical selection UX at every width.
 *   - `useRowActionConfirm` — identical confirmation copy and one dialog per
 *     table, not one per card.
 *   - `RowActionsCell` — the same overflow menu, in `alwaysMenu` mode.
 *   - `DataTableEmptyOverlay` / `DataTableLoadingOverlay`.
 *
 * What is deliberately different:
 *   - Pagination is `CompactPagination`, not `TablePagination` (see that file).
 *   - Truncated values expand on tap rather than on hover — there is no hover.
 *
 * All of selection, pagination and sort remain CONTROLLED by the owning page,
 * so switching to or from this renderer is a pure presentation change: nothing
 * a user picked survives only in a renderer's own state.
 */

import { useCallback, useMemo } from 'react';
import { Alert, Box, FormControlLabel, Stack } from '@mui/material';
import type { DataTableRendererProps } from '../types';
import { BulkActionBar } from '../BulkActionBar';
import { DataTableEmptyOverlay, DataTableLoadingOverlay } from '../desktop/cells';
import { useRowActionConfirm } from '../shared/rowActionConfirm';
import { IndeterminateCheckbox } from '../shared/IndeterminateCheckbox';
import { DataCard } from './DataCard';
import { CompactPagination } from './CompactPagination';
import { CardSortControl } from './CardSortControl';
import { cardDensityMetrics } from '../layout/layoutModel';
import {
  shouldVirtualizeCards,
  useMeasuredCardHeight,
} from '../virtualization/cardVirtualization';

const EMPTY_SELECTION: ReadonlySet<string> = new Set<string>();

export function CardListRenderer<Row>({
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
  density,
  ariaLabel,
  height,
  visibleColumnIds,
}: DataTableRendererProps<Row>) {
  // A card list has no DataGrid to inherit density from, so it maps the same
  // setting onto its own metrics (padding, field gap, gap between cards).
  // Density that only worked on the grid would silently stop working on the
  // layout where vertical space is scarcest.
  const metrics = cardDensityMetrics(density);
  const selectable = selection ? (selection.selectable ?? true) : false;
  const selectedIds = selection?.selectedIds ?? EMPTY_SELECTION;

  const { run: runAction, dialog: confirmDialog } = useRowActionConfirm<Row>();

  // --- Columns, split by priority -------------------------------------------

  const { primaryColumns, secondaryColumns, detailColumns } = useMemo(() => {
    // The user's #255 choice is applied BEFORE the priority split, so a hidden
    // column disappears from a card exactly as it disappears from a grid — the
    // card layout folds `detail` columns away, it does not resurrect hidden
    // ones. No layout folding is AND-ed in here: a card already shows every
    // priority band, just in three different places.
    const shown = visibleColumnIds
      ? columns.filter((column) => visibleColumnIds.has(column.id))
      : columns;
    return {
      primaryColumns: shown.filter((column) => column.priority === 'primary'),
      secondaryColumns: shown.filter((column) => column.priority === 'secondary'),
      detailColumns: shown.filter((column) => column.priority === 'detail'),
    };
  }, [columns, visibleColumnIds]);

  // --- Selection ------------------------------------------------------------

  const rowIds = useMemo(() => rows.map((row) => rowId(row)), [rows, rowId]);

  const toggleRow = useCallback(
    (id: string) => {
      if (!selection) return;
      const next = new Set(selection.selectedIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      selection.onSelectionChange(next);
    },
    [selection],
  );

  const selectedOnPage = rowIds.filter((id) => selectedIds.has(id)).length;
  const allSelected = rowIds.length > 0 && selectedOnPage === rowIds.length;
  const someSelected = selectedOnPage > 0 && !allSelected;

  const toggleAll = useCallback(() => {
    if (!selection) return;
    // Page-scoped, exactly like the grid's header checkbox: with server-side
    // pagination "all" can only mean the ids this table has actually loaded.
    selection.onSelectionChange(allSelected ? new Set<string>() : new Set(rowIds));
  }, [selection, allSelected, rowIds]);

  const clearSelection = useCallback(() => {
    selection?.onSelectionChange(new Set<string>());
  }, [selection]);

  const selectedIdList = useMemo(() => Array.from(selectedIds), [selectedIds]);

  // --- Render skipping (#256) -----------------------------------------------

  // NOT a virtualizer: cards are variable-height and a wrong height estimate
  // makes scrolling jump (issue #237), which is worse than rendering every card.
  // Instead the browser is allowed to skip layout/paint for off-screen cards,
  // with a placeholder height MEASURED from a real card in this very table.
  const skipOffscreenCards = shouldVirtualizeCards(rows.length);
  const { measureRef, height: measuredCardHeight } = useMeasuredCardHeight(skipOffscreenCards);

  // --- Render ---------------------------------------------------------------

  const showEmpty = !loading && rows.length === 0;

  return (
    <Box
      data-testid="datatable-card-list"
      data-density={density ?? 'standard'}
      sx={{
        width: '100%',
        maxWidth: '100%',
        minWidth: 0,
        ...(height != null ? { height, overflowY: 'auto' } : {}),
      }}
    >
      {error && (
        <Alert severity="error" sx={{ mb: 1 }} data-testid="datatable-error">
          {error}
        </Alert>
      )}

      {sort && <CardSortControl columns={columns} sort={sort} />}

      {selectable && (
        <>
          <BulkActionBar
            ids={selectedIdList}
            actions={bulkActions}
            onClear={clearSelection}
            total={rowIds.length}
          />
          <FormControlLabel
            sx={{ ml: 0, mb: 0.5, minHeight: 44 }}
            control={
              <IndeterminateCheckbox
                checked={allSelected}
                indeterminate={someSelected}
                disabled={rowIds.length === 0}
                onChange={toggleAll}
                slotProps={{ input: { 'aria-label': 'Select all rows' } }}
                sx={{ minWidth: 44, minHeight: 44 }}
              />
            }
            // Visible text matches the accessible name (WCAG 2.5.3 "Label in
            // Name") AND matches the grid header checkbox's name verbatim, so
            // the two layouts are queryable — and speakable — identically.
            label="Select all rows"
          />
        </>
      )}

      {loading && rows.length === 0 && (
        <Box sx={{ height: 120, position: 'relative' }}>
          <DataTableLoadingOverlay />
        </Box>
      )}

      {showEmpty && <DataTableEmptyOverlay>{emptyState}</DataTableEmptyOverlay>}

      {rows.length > 0 && (
        <Box sx={{ position: 'relative', minWidth: 0 }}>
          <Stack
            component="ul"
            role="list"
            aria-label={ariaLabel}
            spacing={metrics.cardGap}
            sx={{ listStyle: 'none', m: 0, p: 0, minWidth: 0 }}
          >
            {rows.map((row, index) => {
              const id = rowIds[index];
              return (
                <DataCard
                  key={id}
                  row={row}
                  id={id}
                  primaryColumns={primaryColumns}
                  secondaryColumns={secondaryColumns}
                  detailColumns={detailColumns}
                  selectable={selectable}
                  selected={selectedIds.has(id)}
                  onToggleSelect={toggleRow}
                  rowActions={rowActions}
                  onRunAction={runAction}
                  density={density}
                  // The first card is the one being measured, so it never skips
                  // its own layout — and it is on screen by definition, so it
                  // would gain nothing by doing so.
                  measureRef={index === 0 ? measureRef : undefined}
                  skipOffscreen={skipOffscreenCards && index > 0}
                  intrinsicHeight={measuredCardHeight}
                />
              );
            })}
          </Stack>

          {/* A refetch dims the current cards rather than blanking the list —
              same promise the grid's loading overlay makes. */}
          {loading && (
            <Box sx={{ position: 'absolute', inset: 0, zIndex: 1 }}>
              <DataTableLoadingOverlay />
            </Box>
          )}
        </Box>
      )}

      {pagination && <CompactPagination pagination={pagination} loadedRows={rows.length} />}

      {confirmDialog}
    </Box>
  );
}
