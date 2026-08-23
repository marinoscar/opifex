/**
 * DataTable — shared desktop cell primitives.
 *
 * Kept separate from `columnAdapter.ts` so that file can stay a pure,
 * JSX-free mapping module (it builds elements with `createElement`).
 */

import type { ReactNode } from 'react';
import { Box, Tooltip, Typography, CircularProgress } from '@mui/material';

// ---------------------------------------------------------------------------
// Truncated cell
// ---------------------------------------------------------------------------

export interface TruncatedCellProps {
  /** Full text revealed on hover/focus. Omitted when there is nothing to reveal. */
  title?: string;
  children: ReactNode;
}

/**
 * Single-line cell that clips overflowing content with an ellipsis and reveals
 * the full value in a tooltip. Used for any column declaring `truncate: true`.
 *
 * The tooltip is what "expand" means on desktop: the row height stays fixed
 * (which is what keeps a wide table scannable) and the full value is one hover
 * or keyboard focus away.
 */
export function TruncatedCell({ title, children }: TruncatedCellProps) {
  const hasTitle = typeof title === 'string' && title.length > 0;
  return (
    <Tooltip
      title={hasTitle ? title : ''}
      enterDelay={400}
      disableHoverListener={!hasTitle}
    >
      <Box
        component="span"
        data-testid="datatable-truncated-cell"
        tabIndex={hasTitle ? 0 : -1}
        sx={{
          display: 'block',
          width: '100%',
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {children}
      </Box>
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------
// Overlays
// ---------------------------------------------------------------------------

export function DataTableEmptyOverlay({ children }: { children?: ReactNode }) {
  return (
    <Box
      data-testid="datatable-empty-overlay"
      sx={{
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        p: 3,
        textAlign: 'center',
      }}
    >
      {children ?? (
        <Typography variant="body2" color="text.secondary">
          No results
        </Typography>
      )}
    </Box>
  );
}

export function DataTableLoadingOverlay() {
  return (
    <Box
      data-testid="datatable-loading-overlay"
      role="status"
      aria-live="polite"
      aria-label="Loading"
      sx={{
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 1.5,
        // Sits on top of any already-rendered rows.
        bgcolor: (theme) =>
          theme.palette.mode === 'dark'
            ? 'rgba(0, 0, 0, 0.45)'
            : 'rgba(255, 255, 255, 0.6)',
      }}
    >
      <CircularProgress size={24} />
      <Typography variant="body2" color="text.secondary">
        Loading…
      </Typography>
    </Box>
  );
}
