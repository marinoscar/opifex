import { useCallback, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Container,
  Stack,
  Typography,
} from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import TuneIcon from '@mui/icons-material/Tune';

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

/** What it takes to open the Control Center, where enablement now lives. */
const CONTROL_CENTER_PERMISSION = 'system_settings:read';
const CONTROL_CENTER_PATH = '/admin/settings?section=repositories';

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
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={1}
          sx={{
            mb: 3,
            alignItems: { xs: 'flex-start', sm: 'center' },
            justifyContent: 'space-between',
          }}
        >
          <Typography color="text.secondary">
            Every repository Opifex watches, and what it is allowed to do in
            each. This table READS those permissions; the Control Center is
            where they are changed.
          </Typography>
          {hasPermission(CONTROL_CENTER_PERMISSION) && (
            <Button
              size="small"
              startIcon={<TuneIcon />}
              component={RouterLink}
              to={CONTROL_CENTER_PATH}
            >
              Enablement ladder
            </Button>
          )}
        </Stack>

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
            <EmptyState
              canRegister={hasPermission(WRITE_PERMISSION)}
              canOpenControlCenter={hasPermission(CONTROL_CENTER_PERMISSION)}
            />
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
 * #81 asks that the empty state guide the operator to register one, and until
 * #350 that guidance was a `curl` command with `observeEnabled` in its body —
 * which made this page the documentation for enabling a repository as well as
 * for registering one. Enablement now has a screen, so the two are separated:
 * this says how to REGISTER, and points at the Control Center for everything
 * that happens to a repository afterwards.
 *
 * Registration itself is still not a form here. `POST /api/repositories`
 * verifies the repository is reachable with the configured token before
 * accepting it — an entry Opifex cannot read would turn every subsequent tick
 * into a 404 — and a form that can fail for token reasons it cannot explain is
 * worse than the runbook that reports them.
 */
function EmptyState({
  canRegister,
  canOpenControlCenter,
}: {
  canRegister: boolean;
  canOpenControlCenter: boolean;
}) {
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
        <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
          Register one with <code>POST /api/repositories</code> — see
          docs/RUNBOOK-observation-week.md. Once it is registered, observation,
          label mirroring, spec feedback and dispatch are enabled one rung at a
          time in the Control Center.
        </Typography>
      ) : (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
          Registering one needs <code>{WRITE_PERMISSION}</code>, which this
          account does not hold.
        </Typography>
      )}
      {canOpenControlCenter && (
        <Button
          size="small"
          sx={{ mt: 1 }}
          component={RouterLink}
          to={CONTROL_CENTER_PATH}
        >
          Open the enablement ladder
        </Button>
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
