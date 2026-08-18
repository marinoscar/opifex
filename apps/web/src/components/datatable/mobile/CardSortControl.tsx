/**
 * DataTable — card-layout sort control.
 *
 * A card has no column header to click, so without this the sort a page
 * declares would be *held* correctly across a layout switch (it lives above the
 * renderers) but would be unreachable while the phone layout is active. That is
 * a worse outcome than the grid's, so the card list gets an explicit control:
 * a field picker plus a direction toggle.
 *
 * Only columns declaring `sortable: true` appear — same rule as the grid, where
 * a non-sortable header is inert. "Default" maps to `onSortChange(null)`, the
 * contract's "back to the server's own order".
 */

import { Box, IconButton, MenuItem, TextField, Tooltip } from '@mui/material';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import type { DataTableColumn, DataTableSortConfig } from '../types';

const DEFAULT_VALUE = '__default__';

export interface CardSortControlProps<Row> {
  columns: DataTableColumn<Row>[];
  sort: DataTableSortConfig;
}

export function CardSortControl<Row>({ columns, sort }: CardSortControlProps<Row>) {
  const sortable = columns.filter((column) => column.sortable);
  if (sortable.length === 0) return null;

  const current = sort.sort;
  const direction = current?.direction ?? 'asc';

  return (
    <Box
      data-testid="datatable-card-sort"
      sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5, minWidth: 0 }}
    >
      <TextField
        select
        size="small"
        label="Sort by"
        value={current?.field ?? DEFAULT_VALUE}
        onChange={(event) => {
          const value = event.target.value;
          if (value === DEFAULT_VALUE) {
            sort.onSortChange(null);
            return;
          }
          sort.onSortChange({ field: value, direction });
        }}
        sx={{ flexGrow: 1, minWidth: 0 }}
        slotProps={{ htmlInput: { 'aria-label': 'Sort by' } }}
      >
        <MenuItem value={DEFAULT_VALUE}>Default</MenuItem>
        {sortable.map((column) => (
          <MenuItem key={column.id} value={column.id}>
            {column.label}
          </MenuItem>
        ))}
      </TextField>

      <Tooltip title={direction === 'asc' ? 'Sort ascending' : 'Sort descending'}>
        <span>
          <IconButton
            aria-label={
              direction === 'asc' ? 'Sorted ascending, switch to descending' : 'Sorted descending, switch to ascending'
            }
            disabled={!current}
            onClick={() =>
              current &&
              sort.onSortChange({
                field: current.field,
                direction: current.direction === 'asc' ? 'desc' : 'asc',
              })
            }
            sx={{ minWidth: 44, minHeight: 44 }}
          >
            {direction === 'asc' ? <ArrowUpwardIcon /> : <ArrowDownwardIcon />}
          </IconButton>
        </span>
      </Tooltip>
    </Box>
  );
}
