/**
 * Admin → System settings → Feature flags: the DataTable column contract
 * (upstream template issue #67, epic #51).
 *
 * ## Why a `List` became a table
 *
 * `FeatureFlagsList` was a `List` of `ListItem`s, not a `Table` — but it was
 * already row-per-record data with a per-row inline editor and a per-row
 * destructive action, which is exactly what the shared table contract
 * describes. Keeping it as a bespoke list meant it alone missed column
 * visibility, density, CSV export and the card layout, and that its delete
 * control was a `ListItemSecondaryAction` — a shape with no card equivalent.
 *
 * ## The whole record is client-side, so nothing is sortable or filterable
 *
 * Feature flags arrive as one `Record<string, boolean>` inside the system
 * settings document (`GET /api/system-settings`). There is no flags endpoint
 * and therefore no `sortBy`, no `search` and no filter params. Sorting and
 * filtering are ALWAYS server-side in this contract, so both stay off; the
 * page sorts the record alphabetically itself before handing rows over, which
 * is a fixed presentation order rather than a user-facing sort control.
 *
 * ## The Switch's accessible name
 *
 * `slotProps={{ input: { 'aria-label': ... } }}`, never `<Switch aria-label>`.
 * MUI forwards unknown props to the ROOT span, so `aria-label` on the
 * component labels a `<span>` that has no role, while the element that
 * actually carries `role="switch"` — the inner `<input type="checkbox">` — is
 * left nameless. Every switch on the page then announces as an unlabelled
 * control, and `getByRole('switch', { name })` finds nothing.
 */

import { Stack, Switch, Typography } from '@mui/material';
import type { DataTableColumn } from '../datatable';

/** Persistence key for `user_settings.dataTables`. */
export const TABLE_ID = 'admin-feature-flags';

/** One feature flag, as a row. */
export interface FeatureFlagRow {
  key: string;
  enabled: boolean;
}

/** Explode the settings record into alphabetically-ordered rows. */
export function toFeatureFlagRows(flags: Record<string, boolean>): FeatureFlagRow[] {
  return Object.entries(flags)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, enabled]) => ({ key, enabled }));
}

export interface BuildFeatureFlagColumnsOptions {
  onToggle: (key: string) => void;
  /** Read-only mode: no `system_settings:write`, or a save in flight. */
  disabled?: boolean;
}

export function buildFeatureFlagColumns({
  onToggle,
  disabled,
}: BuildFeatureFlagColumnsOptions): DataTableColumn<FeatureFlagRow>[] {
  return [
    {
      // Row-unique, and therefore the row's accessible name.
      id: 'key',
      label: 'Flag',
      priority: 'primary',
      hideable: false,
      minWidth: 220,
      flex: 1,
      value: (row) => row.key,
      render: (row) => (
        <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
          {row.key}
        </Typography>
      ),
    },
    {
      /**
       * The inline editor. Gated INSIDE the render rather than by omitting the
       * column: a read-only viewer must still be able to see which flags are
       * on, and a disappearing column would change the table's shape depending
       * on who is looking at it.
       */
      id: 'enabled',
      label: 'Enabled',
      priority: 'primary',
      align: 'center',
      width: 130,
      value: (row) => (row.enabled ? 'Enabled' : 'Disabled'),
      render: (row) => (
        <Stack direction="row" sx={{ justifyContent: 'center', width: '100%' }}>
          <Switch
            checked={row.enabled}
            onChange={() => onToggle(row.key)}
            disabled={disabled}
            // See the module docblock: this is the only placement that names
            // the element carrying `role="switch"`.
            slotProps={{ input: { 'aria-label': `Toggle ${row.key}` } }}
          />
        </Stack>
      ),
    },
  ];
}
