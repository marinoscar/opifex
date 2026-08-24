/**
 * `/approvals`: the DataTable column contract (#98, epic #22).
 *
 * A sibling module rather than columns inlined in the page, following
 * `userListColumns.tsx` and `runColumns.tsx`: the column list is the table's
 * PUBLIC shape — what a test, a CSV export and both renderers read — while the
 * page owns the state that feeds it.
 *
 * ## What `GET /api/approvals` actually honours
 *
 * Read off `apps/api/src/approvals/dto/approval.dto.ts`:
 *
 *   | query param    | accepts                        | column here      |
 *   | -------------- | ------------------------------ | ---------------- |
 *   | `status`       | `pending` \| `parked`          | `status`, `is`   |
 *   | `repositoryId` | any id                         | not offered      |
 *   | `actionClass`  | an ADR-0011 registry id        | not offered      |
 *   | (no `sort`)    | —                              | nothing sortable |
 *
 * **No column is sortable, and that is the contract rather than an omission.**
 * The endpoint returns the queue OLDEST FIRST because the oldest open approval
 * is the one that has been ignored longest, and it accepts no `sort`
 * parameter. A sortable header here could only re-sort the page in the browser
 * — which sorts a PAGE, not the queue — so it would be a control that looks
 * live and quietly lies.
 *
 * `actionClass` is not offered as a filter for a different reason: its accepted
 * values are the registry ids, no endpoint exposes that registry to a browser,
 * and a hand-copied list in this file is exactly the drift ADR-0011 put the
 * taxonomy in one file to prevent. A typo would also answer 400 rather than
 * "nothing matches".
 *
 * ## The class column shows the title the SERVER joined on, with the id behind it
 *
 * `GET /approvals` carries `actionClassTitle` — the ADR-0011 registry title
 * for the row's `actionClass`, joined by the API exactly as the detail
 * endpoint joins the whole entry. It is joined there and not here because a
 * second copy of the taxonomy in this app is precisely the drift ADR-0011 put
 * the classes in one file to prevent.
 *
 * The cell renders `actionClassTitle ?? actionClass`, and the fallback is not
 * decoration: the server returns null rather than the id for a class the
 * registry does not recognise, so that drift stays visible to anything reading
 * the API, and this is the one place that null has to be turned back into
 * something an operator can read. An unknown class is a real case — it PARKS
 * (ADR-0014) — so the row it produces has to render, not blank.
 */

import { Box, Link, Stack, Tooltip, Typography } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import type { DataTableColumn } from '../datatable';
import { ApprovalStatusChip } from './ApprovalStatusChip';
import { TimeRemaining } from './TimeRemaining';
import { describeIfIgnored } from './ifIgnored';
import { formatEstimatedCost } from './approvalFormat';
import { OPEN_APPROVAL_STATUSES } from '../../types/approvals';
import { APPROVAL_STATUS_DESCRIPTORS } from '../../config/approvalStatus';
import { formatRelativeTime } from '../../utils/time';
import type { ApprovalListItem } from '../../types/approvals';

/**
 * Persistence key for `user_settings.dataTables`. A constant, never derived
 * from the route or the heading: it is a storage key and must survive a
 * rename.
 */
export const TABLE_ID = 'approvals-queue';

const NUMERIC = { fontVariantNumeric: 'tabular-nums' } as const;

