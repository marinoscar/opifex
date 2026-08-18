/**
 * DataTable — the filter surface, one component per layout.
 *
 * Drawn by `DataTable` itself, above whichever renderer is active, for two
 * reasons: the shape of this control is decided by the LAYOUT rather than by
 * how rows are presented, and a renderer that owned the open/draft state would
 * throw it away on every resize (§7.4 — state lives above the renderers).
 *
 * | layout    | filter surface                                              |
 * | --------- | ----------------------------------------------------------- |
 * | `desktop` | an always-visible filter ROW above the grid                  |
 * | `tablet`  | the same row, collapsed behind a "Filters" button + count    |
 * | `mobile`  | a FULL-SCREEN sheet; chips become a scrollable strip         |
 *
 * The phone case is a sheet rather than a squeezed-down inline row for the same
 * reason the card list exists at all: a three-control form at 360px is either
 * unusable or pushes the page sideways. A sheet gets the full screen, the
 * stacked form, and a real focus trap.
 *
 * Filtering is SERVER-SIDE, always. Nothing here touches `rows`; every gesture
 * produces a new normalized model and hands it to the page.
 */

import { useMemo, useState } from 'react';
import {
  AppBar,
  Badge,
  Box,
  Button,
  Dialog,
  DialogContent,
  Divider,
  IconButton,
  Stack,
  Toolbar,
  Typography,
} from '@mui/material';
import FilterListIcon from '@mui/icons-material/FilterList';
import CloseIcon from '@mui/icons-material/Close';
import visuallyHidden from '@mui/utils/visuallyHidden';
import type {
  DataTableColumn,
  DataTableFilter,
  DataTableFilterModel,
  DataTableLayout,
  DataTableQuickSearchConfig,
} from '../types';
import { filterableColumns } from './operators';
import { addFilter, draftFilterFor, removeFilterAt } from './filterModel';
import { FilterEditor } from './FilterEditor';
import { FilterChips } from './FilterChips';
import { QuickSearchField } from './QuickSearchField';

/** Class on the tablet/phone "Filters" badge, so its count is assertable. */
export const FILTER_COUNT_CLASS = 'datatable-filter-count';

export interface DataTableFilterBarProps<Row> {
  columns: DataTableColumn<Row>[];
  layout: DataTableLayout;
  filters: DataTableFilterModel;
  onFiltersChange?: (next: DataTableFilterModel) => void;
  quickSearch?: DataTableQuickSearchConfig;
  /**
   * Total matching rows across all pages, when the page knows it —
   * `pagination.total`. Drives the "Filtered to N results" live-region
   * announcement (issue #257); omit and the region simply stays silent, since
   * there is nothing truthful to say about a query the page never reports a
   * total for.
   */
  resultCount?: number;
}

