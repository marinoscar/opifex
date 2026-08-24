import { useMemo, useState } from 'react';
import { Alert, Box, Container, Typography } from '@mui/material';

import { DataTable } from '../components/datatable';
import type { DataTableFilterModel } from '../components/datatable';
import {
  approvalColumns,
  TABLE_ID,
} from '../components/approvals/approvalListColumns';
import { useApprovalQueue } from '../hooks/useApprovals';
import { usePermissions } from '../hooks/usePermissions';
import type { ApprovalListItem, OpenApprovalStatus } from '../types/approvals';

/** The permission `ApprovalsController` really enforces on a decision. */
const DECIDE_PERMISSION = 'approvals:decide';

/**
 * `/approvals` — everything still waiting on a person (#98, epic #22).
 *
 * The TRIAGE view, not the decision view. VISION §8's bar — "one tap from a
 * phone, with enough context to decide" — is met by the detail screen, which
 * is also where the notification deep-links; this page exists for the operator
 * who arrives without a notification and asks "what is waiting on me?". So
 * each row carries only what picks the next one to open: what class it is,
 * what is being asked, what happens if it is ignored, and how long is left.
 *
 * ## Oldest first, and never re-sorted
 *
 * The server returns the queue oldest first, because the oldest open approval
 * is the one that has been ignored longest. This page passes that order
 * straight to the table and offers no sort control at all — see
 * `approvalListColumns.tsx` for why a client-side sort here would be a lie.
 *
 * ## Both open statuses, and `parked` is not a resolution
 *
 * `parked` is `pending` with no timer. A queue that hid it would hide exactly
 * the requests that wait forever if nobody looks — which is why the filter can
 * narrow between the two and the default shows both.
 */
export default function ApprovalsPage() {
  const [filters, setFilters] = useState<DataTableFilterModel>([]);
  const { hasPermission } = usePermissions();

  const status = statusFilter(filters);
  const queue = useApprovalQueue(status ? { status } : {});

  const columns = useMemo(() => approvalColumns(), []);
  const rows = queue.data ?? [];

  return (
    <Container maxWidth="xl">
      <Box sx={{ py: 2 }}>
        <Typography variant="h4" component="h1" gutterBottom>
          Approvals
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 2 }}>
          Everything the factory is waiting on a person for. Oldest first — the
          top row is the one that has been ignored longest.
        </Typography>

        {!hasPermission(DECIDE_PERMISSION) && (
          <Alert severity="info" sx={{ mb: 2 }}>
            You can see what is waiting but not answer it. Deciding an approval
            needs <code>{DECIDE_PERMISSION}</code>, which is the permission the
            API enforces.
          </Alert>
        )}

        <DataTable<ApprovalListItem>
          tableId={TABLE_ID}
          ariaLabel="Open approvals"
          columns={columns}
          rows={rows}
          rowId={(approval) => approval.id}
          loading={queue.isRefreshing && queue.state !== 'ready'}
          error={queue.error}
          emptyState={
            <Box sx={{ p: 3, textAlign: 'center' }}>
              <Typography variant="body2" color="text.secondary">
                Nothing is waiting on you. An approval appears here when the
                gate has to ask a person — actions covered by a standing trust
                grant never reach this queue, and neither do the never-trustable
                ones, which are refused before a request is written at all.
              </Typography>
            </Box>
          }
          filters={filters}
          onFiltersChange={setFilters}
        />

        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: 'block', mt: 3 }}
        >
          A parked approval has no timer: nothing happens to it until a person
          answers, however long that takes. Everything else resolves itself on
          its recorded timeout policy whether or not anyone looks — which is
          what the &ldquo;If ignored&rdquo; column says, per row.
        </Typography>
      </Box>
    </Container>
  );
}

/**
 * The one filter the endpoint honours, pulled out of the table's model.
 *
 * `GET /api/approvals` takes a single `status` of `pending` or `parked`, so a
 * model carrying anything else is ignored here rather than approximated —
 * `approvalListColumns.tsx` declares only `status` as filterable for exactly
 * that reason.
 */
export function statusFilter(
  filters: DataTableFilterModel,
): OpenApprovalStatus | undefined {
  const entry = filters.find(
    (filter) => filter.columnId === 'status' && filter.operator === 'is',
  );
  return entry?.value === 'pending' || entry?.value === 'parked'
    ? entry.value
    : undefined;
}
