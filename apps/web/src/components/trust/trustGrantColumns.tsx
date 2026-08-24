/**
 * `/trust`: the DataTable column contract for the grants list (#101).
 *
 * A sibling module rather than columns inlined in the page, following
 * `approvalListColumns.tsx` and `userListColumns.tsx`: the column list is the
 * table's PUBLIC shape — what a test, a CSV export and both renderers read —
 * while the page owns the state that feeds it.
 *
 * ## What `GET /api/trust/grants` actually honours
 *
 * Read off `apps/api/src/trust/dto/trust-grant.dto.ts`:
 *
 *   | query param    | accepts                                    | column here    |
 *   | -------------- | ------------------------------------------ | -------------- |
 *   | `status`       | `active`\|`expired`\|`revoked`\|`suspended`| `status`, `is` |
 *   | `includeEnded` | boolean, default false                     | page toggle    |
 *   | `repositoryId` | any id                                     | not offered    |
 *   | `actionClass`  | an ADR-0011 registry id                    | not offered    |
 *   | (no `sort`)    | —                                          | nothing sortable |
 *
 * **No column is sortable, and that is the contract rather than an omission.**
 * The endpoint returns grants NEWEST FIRST and accepts no `sort` parameter, so
 * a sortable header could only re-sort the page in the browser — a control
 * that looks live and quietly lies.
 *
 * `actionClass` is not offered as a filter for the reason `approvalListColumns`
 * gives: its accepted values are the ADR-0011 registry ids, no endpoint exposes
 * that registry to a browser, and a hand-copied list here is exactly the drift
 * the registry exists to prevent.
 *
 * `status` IS offered, because its four members are the closed set the API's
 * own enum pins. Note the deliberate interaction the page has to honour: an
 * explicit `status` OVERRIDES `includeEnded` server-side, so filtering to
 * `revoked` returns revoked grants whether or not the toggle is on. The page
 * passes both through untouched rather than reconciling them, because the
 * server's precedence is the real one.
 *
 * ## Every row carries all four VISION §8 attributes
 *
 * Scope (`actionClass` + `repositoryId`), expiry, budget ceiling and the
 * auto-revoke thresholds — plus the usage measured against each. That is
 * #101's first acceptance criterion, and it is why the auto-revoke column
 * exists at `detail` priority rather than being dropped: it is the attribute
 * an operator looks for last and needs most when a grant has misbehaved.
 */

import { Link, Stack, Tooltip, Typography } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import type { DataTableColumn } from '../datatable';
import { TrustGrantStatusChip } from './TrustGrantStatusChip';
import { BudgetCell, ExpiryCell } from './GrantHeadroomCells';
import {
  describeAutoRevoke,
  describeExpiry,
  formatFailureRate,
  formatPercent,
  formatUsd,
} from './trustFormat';
import {
  TRUST_GRANT_STATUS_DESCRIPTORS,
  endReasonLabel,
  isAuthorizingGrant,
} from '../../config/trustStatus';
import { TRUST_GRANT_STATUSES } from '../../types/trust';
import { formatRelativeTime } from '../../utils/time';
import type { TrustGrantListItem } from '../../types/trust';

/**
 * Persistence key for `user_settings.dataTables`. A constant, never derived
 * from the route or the heading: it is a storage key and must survive a rename.
 */
export const TABLE_ID = 'trust-grants';

const NUMERIC = { fontVariantNumeric: 'tabular-nums' } as const;

