/**
 * `/runs`: the DataTable column contract (#82, epic #20).
 *
 * A sibling module rather than columns inlined in the page, following
 * `userListColumns.tsx`: the column list is the table's PUBLIC shape — what a
 * test, a CSV export and both renderers read — while the page is the state that
 * feeds it.
 *
 * ## What `GET /api/runs` actually honours
 *
 * `sortable` and `filterable` are declared ONLY where the endpoint can serve
 * them, because a control the page cannot answer looks live and does nothing.
 * Read off `apps/api/src/cockpit/dto/runs.dto.ts`:
 *
 *   | query param     | accepts                                        | column here   |
 *   | --------------- | ---------------------------------------------- | ------------- |
 *   | `sort`          | `startedAt` \| `lastEventAt` \| `costUsd` \| `status` | those four |
 *   | `direction`     | `asc` \| `desc`                                | —             |
 *   | `status`        | one of the six run statuses                    | `status`, `is` |
 *   | `needsAttention`| `true`                                         | not a column  |
 *
 * Everything else is display-only. `workOrder`, `runner` and `pullRequestUrl`
 * are neither sortable nor filterable — there is no parameter for them, and
 * offering the control would be offering a lie.
 *
 * ## Why `lastEventAt` is the column that matters
 *
 * #82 calls it "the operationally important one", and it is: `lastEventAt` is
 * the quantity the watchdog judges on (VISION §9), so seeing it directly is how
 * an operator sanity-checks that detection is working at all. A run happily
 * working for six hours is not a problem; one silent for six minutes is. It is
 * sortable for exactly that reason, and the server puts never-reported runs
 * first when sorting ascending — the worst case, not a missing value.
 */

import { Box, Link, Stack, Tooltip, Typography } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import type { DataTableColumn } from '../datatable';
import { StatusChip } from '../dashboard/StatusChip';
import { RUN_STATUS_LIST } from '../../config/runStatus';
import { formatRelativeTime } from '../../utils/time';
import type { RunSummary } from '../../types/cockpit';

/**
 * Persistence key for `user_settings.dataTables`. A constant, never derived
 * from the route or the heading: it is a storage key and must survive a rename.
 */
export const TABLE_ID = 'cockpit-runs';

/**
 * Tabular numerals, so a column of costs and ages does not jitter as it polls.
 *
 * #82 asks for this by name. With proportional digits every re-render shifts
 * the decimal point a pixel or two, which reads as movement in a table that is
 * supposed to be still unless something changed.
 */
const NUMERIC = { fontVariantNumeric: 'tabular-nums' } as const;

/** `$0.4231`, or an em dash for a runner that reports no cost at all. */
export function formatCost(costUsd: number | null): string {
  // Null is NOT zero. VISION §6 makes cost reporting a declared capability, so
  // a runner that cannot report must not render as one that spent nothing.
  return costUsd === null ? '—' : `$${costUsd.toFixed(4)}`;
}

/** How long a run has been silent, as the watchdog measures it. */
export function formatSilence(
  lastEventAt: string | null,
  now: Date = new Date(),
): string {
  // Never reported at all — the worst case, and it must not render as "just
  // now" or as an empty cell that reads like a missing value.
  if (!lastEventAt) return 'never';
  // The helper is null-tolerant and returns null for a null input; the guard
  // above means that cannot happen here, and the fallback keeps the signature
  // a plain string so the cell never renders "null".
  return formatRelativeTime(new Date(lastEventAt), now) ?? 'never';
}

