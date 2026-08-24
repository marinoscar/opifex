/**
 * `/projects`: the DataTable column contract (#81, epic #20).
 *
 * ## What `GET /api/repositories` actually honours
 *
 * `sortable` and `filterable` are declared only where the endpoint can serve
 * them, per the rule `userListColumns.tsx` states: a control the page cannot
 * answer looks live and does nothing. Read off
 * `apps/api/src/repositories/dto/repository.dto.ts`:
 *
 *   | query param      | accepts          | column here       |
 *   | ---------------- | ---------------- | ----------------- |
 *   | `observeEnabled` | `true` / `false` | `observeEnabled`  |
 *   | `dispatchEnabled`| `true` / `false` | `dispatchEnabled` |
 *   | `projectId`      | uuid             | not a column      |
 *
 * There is **no sort parameter at all**, so no column declares `sortable`. The
 * endpoint returns registration order, which for a single-operator install of a
 * handful of repositories is a reasonable order and not worth pretending
 * otherwise.
 *
 * ## Dispatch enablement is the loudest thing on the row
 *
 * #81: it is "how the observation week (#16) ends one repository at a time
 * rather than globally", so it is a filled chip rather than a checkmark, with
 * the OFF state stated as words. An operator scanning this table is usually
 * asking exactly one question — which of these can the factory actually run in
 * — and the answer should not require reading a column header first.
 */

import { Chip, Stack, Tooltip, Typography } from '@mui/material';
import type { DataTableColumn } from '../datatable';
import { formatRelativeTime } from '../../utils/time';
import type { RepositorySummary } from '../../types/cockpit';

/** Persistence key for `user_settings.dataTables`. A storage key, never derived. */
export const TABLE_ID = 'cockpit-repositories';

const NUMERIC = { fontVariantNumeric: 'tabular-nums' } as const;

/**
 * The ceiling, kept as the string the API sent.
 *
 * The API deliberately serialises it as a string because a float "would round a
 * spend ceiling, which is the one field where that is least acceptable."
 * Parsing it here to format it would undo that in the last ten metres.
 */
export function formatCeiling(budgetCeilingUsd: string | null): string {
  return budgetCeilingUsd === null ? 'none' : `$${budgetCeilingUsd}`;
}

export function repositoryColumns(): DataTableColumn<RepositorySummary>[] {
  return [
    {
      id: 'fullName',
      label: 'Repository',
      priority: 'primary',
      minWidth: 220,
      flex: 1,
      value: (repo) => repo.fullName,
      render: (repo) => (
        <Stack spacing={0} sx={{ minWidth: 0 }}>
          <Typography variant="body2" noWrap>
            {repo.fullName}
          </Typography>
          <Typography variant="caption" color="text.secondary" noWrap>
            {repo.defaultBranch}
          </Typography>
        </Stack>
      ),
    },
    {
      id: 'dispatchEnabled',
      label: 'Dispatch',
      priority: 'primary',
      filterable: ['is'],
      filterType: 'enum',
      enumValues: [
        { value: 'true', label: 'Enabled' },
        { value: 'false', label: 'Disabled' },
      ],
      width: 130,
      value: (repo) => (repo.dispatchEnabled ? 'Enabled' : 'Disabled'),
      render: (repo) => (
        <Tooltip
          title={
            repo.dispatchEnabled
              ? 'The factory may run work in this repository.'
              : 'Observed only. Nothing will be dispatched here.'
          }
        >
          <Chip
            size="small"
            color={repo.dispatchEnabled ? 'success' : 'default'}
            variant={repo.dispatchEnabled ? 'filled' : 'outlined'}
            label={repo.dispatchEnabled ? 'Dispatch on' : 'Observe only'}
          />
        </Tooltip>
      ),
    },
    {
      id: 'observeEnabled',
      label: 'Observed',
      priority: 'secondary',
      filterable: ['is'],
      filterType: 'enum',
      enumValues: [
        { value: 'true', label: 'Observed' },
        { value: 'false', label: 'Not observed' },
      ],
      width: 120,
      value: (repo) => (repo.observeEnabled ? 'Yes' : 'No'),
      render: (repo) =>
        repo.observeEnabled ? (
          <Chip size="small" variant="outlined" label="Observed" />
        ) : (
          // Not observed is the quieter half of a pair that matters: a
          // repository the reconciler does not read produces no ticks, and a
          // blank cell would read as "unknown" rather than "off".
          <Chip size="small" variant="outlined" color="warning" label="Off" />
        ),
    },
    {
      id: 'mirrorLabelsEnabled',
      label: 'Mirror labels',
      priority: 'detail',
      width: 130,
      value: (repo) => (repo.mirrorLabelsEnabled ? 'Yes' : 'No'),
    },
    {
      id: 'budgetCeilingUsd',
      label: 'Budget ceiling',
      priority: 'secondary',
      align: 'right',
      width: 130,
      value: (repo) => repo.budgetCeilingUsd,
      render: (repo) => (
        <Typography variant="body2" sx={NUMERIC}>
          {formatCeiling(repo.budgetCeilingUsd)}
        </Typography>
      ),
    },
    {
      id: 'lastObservedAt',
      label: 'Last observed',
      priority: 'secondary',
      align: 'right',
      width: 140,
      value: (repo) => repo.lastObservedAt,
      render: (repo) => (
        <Typography variant="body2" sx={NUMERIC}>
          {repo.lastObservedAt
            ? (formatRelativeTime(repo.lastObservedAt) ?? '—')
            : 'never'}
        </Typography>
      ),
    },
    {
      id: 'pathConstraints',
      label: 'Path constraints',
      priority: 'detail',
      minWidth: 180,
      value: (repo) =>
        repo.pathConstraints.length ? repo.pathConstraints.join(', ') : null,
    },
  ];
}
