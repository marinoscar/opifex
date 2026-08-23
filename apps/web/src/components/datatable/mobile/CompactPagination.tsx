/**
 * DataTable — compact pagination (card layout).
 *
 * `TablePagination` is the wrong control on a phone: rows-per-page select +
 * "1–25 of 137" + two arrows + the grid's own footer padding come to roughly
 * 420px of intrinsic width, so on a 360px screen it either overflows the card
 * column or forces the whole table into a horizontal scroller — which is
 * precisely the failure the card layout exists to remove.
 *
 * This replaces it with prev / range / next. Page size is not adjustable here:
 * it is a desktop-scale concern (nobody sets 100-per-page on a phone) and the
 * owning page can still change it programmatically, since pagination stays
 * fully controlled.
 */

import { Box, IconButton, Typography } from '@mui/material';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import type { DataTablePaginationConfig } from '../types';

export interface CompactPaginationProps {
  pagination: DataTablePaginationConfig;
  /** Rows actually rendered on this page, used to close the displayed range. */
  loadedRows: number;
}

export function CompactPagination({
  pagination,
  loadedRows,
}: CompactPaginationProps) {
  const { page, pageSize, total, onPaginationChange } = pagination;

  const pageCount = pageSize > 0 ? Math.max(1, Math.ceil(total / pageSize)) : 1;
  const first = total === 0 ? 0 : page * pageSize + 1;
  // Trust the row count we actually have over arithmetic on a possibly-stale
  // `total` — a short final page must not claim rows it never rendered.
  const last =
    total === 0
      ? 0
      : page * pageSize + Math.min(loadedRows || pageSize, pageSize);

  const atStart = page <= 0;
  const atEnd = page >= pageCount - 1;

  const go = (next: number) => onPaginationChange({ page: next, pageSize });

  return (
    <Box
      data-testid="datatable-compact-pagination"
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 1,
        mt: 1.5,
        minWidth: 0,
        maxWidth: '100%',
      }}
    >
      <IconButton
        aria-label="Go to previous page"
        disabled={atStart}
        onClick={() => go(page - 1)}
        sx={{ minWidth: 44, minHeight: 44 }}
      >
        <ChevronLeftIcon />
      </IconButton>

      <Typography
        variant="body2"
        color="text.secondary"
        aria-live="polite"
        sx={{ textAlign: 'center', minWidth: 0, overflowWrap: 'anywhere' }}
      >
        {total === 0 ? 'No results' : `${first}–${last} of ${total}`}
      </Typography>

      <IconButton
        aria-label="Go to next page"
        disabled={atEnd}
        onClick={() => go(page + 1)}
        sx={{ minWidth: 44, minHeight: 44 }}
      >
        <ChevronRightIcon />
      </IconButton>
    </Box>
  );
}
