import { useMemo, useState } from 'react';
import { Box, Container, Typography } from '@mui/material';

import { DataTable } from '../components/datatable';
import type {
  DataTableFilterModel,
  DataTableSortState,
} from '../components/datatable';
import { runColumns, TABLE_ID } from '../components/runs/runColumns';
import { useRuns } from '../hooks/useRuns';
import type { RunSortField } from '../services/api';
import type { RunStatus } from '../types/cockpit';

/**
 * `/runs` — every run the reconciler has observed (#82, epic #20).
 *
 * ## The page owns the query, the server answers it
 *
 * Pagination, sort and the status filter are controlled here and sent to
 * `GET /api/runs`. None of them is applied to `rows` locally, and that is the
 * whole design: filtering a page of 25 in the browser filters a PAGE, not the
 * result set. It looks identical right up to the moment an operator needs the
 * oldest silent run and it is on page four.
 *
 * ## Why the table can be empty and that is not an error
 *
 * Nothing has been dispatched yet — `DISPATCH_ENABLED` is off and the
 * observation week is read-only. An empty runs table is the honest state of the
 * system, so it says so rather than showing a spinner forever or inventing a
 * row. That is the same contract `NotWiredState` carries, applied to a screen
 * that IS wired and has nothing to report.
 */
export default function RunsPage() {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [sort, setSort] = useState<DataTableSortState | null>(null);
  const [filters, setFilters] = useState<DataTableFilterModel>([]);

  const status = statusFilter(filters);

  const { data, state, error, isRefreshing } = useRuns({
    page,
    pageSize,
    status,
    sort: sort ? (sort.field as RunSortField) : undefined,
    direction: sort?.direction,
  });

  const columns = useMemo(() => runColumns(), []);
  const rows = data?.items ?? [];

  return (
    <Container maxWidth="xl">
      <Box sx={{ py: 2 }}>
        <Typography variant="h4" component="h1" gutterBottom>
          Runs
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 4 }}>
          Every agent run, its status, and what it changed.
        </Typography>

        <DataTable<(typeof rows)[number]>
          tableId={TABLE_ID}
          columns={columns}
          rows={rows}
          rowId={(run) => run.id}
          loading={isRefreshing && state !== 'ready'}
          error={error}
          emptyState={
            <Box sx={{ p: 3, textAlign: 'center' }}>
              <Typography variant="body2" color="text.secondary">
                No runs yet. Nothing has been dispatched — this table reports
                what the control plane has actually executed, not what it plans
                to.
              </Typography>
            </Box>
          }
          pagination={{
            page,
            pageSize,
            total: data?.total ?? 0,
            onPaginationChange: (next) => {
              setPage(next.page);
              setPageSize(next.pageSize);
            },
          }}
          sort={{
            sort,
            onSortChange: (next) => {
              setSort(next);
              // Back to the first page: page four of the old ordering is not
              // page four of the new one, and staying put would silently show
              // a different slice than the operator asked for.
              setPage(1);
            },
          }}
          filters={filters}
          onFiltersChange={(next) => {
            setFilters(next);
            setPage(1);
          }}
        />
      </Box>
    </Container>
  );
}

/**
 * The one filter the endpoint honours, pulled out of the table's model.
 *
 * `GET /api/runs` takes a single `status`, so a model carrying anything else is
 * ignored here rather than approximated — `runColumns.tsx` only declares
 * `status` as filterable for exactly that reason.
 */
function statusFilter(filters: DataTableFilterModel): RunStatus | undefined {
  const entry = filters.find(
    (filter) => filter.columnId === 'status' && filter.operator === 'is',
  );
  return typeof entry?.value === 'string'
    ? (entry.value as RunStatus)
    : undefined;
}