export function DataTableFilterBar<Row>({
  columns,
  layout,
  filters,
  onFiltersChange,
  quickSearch,
  resultCount,
}: DataTableFilterBarProps<Row>) {
  const filterable = useMemo(() => filterableColumns(columns), [columns]);
  const filteringEnabled = filterable.length > 0 && Boolean(onFiltersChange);

  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DataTableFilter | null>(null);

  // A draft whose column has disappeared (columns are a prop and can change)
  // would render an editor pointed at nothing, so it is re-seeded rather than
  // trusted.
  const activeDraft = useMemo<DataTableFilter | null>(() => {
    if (filterable.length === 0) return null;
    if (draft && filterable.some((column) => column.id === draft.columnId)) return draft;
    return draftFilterFor(filterable[0]);
  }, [draft, filterable]);

  if (!filteringEnabled && !quickSearch) return null;

  // "Filtered to 12 results" (issue #257) — only spoken when there is an
  // active filter or search term AND the page told us a real result count.
  // Silent otherwise: a table with nothing applied has nothing to announce,
  // and a count we do not actually know would be a lie a screen reader user
  // has no way to double-check.
  const hasActiveQuery = filters.length > 0 || Boolean(quickSearch?.value);
  const resultAnnouncement =
    hasActiveQuery && resultCount != null
      ? `Filtered to ${resultCount.toLocaleString()} ${resultCount === 1 ? 'result' : 'results'}`
      : '';

  const emit = (next: DataTableFilterModel) => onFiltersChange?.(next);

  const commitDraft = (filter: DataTableFilter) => {
    emit(addFilter(filters, filter));
    // Reset to a blank draft so the form is immediately ready for the next
    // filter instead of re-offering the one just applied.
    setDraft(draftFilterFor(filterable[0]));
  };

  const removeAt = (index: number) => emit(removeFilterAt(filters, index));
  const clearAll = () => emit([]);

  const editor = activeDraft ? (
    <FilterEditor
      columns={filterable}
      draft={activeDraft}
      onDraftChange={setDraft}
      onCommit={commitDraft}
      orientation={layout === 'mobile' ? 'stacked' : 'row'}
    />
  ) : null;

  const filtersButton = (
    <Badge
      color="primary"
      badgeContent={filters.length}
      // MUI's slot props are strictly typed and reject `data-*`; `className` is
      // a first-class slot prop, so the count bubble stays queryable without a
      // cast. The button's accessible name carries the same count in words.
      slotProps={{ badge: { className: FILTER_COUNT_CLASS } }}
      sx={{ flex: '0 0 auto' }}
    >
      <Button
        variant="outlined"
        size="small"
        startIcon={<FilterListIcon />}
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-haspopup={layout === 'mobile' ? 'dialog' : undefined}
        // The visible word "Filters" is preserved inside the accessible name
        // (WCAG 2.5.3), with the badge's count spelled out for screen readers,
        // which cannot see a superscript bubble.
        aria-label={filters.length > 0 ? `Filters (${filters.length} active)` : 'Filters'}
        data-testid="datatable-filter-toggle"
        sx={{ minHeight: 44 }}
      >
        Filters
      </Button>
    </Badge>
  );

  return (
    <Box
      data-testid="datatable-filter-bar"
      data-filter-surface={layout}
      sx={{ width: '100%', maxWidth: '100%', minWidth: 0, mb: 1.5 }}
    >
      {/* Off-screen but present at every layout, so the announcement fires
          regardless of which filter surface (row / collapsed panel / sheet)
          is currently drawn — the surface is a presentation choice, the
          result count is not. */}
      <Box
        aria-live="polite"
        role="status"
        data-testid="datatable-filter-live-region"
        sx={visuallyHidden}
      >
        {resultAnnouncement}
      </Box>

      <Stack
        direction={layout === 'mobile' ? 'column' : 'row'}
        spacing={1}
        useFlexGap
        sx={{
          alignItems: layout === 'mobile' ? 'stretch' : 'center',
          flexWrap: 'wrap',
          minWidth: 0,
        }}
      >
        {quickSearch && (
          <QuickSearchField
            config={quickSearch}
            columns={columns}
            fullWidth={layout !== 'desktop'}
          />
        )}

        {/* Desktop keeps the whole form on screen; the narrower layouts put it
            behind a button so the table itself stays the page's subject. */}
        {filteringEnabled && layout === 'desktop' && editor}
        {filteringEnabled && layout !== 'desktop' && filtersButton}
      </Stack>

      {/* Tablet: the same row, revealed in place. */}
      {filteringEnabled && layout === 'tablet' && open && (
        <Box sx={{ mt: 1.5 }} data-testid="datatable-filter-panel">
          {editor}
        </Box>
      )}

      {filteringEnabled && (
        <FilterChips
          filters={filters}
          columns={columns}
          onRemove={removeAt}
          onClearAll={clearAll}
          variant={layout === 'mobile' ? 'strip' : 'wrap'}
        />
      )}

      {/* Phone: a real sheet. MUI's Dialog gives the focus trap, the Escape
          handling and the aria-modal semantics for free — reimplementing any of
          those by hand is how a "custom sheet" ends up unusable by keyboard. */}
      {filteringEnabled && layout === 'mobile' && (
        <Dialog
          fullScreen
          open={open}
          onClose={() => setOpen(false)}
          aria-labelledby="datatable-filter-sheet-title"
        >
          <AppBar position="relative" color="default" elevation={0}>
            <Toolbar sx={{ gap: 1 }}>
              <Typography
                id="datatable-filter-sheet-title"
                variant="h6"
                component="h2"
                sx={{ flexGrow: 1 }}
              >
                Filters
              </Typography>
              <IconButton
                edge="end"
                aria-label="Close filters"
                onClick={() => setOpen(false)}
                sx={{ minWidth: 44, minHeight: 44 }}
              >
                <CloseIcon />
              </IconButton>
            </Toolbar>
          </AppBar>
          <Divider />

          <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {editor}

            {filters.length > 0 && (
              <Box>
                <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
                  Active filters
                </Typography>
                {/* Inside the sheet there is vertical room, so chips wrap
                    rather than hiding themselves behind a sideways scroll. */}
                <FilterChips
                  filters={filters}
                  columns={columns}
                  onRemove={removeAt}
                  onClearAll={clearAll}
                  variant="wrap"
                />
              </Box>
            )}

            <Box sx={{ flexGrow: 1 }} />

            <Button
              variant="contained"
              fullWidth
              onClick={() => setOpen(false)}
              sx={{ minHeight: 44 }}
            >
              Done
            </Button>
          </DialogContent>
        </Dialog>
      )}
    </Box>
  );
}
