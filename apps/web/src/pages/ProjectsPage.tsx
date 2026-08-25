import { useCallback, useMemo, useState } from 'react';
import { Alert, Box, Container, Typography } from '@mui/material';

import { DataTable } from '../components/datatable';
import type { DataTableFilterModel } from '../components/datatable';
import {
  repositoryColumns,
  TABLE_ID,
} from '../components/projects/repositoryColumns';
import { COCKPIT_POLL_INTERVAL_MS } from '../config/cockpitApi';
import { usePermissions } from '../hooks/usePermissions';
import { usePolledResource } from '../hooks/usePolledResource';
import { getRepositories, type RepositoriesPage } from '../services/api';

/** The permission `RepositoriesController` really enforces on registration. */
const WRITE_PERMISSION = 'projects:write';

/**
 * `/projects` — every repository Opifex watches (#81, epic #20).
 *
 * VISION §2 describes the cockpit as *"a single view of every project, run,
 * cost, and queue, across repositories, that GitHub alone cannot provide"* —
 * and the cross-repository view is precisely the part GitHub does not offer.
 *
 * ## Dispatch enablement is the loudest thing on the row
 *
 * #81 calls it operationally important, and it is: per-repository dispatch is
 * how the observation week (#16) ends **one repository at a time** rather than
 * globally. So it renders as a filled chip with the off state stated in words —
 * "Observe only" — because an operator scanning this table is usually asking
 * exactly one question, and the answer should not require reading a header
 * first.
 *
 * ## Registration is not a form here
 *
 * The empty state tells the operator how to register a repository rather than
 * offering a dialog. `POST /api/repositories` verifies reachability with the
 * configured token before accepting an entry, and the runbook already documents
 * the call — a second, partial way to do it would be a form that can fail for
 * reasons the form cannot explain.
 */
export default function ProjectsPage() {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [filters, setFilters] = useState<DataTableFilterModel>([]);
  const { hasPermission } = usePermissions();

  const observeEnabled = booleanFilter(filters, 'observeEnabled');
  const dispatchEnabled = booleanFilter(filters, 'dispatchEnabled');

  const fetcher = useCallback(
    (signal: AbortSignal) =>
      getRepositories(
        { page, pageSize, observeEnabled, dispatchEnabled },
        signal,
      ),
    [page, pageSize, observeEnabled, dispatchEnabled],
  );
  const { data, state, error, isRefreshing } =
    usePolledResource<RepositoriesPage>({
      fetcher,
      fetcherKey: [page, pageSize, observeEnabled, dispatchEnabled],
      intervalMs: COCKPIT_POLL_INTERVAL_MS,
      enabled: true,
    });

  const columns = useMemo(() => repositoryColumns(), []);
  const rows = data?.items ?? [];

  return (
    <Container maxWidth="xl">
      <Box sx={{ py: 2 }}>
        <Typography variant="h4" component="h1" gutterBottom>
          Projects
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 3 }}>
          Every repository Opifex watches, and what it is allowed to do in each.
        </Typography>

        {error && !data && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        <DataTable<(typeof rows)[number]>
          tableId={TABLE_ID}
          columns={columns}
          rows={rows}
          rowId={(repo) => repo.id}
          loading={isRefreshing && state !== 'ready'}
          error={error}
          emptyState={
            <EmptyState canRegister={hasPermission(WRITE_PERMISSION)} />
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
 * What to do when nothing is registered.
 *
 * #81 asks that the empty state guide the operator to register one. It shows
 * the actual call rather than a button, because registration VERIFIES the
 * repository is reachable with the configured token before accepting it — an
 * entry Opifex cannot read would turn every subsequent tick into a 404 — and a
 * form that can fail for token reasons it cannot explain is worse than the
 * command that reports them.
 */
function EmptyState({ canRegister }: { canRegister: boolean }) {
  return (
    <Box sx={{ p: 3, textAlign: 'center' }}>
      <Typography variant="body1" gutterBottom>
        No repositories are registered.
      </Typography>
      <Typography variant="body2" color="text.secondary">
        Opifex only observes repositories it has been told about. Registration
        verifies the repository is reachable with the configured token before
        accepting it.
      </Typography>
      {canRegister ? (
        <Box
          component="pre"
          sx={{
            mt: 2,
            p: 2,
            textAlign: 'left',
            overflowX: 'auto',
            bgcolor: 'action.hover',
            borderRadius: 1,
            fontSize: '0.8rem',
          }}
        >
          {`curl -X POST /api/repositories \\
  -H 'Content-Type: application/json' \\
  -d '{"owner":"you","name":"repo","observeEnabled":true}'`}
        </Box>
      ) : (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
          Registering one needs <code>{WRITE_PERMISSION}</code>, which this
          account does not hold.
        </Typography>
      )}
    </Box>
  );
}

/**
 * One of the two boolean filters the endpoint honours.
 *
 * Anything else in the model is ignored rather than approximated —
 * `repositoryColumns.tsx` only declares these two as filterable for exactly
 * that reason.
 */
function booleanFilter(
  filters: DataTableFilterModel,
  columnId: string,
): boolean | undefined {
  const entry = filters.find(
    (filter) => filter.columnId === columnId && filter.operator === 'is',
  );
  if (entry?.value === 'true') return true;
  if (entry?.value === 'false') return false;
  return undefined;
}
