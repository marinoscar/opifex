/**
 * DataTable — bulk action bar.
 *
 * Rendered directly above the table whenever the selection is non-empty. It is
 * renderer-agnostic on purpose: the mobile card renderer (#253) reuses this
 * exact component, so selection UX stays identical across layouts.
 *
 * Accessibility: the bar is a live region so the selection count is announced
 * as it changes, and it is labelled as a toolbar so its buttons are grouped.
 * The announcement is "N of M selected" (issue #257) whenever the caller
 * knows the denominator — the number of selectABLE rows currently loaded —
 * rather than a bare count with no sense of scale.
 */

import { Paper, Stack, Button, Typography, Box } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import type { DataTableBulkAction } from './types';

export interface BulkActionBarProps {
  /** Selected row ids, in selection order. */
  ids: string[];
  actions?: DataTableBulkAction[];
  onClear: () => void;
  /**
   * Rows available to select on THIS page — selection is page-scoped (§5.3),
   * so this is `rowIds.length`, never `pagination.total`. Drives the "N of M
   * selected" phrasing; omit for a bare "N selected" (e.g. a caller that uses
   * this bar outside a DataTable renderer without a known denominator).
   */
  total?: number;
}

function isActionDisabled(action: DataTableBulkAction, ids: string[]): boolean {
  if (typeof action.disabled === 'function') return action.disabled(ids);
  return action.disabled ?? false;
}

export function BulkActionBar({ ids, actions, onClear, total }: BulkActionBarProps) {
  const count = ids.length;
  if (count === 0) return null;

  const countText = total != null ? `${count} of ${total} selected` : `${count} selected`;

  return (
    <Paper
      variant="outlined"
      data-testid="datatable-bulk-action-bar"
      role="toolbar"
      aria-label="Bulk actions"
      sx={{
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 1,
        px: 2,
        py: 1,
        mb: 1,
        minWidth: 0,
        maxWidth: '100%',
        borderColor: 'primary.main',
        bgcolor: (theme) =>
          theme.palette.mode === 'dark'
            ? 'rgba(144, 202, 249, 0.10)'
            : 'rgba(25, 118, 210, 0.06)',
      }}
    >
      <Typography variant="body2" sx={{ fontWeight: 600 }} aria-live="polite" role="status">
        {countText}
      </Typography>

      <Button size="small" startIcon={<CloseIcon />} onClick={onClear} aria-label="Clear selection">
        Clear
      </Button>

      <Box sx={{ flexGrow: 1 }} />

      <Stack direction="row" spacing={1} useFlexGap sx={{ minWidth: 0, flexWrap: 'wrap' }}>
        {(actions ?? []).map((action) => (
          <Button
            key={action.id}
            size="small"
            variant="outlined"
            color={action.destructive ? 'error' : 'primary'}
            startIcon={action.icon}
            disabled={isActionDisabled(action, ids)}
            onClick={() => action.onClick(ids)}
          >
            {action.label}
          </Button>
        ))}
      </Stack>
    </Paper>
  );
}