export function approvalColumns(): DataTableColumn<ApprovalListItem>[] {
  return [
    {
      id: 'actionClass',
      label: 'Action class',
      priority: 'primary',
      minWidth: 200,
      // The words a human reads, falling back to the id when the server had no
      // title to give — never the other way round, and never blank. The CSV
      // and the cell agree, so an exported queue names classes the same way
      // the screen did.
      value: (approval) => approval.actionClassTitle ?? approval.actionClass,
      render: (approval) => (
        <Stack spacing={0} sx={{ minWidth: 0 }}>
          {/* The way into the one-tap screen. The whole row exists to get the
              operator here, so the link is on the identifying field. */}
          <Link
            component={RouterLink}
            to={`/approvals/${approval.id}`}
            variant="body2"
            noWrap
          >
            {approval.actionClassTitle ?? approval.actionClass}
          </Link>
          <Typography variant="caption" color="text.secondary" noWrap>
            {approval.repositoryId}
          </Typography>
        </Stack>
      ),
    },
    {
      id: 'summary',
      label: 'What is being asked',
      priority: 'primary',
      minWidth: 260,
      flex: 1,
      truncate: true,
      value: (approval) => approval.summary,
    },
    {
      /**
       * VISION §8's fourth field, in its SHORT form.
       *
       * The short form never names a time — the instant belongs beside the
       * countdown, and a triage row is scanned rather than read.
       */
      id: 'ifIgnored',
      label: 'If ignored',
      priority: 'primary',
      minWidth: 180,
      value: (approval) =>
        describeIfIgnored(approval.timeoutPolicy, approval.timeoutAt).short,
      render: (approval) => {
        const ignored = describeIfIgnored(
          approval.timeoutPolicy,
          approval.timeoutAt,
        );
        return (
          <Typography
            variant="body2"
            color={ignored.waitsForever ? 'text.primary' : 'text.secondary'}
          >
            {ignored.short}
          </Typography>
        );
      },
    },
    {
      /**
       * The countdown, or NOTHING AT ALL.
       *
       * A parked approval has no timer, so this cell renders the words rather
       * than an em dash in a countdown slot: a dash where a deadline would go
       * still reads as a deadline that is merely unknown.
       */
      id: 'timeRemaining',
      label: 'Time remaining',
      priority: 'primary',
      align: 'right',
      width: 150,
      value: (approval) => approval.timeoutAt,
      render: (approval) => {
        const ignored = describeIfIgnored(
          approval.timeoutPolicy,
          approval.timeoutAt,
        );
        if (!ignored.countdownAt) {
          return (
            <Tooltip title="This one waits for a person indefinitely. There is no timer on it.">
              <Typography variant="body2" color="text.secondary">
                No timer
              </Typography>
            </Tooltip>
          );
        }
        return <TimeRemaining timeoutAt={ignored.countdownAt} />;
      },
    },
    {
      id: 'status',
      label: 'Status',
      priority: 'secondary',
      width: 170,
      // The only filter the endpoint honours, and its two members are the
      // closed set the API's own enum pins — it can narrow between the open
      // statuses and can never widen to a decided row.
      filterable: ['is'],
      filterType: 'enum',
      enumValues: OPEN_APPROVAL_STATUSES.map((status) => ({
        value: status,
        label: APPROVAL_STATUS_DESCRIPTORS[status].label,
      })),
      value: (approval) => approval.status,
      render: (approval) => <ApprovalStatusChip status={approval.status} />,
    },
    {
      id: 'createdAt',
      label: 'Waiting',
      priority: 'secondary',
      align: 'right',
      width: 120,
      value: (approval) => approval.createdAt,
      render: (approval) => (
        <Tooltip title={approval.createdAt}>
          <Typography variant="body2" sx={NUMERIC}>
            {formatRelativeTime(approval.createdAt) ?? '—'}
          </Typography>
        </Tooltip>
      ),
    },
    {
      id: 'blastRadius',
      label: 'Blast radius',
      priority: 'detail',
      minWidth: 220,
      value: (approval) => approval.blastRadius,
    },
    {
      /**
       * Null renders as "Unknown", never as `$0.00` — unknown and zero are
       * different, and this is the figure that decides whether a budget check
       * can even run.
       */
      id: 'estimatedCostUsd',
      label: 'Estimated cost',
      priority: 'detail',
      align: 'right',
      width: 140,
      value: (approval) => formatEstimatedCost(approval.estimatedCostUsd),
      render: (approval) => (
        <Box component="span" sx={NUMERIC}>
          {formatEstimatedCost(approval.estimatedCostUsd)}
        </Box>
      ),
    },
  ];
}
