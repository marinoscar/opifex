/**
 * DataTable — active filters, as removable chips.
 *
 * The chip strip is the only always-visible statement of *why* the table shows
 * what it shows. It is present in all three layouts because a filtered table
 * with no visible filter is the single most common way a user concludes their
 * data is missing.
 *
 * ## The one place a horizontal scroller is correct
 *
 * On a phone the strip scrolls sideways (`variant="strip"`) rather than
 * wrapping onto four lines above a card list. That does not contradict §6's
 * "the document must never scroll horizontally" rule — §6 is about a table
 * accidentally pushing the BODY wide. This is an explicit, discoverable,
 * self-contained control that owns its own overflow, and it is exactly what
 * issue #254 asks for.
 *
 * ## Chip keyboard semantics
 *
 * A MUI `Chip` with `onDelete` is itself focusable and responds to
 * Backspace/Delete — that is the library's a11y contract and the reason the
 * delete icon is not separately tabbable (it would double every tab stop). The
 * icon still carries an `aria-label` so the pointer target has a name.
 */

import { Box, Button, Chip } from '@mui/material';
import CancelIcon from '@mui/icons-material/Cancel';
import type { DataTableColumn, DataTableFilterModel } from '../types';
import { filterChipLabel, filterKey } from './filterModel';

export interface FilterChipsProps<Row> {
  filters: DataTableFilterModel;
  columns: DataTableColumn<Row>[];
  onRemove: (index: number) => void;
  onClearAll?: () => void;
  /**
   * `'wrap'` — chips flow onto multiple lines (desktop / tablet).
   * `'strip'` — one line, horizontally scrollable (phone).
   */
  variant?: 'wrap' | 'strip';
}

export function FilterChips<Row>({
  filters,
  columns,
  onRemove,
  onClearAll,
  variant = 'wrap',
}: FilterChipsProps<Row>) {
  if (filters.length === 0) return null;

  const strip = variant === 'strip';

  return (
    <Box
      data-testid={
        strip ? 'datatable-filter-chip-strip' : 'datatable-filter-chips'
      }
      role="list"
      aria-label="Active filters"
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        minWidth: 0,
        maxWidth: '100%',
        mt: 1,
        ...(strip
          ? {
              flexWrap: 'nowrap',
              overflowX: 'auto',
              // Scrolling is the point here; keep the momentum feel on iOS and
              // stop the strip from stealing vertical scroll.
              WebkitOverflowScrolling: 'touch',
              overscrollBehaviorX: 'contain',
              pb: 0.5,
            }
          : { flexWrap: 'wrap' }),
      }}
    >
      {filters.map((filter, index) => {
        const label = filterChipLabel(filter, columns);
        return (
          <Chip
            key={`${filterKey(filter)}#${index}`}
            role="listitem"
            label={label}
            size="medium"
            variant="outlined"
            color="primary"
            data-testid="datatable-filter-chip"
            onDelete={() => onRemove(index)}
            deleteIcon={
              <CancelIcon
                aria-label={`Remove filter: ${label}`}
                data-testid="datatable-filter-chip-remove"
              />
            }
            sx={{
              minHeight: 44,
              maxWidth: '100%',
              ...(strip ? { flex: '0 0 auto' } : {}),
              // The delete icon is the pointer target; give it a real one.
              '& .MuiChip-deleteIcon': { fontSize: 22, mr: 0.5 },
            }}
          />
        );
      })}

      {onClearAll && filters.length > 1 && (
        <Button
          size="small"
          onClick={onClearAll}
          data-testid="datatable-filter-clear-all"
          sx={{ minHeight: 44, flex: '0 0 auto' }}
        >
          Clear all
        </Button>
      )}
    </Box>
  );
}
