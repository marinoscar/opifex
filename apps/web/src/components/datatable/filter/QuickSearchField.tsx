/**
 * DataTable — global quick search.
 *
 * ## The debounce is on the EMISSION, not the input
 *
 * This is the whole point of the component. A naive debounce holds the input's
 * `value` back too, so the caret lags a keystroke or two behind the typist on a
 * slow phone.
 * Here the `<input>` is driven by local state and repaints on every keystroke,
 * while `onChange` — the thing that costs an HTTP round trip — fires once the
 * user has paused.
 *
 * A page can therefore refetch straight from `onChange` with no debounce of its
 * own, which is the contract the props document.
 *
 * ## Staying controlled without fighting the parent
 *
 * `value` is still the source of truth. `emittedRef` remembers the last term
 * this component put on the wire, so a change arriving from OUTSIDE (a URL
 * restore, a "clear all filters" button, a back-navigation) is distinguishable
 * from the echo of our own emission and re-seeds the input; our own echo is
 * ignored and never clobbers in-flight typing.
 */

import { useEffect, useRef, useState } from 'react';
import { IconButton, InputAdornment, TextField } from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import CloseIcon from '@mui/icons-material/Close';
import type { DataTableColumn, DataTableQuickSearchConfig } from '../types';
import { searchableColumns } from './operators';

/** Long enough to swallow a burst of typing, short enough to feel immediate. */
export const DEFAULT_QUICK_SEARCH_DEBOUNCE_MS = 300;

export interface QuickSearchFieldProps<Row> {
  config: DataTableQuickSearchConfig;
  columns: DataTableColumn<Row>[];
  /** Fill the available width — the phone sheet and the tablet bar both do. */
  fullWidth?: boolean;
}

/** "Search type, status or last error" — names what the term actually covers. */
function defaultPlaceholder<Row>(columns: DataTableColumn<Row>[]): string {
  const labels = searchableColumns(columns).map((column) => column.label);
  if (labels.length === 0) return 'Search';
  if (labels.length === 1) return `Search ${labels[0]}`;
  const last = labels[labels.length - 1];
  return `Search ${labels.slice(0, -1).join(', ')} or ${last}`;
}

export function QuickSearchField<Row>({
  config,
  columns,
  fullWidth = false,
}: QuickSearchFieldProps<Row>) {
  const {
    value,
    onChange,
    placeholder,
    debounceMs = DEFAULT_QUICK_SEARCH_DEBOUNCE_MS,
    ariaLabel = 'Search',
  } = config;

  const [draft, setDraft] = useState(value);
  const emittedRef = useRef(value);

  // `onChange` is very often an inline arrow from the calling page, so its
  // identity changes every render. Reading it through a ref keeps it out of the
  // timer effect's deps — otherwise a parent re-render would restart the
  // debounce window and, under a busy parent, the term would never be emitted.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // An externally-driven change (URL restore, programmatic clear) re-seeds the
  // input. The echo of our own emission does not.
  useEffect(() => {
    if (value === emittedRef.current) return;
    emittedRef.current = value;
    setDraft(value);
  }, [value]);

  useEffect(() => {
    if (draft === emittedRef.current) return;
    const timer = setTimeout(() => {
      emittedRef.current = draft;
      onChangeRef.current(draft);
    }, debounceMs);
    return () => clearTimeout(timer);
  }, [draft, debounceMs]);

  const clear = () => {
    setDraft('');
    // Clearing is an explicit, single gesture — there is nothing to debounce
    // and waiting 300ms to un-filter a table reads as a broken button.
    emittedRef.current = '';
    onChangeRef.current('');
  };

  return (
    <TextField
      size="small"
      type="search"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      placeholder={placeholder ?? defaultPlaceholder(columns)}
      fullWidth={fullWidth}
      data-testid="datatable-quick-search"
      slotProps={{
        htmlInput: { 'aria-label': ariaLabel },
        input: {
          startAdornment: (
            <InputAdornment position="start">
              <SearchIcon fontSize="small" />
            </InputAdornment>
          ),
          endAdornment: draft ? (
            <InputAdornment position="end">
              <IconButton
                size="small"
                aria-label="Clear search"
                onClick={clear}
                sx={{ minWidth: 44, minHeight: 44 }}
              >
                <CloseIcon fontSize="small" />
              </IconButton>
            </InputAdornment>
          ) : null,
        },
      }}
      sx={{
        minWidth: fullWidth ? 0 : 220,
        // WCAG 2.5.8: the field itself is a touch target.
        '& .MuiInputBase-root': { minHeight: 44 },
      }}
    />
  );
}
