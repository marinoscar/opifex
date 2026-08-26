/**
 * History — the Control Center's change log (#351, epic #332).
 *
 * ## Why this section exists at all
 *
 * `audit_events` has been written to by nine services since the foundation
 * shipped and read by nobody: `auditEvent.findMany` appeared nowhere in the
 * API until #338 added it. That was survivable while configuration lived in
 * `infra/compose/.env`, because "who changed this and when" was answerable
 * from `git log` on that file. The moment epic #332 moves configuration into
 * the database, that answer disappears — and this section is what replaces it.
 *
 * ## Secrets
 *
 * Rendered as **set** or **cleared**, never as a value and never as a masked
 * value. The whole of that rule lives in `config/auditHistory.ts`; this file
 * only asks it for `AuditChange[]` and draws what it gets. See that module's
 * header for why the browser judges independently rather than trusting the
 * server's redaction.
 *
 * ## Authorization
 *
 * None here, deliberately. `GET /api/audit-events` is gated on
 * `system_settings:read` — the controller's header explains why that string
 * and not a new `audit:read` — and `ControlCenterPage` already redirects
 * anybody without it before this component can mount. A second check here
 * would be a second place for the two to disagree, and the API is the
 * enforcement point regardless.
 *
 * ## The query belongs to the server
 *
 * Pagination and the target-type filter are controlled here and sent to the
 * endpoint. Nothing is applied to `rows` locally: an audit table grows without
 * bound, so filtering a page of 25 in the browser would filter a PAGE, and on
 * this screen "I could not find that change" has to mean it did not happen.
 */

import { useMemo, useState } from 'react';
import { Box, Button, Stack, Typography } from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';

import { DataTable } from '../datatable';
import type { DataTableFilterModel } from '../datatable';
import { historyColumns, TABLE_ID } from './historyColumns';
import { useAuditEvents } from '../../hooks/useAuditEvents';
import type { AuditEvent } from '../../types/audit';

const DEFAULT_PAGE_SIZE = 25;

export function HistorySection() {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [filters, setFilters] = useState<DataTableFilterModel>([]);

  // Derived, never stored: a second copy of the filter in state would be a
  // second thing that can be stale, and this one is one `find` away.
  const targetType = targetTypeFilter(filters);

  const { data, error, isRefreshing, lastUpdatedAt, refresh } = useAuditEvents({
    page,
    pageSize,
    targetType,
  });

  const columns = useMemo(() => historyColumns(), []);
  const rows: AuditEvent[] = data?.items ?? [];

  return (
    <Box>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1}
        sx={{
          mb: 2,
          alignItems: { xs: 'flex-start', sm: 'center' },
          justifyContent: 'space-between',
        }}
      >
        <Typography variant="body2" color="text.secondary">
          Every recorded action, newest first. A secret is recorded as having
          changed — never as a value, not even a masked one.
        </Typography>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          {/* When the rows on screen were READ, never when the page was drawn
              — the same rule the Readiness section follows. */}
          <Typography variant="caption" color="text.secondary">
            {lastUpdatedAt
              ? `Read at ${lastUpdatedAt.toLocaleTimeString()}`
              : 'Not yet read'}
          </Typography>
          <Button
            size="small"
            startIcon={<RefreshIcon />}
            onClick={() => void refresh()}
            disabled={isRefreshing}
          >
            Refresh
          </Button>
        </Stack>
      </Stack>

      <DataTable<AuditEvent>
        tableId={TABLE_ID}
        ariaLabel="Configuration change history"
        columns={columns}
        rows={rows}
        rowId={(event) => event.id}
        loading={isRefreshing && data === null}
        error={error}
        emptyState={
          <Box sx={{ p: 3, textAlign: 'center' }}>
            <Typography variant="body2" color="text.secondary">
              {targetType
                ? 'No recorded changes of that kind. The filter is applied by ' +
                  'the server, so this is the whole log and not just this page.'
                : 'Nothing has been recorded yet. Changes made through the ' +
                  'Control Center appear here; changes made by editing ' +
                  'infra/compose/.env and recreating the container do not, ' +
                  'which is one of the reasons configuration is moving out of ' +
                  'that file.'}
            </Typography>
          </Box>
        }
        pagination={{
          // The table is zero-based, the API is one-based. Converted at the
          // boundary, as `DataTablePaginationConfig` documents.
          page: page - 1,
          pageSize,
          total: data?.total ?? 0,
          onPaginationChange: (next) => {
            setPage(next.page + 1);
            setPageSize(next.pageSize);
          },
        }}
        filters={filters}
        onFiltersChange={(next) => {
          setFilters(next);
          // Back to the first page: page four of the unfiltered log is not
          // page four of the filtered one.
          setPage(1);
        }}
      />
    </Box>
  );
}

/**
 * The one filter the endpoint honours, pulled out of the table's model.
 *
 * `historyColumns.tsx` declares only `targetType` as filterable for exactly
 * this reason: a model carrying anything else would be ignored here rather
 * than approximated in the browser.
 */
function targetTypeFilter(filters: DataTableFilterModel): string | undefined {
  const entry = filters.find(
    (filter) => filter.columnId === 'targetType' && filter.operator === 'is',
  );
  return typeof entry?.value === 'string' && entry.value !== ''
    ? entry.value
    : undefined;
}

export default HistorySection;
