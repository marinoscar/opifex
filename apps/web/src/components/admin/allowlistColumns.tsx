/**
 * Admin → Allowlist: the DataTable column contract (upstream template issue #67, epic #51).
 *
 * ## What `GET /api/allowlist` actually honours
 *
 * Read off `apps/api/src/allowlist/dto/allowlist-query.dto.ts` and
 * `allowlist.service.ts`:
 *
 *   | query param | accepts                               | column here |
 *   | ----------- | ------------------------------------- | ----------- |
 *   | `sortBy`    | `email` \| `addedAt` \| `claimedAt`   | `email`, `addedAt` |
 *   | `sortOrder` | `asc` \| `desc`                       | — |
 *   | `search`    | `email contains`, case-insensitive    | `email` (`searchable`) |
 *   | `status`    | `all` \| `pending` \| `claimed`       | `status` (`is` only) |
 *
 * `addedBy` and `notes` are display-only: the service builds its `where` from
 * `email` and `claimedById` and nothing else, so declaring either sortable or
 * filterable would put a live-looking control on the page that the endpoint
 * cannot answer.
 *
 * ## Why `status` is a real column and not `filterOnly`
 *
 * `DataTableColumn.filterOnly` exists for query parameters with no cell, and
 * `datatable/types.ts` cites this very endpoint's `status` as the motivating
 * example — because in the origin project the allowlist had no status CELL, and
 * a decorative column reading `pending` on all 25 rows is worse than none.
 *
 * Here the status IS drawn: it is a `primary` chip, one of the two facts that
 * identify an entry at a glance on a phone. Since the cell exists anyway, the
 * filter rides on the same declaration rather than shadowing it with a second,
 * invisible "Status" entry in the filter menu. `value` returns the chip's own
 * text; the page maps `enumValues` (`pending` / `claimed`) onto `?status=`.
 *
 * Only `is` is offered: the predicate behind `status` is a nullness test on
 * `claimedById` with exactly three settings (all / pending / claimed), so
 * `isNot` and `isAnyOf` would be operators with nothing extra behind them.
 */

import { Chip, Typography } from '@mui/material';
import type { DataTableColumn } from '../datatable';
import type { AllowlistSortField } from '../../services/api';
import type { AllowedEmailEntry } from '../../types';

/** Persistence key for `user_settings.dataTables`. */
export const TABLE_ID = 'admin-allowlist';

/** Column ids that are also valid `sortBy` values. */
const SORTABLE_FIELDS: readonly AllowlistSortField[] = ['email', 'addedAt'];

export function asAllowlistSortField(
  field: string | undefined,
): AllowlistSortField | undefined {
  return SORTABLE_FIELDS.find((candidate) => candidate === field);
}

/** `true` once the invited address has completed a first sign-in. */
export function isClaimed(entry: AllowedEmailEntry): boolean {
  return Boolean(entry.claimedBy);
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString();
}

export function buildAllowlistColumns(): DataTableColumn<AllowedEmailEntry>[] {
  return [
    {
      // Row-unique and therefore the row's accessible name — every checkbox,
      // row-action button and card is named after it. Pinned visible for the
      // same reason `admin-users` pins its email column.
      id: 'email',
      label: 'Email',
      priority: 'primary',
      sortable: true, // sortBy=email
      searchable: true, // ?search= is an `email contains` predicate
      hideable: false,
      minWidth: 240,
      flex: 1.4,
      value: (entry) => entry.email,
    },
    {
      id: 'status',
      label: 'Status',
      priority: 'primary',
      filterable: ['is'], // ?status=pending|claimed
      filterType: 'enum',
      enumValues: [
        { value: 'pending', label: 'Pending' },
        { value: 'claimed', label: 'Claimed' },
      ],
      width: 120,
      value: (entry) => (isClaimed(entry) ? 'Claimed' : 'Pending'),
      render: (entry) =>
        isClaimed(entry) ? (
          <Chip label="Claimed" color="success" size="small" />
        ) : (
          <Chip label="Pending" color="warning" size="small" />
        ),
    },
    {
      id: 'addedBy',
      label: 'Added By',
      priority: 'secondary',
      minWidth: 200,
      // A null `addedById` is a seeded entry, not a missing one — the word
      // "System" is the correct scalar, so it goes in `value` and reaches the
      // CSV too, rather than being a render-only flourish.
      value: (entry) => (entry.addedBy ? entry.addedBy.email : 'System'),
    },
    {
      id: 'addedAt',
      label: 'Added Date',
      priority: 'secondary',
      sortable: true, // sortBy=addedAt (the endpoint's default order)
      minWidth: 180,
      value: (entry) => formatDateTime(entry.addedAt),
    },
    {
      /**
       * `truncate` rather than a `maxWidth` on a `<Typography>`: notes run to
       * 500 characters (`addEmailSchema`), and a wrapping cell would set the
       * height of every row in the grid to suit one entry. The full text stays
       * reachable through the truncation tooltip, and the card renderer folds
       * this column into its expandable region where wrapping is free.
       */
      id: 'notes',
      label: 'Notes',
      priority: 'detail',
      truncate: true,
      minWidth: 200,
      flex: 1,
      value: (entry) => entry.notes,
      render: (entry) =>
        entry.notes ? (
          <Typography variant="body2" noWrap>
            {entry.notes}
          </Typography>
        ) : (
          <Typography variant="body2" color="text.secondary">
            -
          </Typography>
        ),
    },
  ];
}