export function trustGrantColumns(): DataTableColumn<TrustGrantListItem>[] {
  return [
    {
      id: 'actionClass',
      label: 'Scope',
      priority: 'primary',
      minWidth: 220,
      // The words a human reads, falling back to the id when the server had no
      // title to give — never the other way round, and never blank. The CSV
      // and the cell agree, so an exported list names classes the same way the
      // screen did.
      value: (grant) => grant.actionClassTitle ?? grant.actionClass,
      render: (grant) => (
        <Stack spacing={0} sx={{ minWidth: 0 }}>
          <Link
            component={RouterLink}
            to={`/trust/grants/${grant.id}`}
            variant="body2"
            noWrap
          >
            {grant.actionClassTitle ?? grant.actionClass}
          </Link>
          {/* Scope is BOTH halves. A class without its repository is not a
              scope at all — VISION §8 is explicit that it is never "trust the
              agent" — so the repository is never dropped from this cell. */}
          <Typography variant="caption" color="text.secondary" noWrap>
            {grant.repositoryId}
          </Typography>
        </Stack>
      ),
    },
    {
      id: 'status',
      label: 'Status',
      priority: 'primary',
      minWidth: 140,
      filterable: ['is'],
      filterType: 'enum',
      enumValues: TRUST_GRANT_STATUSES.map((status) => ({
        value: status,
        label: TRUST_GRANT_STATUS_DESCRIPTORS[status].label,
      })),
      value: (grant) => TRUST_GRANT_STATUS_DESCRIPTORS[grant.status].label,
      render: (grant) => <TrustGrantStatusChip status={grant.status} />,
    },
    {
      /** VISION §8's attribute 2, and the sign of `msUntilExpiry` respected. */
      id: 'expiry',
      label: 'Expiry',
      priority: 'primary',
      minWidth: 170,
      value: (grant) => describeExpiry(grant.msUntilExpiry).text,
      render: (grant) => <ExpiryCell grant={grant} />,
    },
    {
      /** VISION §8's attribute 3, with the spend measured against it. */
      id: 'budget',
      label: 'Budget',
      priority: 'primary',
      minWidth: 190,
      value: (grant) =>
        `${formatUsd(grant.remainingBudgetUsd)} of ${formatUsd(grant.budgetCeilingUsd)} left`,
      render: (grant) => <BudgetCell grant={grant} />,
    },
    {
      id: 'usage',
      label: 'Actions',
      priority: 'secondary',
      minWidth: 130,
      align: 'right',
      value: (grant) => grant.actionsAuthorized,
      render: (grant) => (
        <Typography variant="body2" sx={NUMERIC}>
          {grant.actionsAuthorized} authorized
          {grant.actionsFailed > 0 ? ` · ${grant.actionsFailed} failed` : ''}
        </Typography>
      ),
    },
    {
      /**
       * NULL IS NOT ZERO, and this column is where the app would most easily
       * say otherwise. `failureRate === null` means nothing has run yet;
       * `0` means everything that ran succeeded. `formatFailureRate` is the
       * single place that distinction is turned into words.
       */
      id: 'failureRate',
      label: 'Failure rate',
      priority: 'secondary',
      minWidth: 140,
      align: 'right',
      value: (grant) => formatFailureRate(grant.failureRate),
      render: (grant) => (
        <Tooltip
          title={
            grant.failureRate === null
              ? `No actions have run under this grant yet. A rate needs a sample — the auto-revoke rules hold until ${grant.minActionsBeforeAutoRevoke} actions have run.`
              : `${grant.actionsFailed} of ${grant.actionsAuthorized} failed. The ceiling is ${formatPercent(grant.maxFailureRate)}, held until ${grant.minActionsBeforeAutoRevoke} actions have run.`
          }
          enterTouchDelay={0}
        >
          <Typography
            variant="body2"
            sx={NUMERIC}
            color={
              grant.failureRate === null ? 'text.secondary' : 'text.primary'
            }
          >
            {formatFailureRate(grant.failureRate)}
          </Typography>
        </Tooltip>
      ),
    },
    {
      /** VISION §8's attribute 4, in full. */
      id: 'autoRevoke',
      label: 'Auto-revoke',
      priority: 'detail',
      minWidth: 260,
      truncate: true,
      value: (grant) => describeAutoRevoke(grant),
    },
    {
      /**
       * WHY it ended. Never inferred from `status`: "suspended because the
       * failure rate crossed 34%" and "suspended because the class was demoted"
       * are different facts about the factory, and only this separates them.
       * `endDetail` — the sentence naming the real numbers — rides along.
       */
      id: 'endReason',
      label: 'How it ended',
      priority: 'detail',
      minWidth: 240,
      truncate: true,
      value: (grant) =>
        isAuthorizingGrant(grant.status) ? '' : endReasonLabel(grant.endReason),
      render: (grant) =>
        isAuthorizingGrant(grant.status) ? null : (
          <Stack spacing={0} sx={{ minWidth: 0 }}>
            <Typography variant="body2" noWrap>
              {endReasonLabel(grant.endReason)}
            </Typography>
            {grant.endDetail && (
              <Typography variant="caption" color="text.secondary">
                {grant.endDetail}
              </Typography>
            )}
          </Stack>
        ),
    },
    {
      id: 'createdAt',
      label: 'Granted',
      priority: 'detail',
      minWidth: 130,
      value: (grant) => grant.createdAt,
      render: (grant) => (
        <Typography variant="body2" color="text.secondary" noWrap>
          {formatRelativeTime(grant.createdAt) ?? 'at an unknown time'}
        </Typography>
      ),
    },
  ];
}