export function runColumns(): DataTableColumn<RunSummary>[] {
  return [
    {
      /**
       * Sortable and filterable, both honoured server-side.
       *
       * The filter offers all six statuses individually because VISION §9
       * treats `stalled`, `blocked` and `quarantined` as three different
       * problems with three different responses — collapsing them into
       * "unhealthy" in the UI would undo that distinction exactly where an
       * operator acts on it.
       */
      id: 'status',
      label: 'Status',
      priority: 'primary',
      sortable: true,
      filterable: ['is'],
      filterType: 'enum',
      enumValues: RUN_STATUS_LIST.map((descriptor) => ({
        value: descriptor.status,
        label: descriptor.label,
      })),
      width: 140,
      value: (run) => run.status,
      render: (run) => <StatusChip status={run.status} />,
    },
    {
      id: 'workOrder',
      label: 'Work order',
      priority: 'primary',
      minWidth: 220,
      flex: 1,
      value: (run) => run.workOrder.id,
      render: (run) => (
        <Stack spacing={0} sx={{ minWidth: 0 }}>
          {/* The way into the run's own page. The identity is the natural
              handle: it is what a commit trailer, an authorization record and
              a branch name all carry, so it is what an operator recognises. */}
          <Link
            component={RouterLink}
            to={`/runs/${run.id}`}
            variant="body2"
            noWrap
            sx={NUMERIC}
          >
            {run.workOrder.id}
          </Link>
          <Typography variant="caption" color="text.secondary" noWrap>
            {run.workOrder.repository} #{run.workOrder.issueNumber} ·{' '}
            {run.workOrder.title}
          </Typography>
        </Stack>
      ),
    },
    {
      id: 'lastEventAt',
      label: 'Last event',
      priority: 'primary',
      sortable: true,
      align: 'right',
      width: 130,
      // The scalar is the raw timestamp, not the rendered string: the export
      // and any client-side comparison want something orderable, and "3m ago"
      // sorts alphabetically into nonsense.
      value: (run) => run.lastEventAt,
      render: (run) => (
        <Tooltip
          title={
            run.lastEventAt
              ? new Date(run.lastEventAt).toISOString()
              : 'This run has never reported an event'
          }
        >
          <Typography variant="body2" sx={NUMERIC}>
            {formatSilence(run.lastEventAt)}
          </Typography>
        </Tooltip>
      ),
    },
    {
      id: 'runner',
      label: 'Runner',
      priority: 'secondary',
      minWidth: 160,
      value: (run) => run.runner,
    },
    {
      id: 'costUsd',
      label: 'Cost',
      priority: 'secondary',
      sortable: true,
      align: 'right',
      width: 110,
      value: (run) => run.costUsd,
      render: (run) => (
        <Typography variant="body2" sx={NUMERIC}>
          {formatCost(run.costUsd)}
        </Typography>
      ),
    },
    {
      id: 'startedAt',
      label: 'Started',
      priority: 'secondary',
      sortable: true,
      align: 'right',
      width: 130,
      value: (run) => run.startedAt,
      render: (run) => (
        <Tooltip title={new Date(run.startedAt).toISOString()}>
          <Typography variant="body2" sx={NUMERIC}>
            {formatRelativeTime(new Date(run.startedAt)) ?? '—'}
          </Typography>
        </Tooltip>
      ),
    },
    {
      /**
       * The reason a run needs a human, when the control plane has one.
       *
       * Detail priority rather than primary: it is empty for most rows, and a
       * column that is blank nine times out of ten costs more width than it
       * earns on a phone.
       */
      id: 'attentionReason',
      label: 'Needs attention',
      priority: 'detail',
      minWidth: 200,
      value: (run) => run.attentionReason,
    },
    {
      id: 'pullRequestUrl',
      label: 'Pull request',
      priority: 'detail',
      minWidth: 140,
      value: (run) => run.pullRequestUrl,
      render: (run) =>
        run.pullRequestUrl ? (
          <Link
            href={run.pullRequestUrl}
            target="_blank"
            rel="noopener noreferrer"
            variant="body2"
          >
            {pullNumberFrom(run.pullRequestUrl) ?? 'open'}
          </Link>
        ) : (
          <Box component="span" sx={{ color: 'text.disabled' }}>
            —
          </Box>
        ),
    },
  ];
}

/** `#42` from a pull-request URL, or null when it is shaped unexpectedly. */
function pullNumberFrom(url: string): string | null {
  const match = /\/pull\/(\d+)(?:$|[/?#])/.exec(url);
  return match ? `#${match[1]}` : null;
}
