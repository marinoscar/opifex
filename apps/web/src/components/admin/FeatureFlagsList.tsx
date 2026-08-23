/**
 * Admin → System settings → Feature flags (upstream template issue #67, epic #51).
 *
 * The `List` / `ListItem` / `ListItemSecondaryAction` block is deleted
 * wholesale in favour of the shared `DataTable` — see `featureFlagColumns.tsx`
 * for why row-per-record data with an inline editor belongs in the table
 * contract even though it never looked like a table.
 *
 * Local-first editing is unchanged and deliberate: toggles and deletes mutate
 * `localFlags` and are pushed in ONE `PUT` when the user saves, so a
 * half-applied flag set never reaches the server. `hasChanges` is the diff
 * against the props, and a failed save leaves the local state intact.
 */

import { useMemo, useState } from 'react';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { Add as AddIcon, Delete as DeleteIcon } from '@mui/icons-material';
import { DataTable } from '../datatable';
import type { DataTableRowAction } from '../datatable';
import {
  TABLE_ID,
  buildFeatureFlagColumns,
  toFeatureFlagRows,
  type FeatureFlagRow,
} from './featureFlagColumns';

interface FeatureFlagsListProps {
  flags: Record<string, boolean>;
  onSave: (flags: Record<string, boolean>) => Promise<void>;
  disabled?: boolean;
}

export function FeatureFlagsList({ flags, onSave, disabled }: FeatureFlagsListProps) {
  const [localFlags, setLocalFlags] = useState<Record<string, boolean>>(flags);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [newFlagName, setNewFlagName] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const hasChanges = JSON.stringify(localFlags) !== JSON.stringify(flags);

  const handleToggle = (key: string) => {
    setLocalFlags((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleDelete = (key: string) => {
    setLocalFlags((prev) => {
      const { [key]: _removed, ...rest } = prev;
      return rest;
    });
  };

  const handleAddFlag = () => {
    if (newFlagName && !Object.prototype.hasOwnProperty.call(localFlags, newFlagName)) {
      setLocalFlags((prev) => ({ ...prev, [newFlagName]: false }));
      setNewFlagName('');
      setDialogOpen(false);
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await onSave(localFlags);
    } catch {
      // Reporting a failed save belongs to the page that owns the settings
      // document — `SystemSettingsPage` catches it and raises a snackbar. What
      // matters here is that the local edit SURVIVES (nothing below resets
      // `localFlags`) and that a rejecting `onSave` does not escape as an
      // unhandled rejection, which is what the previous `try/finally` did.
    } finally {
      setIsSaving(false);
    }
  };

  const rows = useMemo(() => toFeatureFlagRows(localFlags), [localFlags]);

  const columns = useMemo(
    () => buildFeatureFlagColumns({ onToggle: handleToggle, disabled }),
    // `handleToggle` only ever calls `setLocalFlags` with an updater, so it
    // needs no dependency of its own.
     
    [disabled],
  );

  const rowActions = useMemo(
    () =>
      [
        {
          id: 'delete',
          label: 'Delete flag',
          icon: <DeleteIcon fontSize="small" />,
          destructive: true,
          // `disabled` here conflates "no system_settings:write" with "a save
          // is in flight", so it is a per-row predicate rather than an array
          // gate: a read-only viewer should still SEE that flags are
          // deletable by someone, and the control keeps its tooltip.
          disabled: () => Boolean(disabled),
          confirm: {
            title: 'Delete flag?',
            description: (row: FeatureFlagRow) =>
              `"${row.key}" will be removed when you save your changes.`,
            confirmLabel: 'Delete',
          },
          onClick: (row: FeatureFlagRow) => handleDelete(row.key),
        },
      ] satisfies DataTableRowAction<FeatureFlagRow>[],
     
    [disabled],
  );

  return (
    <Box>
      <Stack
        direction="row"
        sx={{ justifyContent: 'space-between', alignItems: 'center', mb: 2 }}
      >
        <Typography variant="h6">Feature Flags</Typography>
        <Button startIcon={<AddIcon />} onClick={() => setDialogOpen(true)} disabled={disabled}>
          Add Flag
        </Button>
      </Stack>

      <DataTable<FeatureFlagRow>
        tableId={TABLE_ID}
        data-testid="admin-feature-flags-table"
        ariaLabel="Feature flags"
        density="compact"
        columns={columns}
        rows={rows}
        rowId={(row) => row.key}
        emptyState={
          <Typography color="text.secondary">No feature flags configured</Typography>
        }
        rowActions={rowActions}
        csvExport={{ filename: 'feature-flags' }}
      />

      <Box sx={{ mt: 3 }}>
        <Button
          variant="contained"
          onClick={handleSave}
          disabled={disabled || !hasChanges || isSaving}
        >
          {isSaving ? 'Saving...' : 'Save Changes'}
        </Button>
      </Box>

      {/* Add Flag Dialog */}
      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)}>
        <DialogTitle>Add Feature Flag</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            label="Flag Name"
            value={newFlagName}
            onChange={(e) => setNewFlagName(e.target.value.replace(/\s/g, '_'))}
            fullWidth
            sx={{ mt: 1 }}
            helperText="Use snake_case or camelCase"
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)}>Cancel</Button>
          <Button onClick={handleAddFlag} disabled={!newFlagName}>
            Add
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
