/**
 * Admin → Users: the DataTable column contract (upstream template issue #67, epic #51).
 *
 * A sibling module rather than columns inlined in `UserList.tsx`, for the
 * reason every migrated table in this epic follows: the column list is the
 * table's PUBLIC shape — the thing a test, a CSV export and the two renderers
 * all read — while the page component is just the state that feeds it. Keeping
 * them apart means a test can assert the contract without mounting a page and
 * mocking its fetch layer.
 *
 * ## What `GET /api/users` actually honours
 *
 * `sortable` and `filterable` are declared ONLY where the endpoint can serve
 * them. Both default to `false` in the contract precisely because a control the
 * page cannot answer looks live and does nothing. Read off
 * `apps/api/src/users/dto/user-list-query.dto.ts`:
 *
 *   | query param | accepts                              | column here          |
 *   | ----------- | ------------------------------------ | -------------------- |
 *   | `sortBy`    | `email` \| `createdAt` \| `updatedAt` | `email`, `createdAt` |
 *   | `sortOrder` | `asc` \| `desc`                      | —                    |
 *   | `search`    | free text over email, displayName,   | `searchable` on      |
 *   |             | providerDisplayName (case-insens.)   | `email`,`displayName`|
 *   | `role`      | one role name (relation predicate)   | `roles`, `is` only   |
 *   | `isActive`  | `'true'` \| `'false'`                | `isActive`, `is` only|
 *
 * Everything else is display-only. In particular `createdAt` is SORTABLE but
 * not filterable — there is no date-range parameter — and `id` is neither.
 *
 * `roles` is filterable with `is` alone, not the enum default set: the API's
 * `role` param compiles to `userRoles: { some: { role: { name } } }`, which can
 * express "has this role" and nothing else. Offering `isNot` / `isAnyOf` would
 * be three operators backed by one.
 */

import { Avatar, Box, Chip, Stack, Typography } from '@mui/material';
import type { DataTableColumn } from '../datatable';
import type { UserSortField } from '../../services/api';
import type { UserListItem } from '../../types';

/**
 * Persistence key for `user_settings.dataTables`. A constant, never derived
 * from the route or the heading: it is a storage key and must survive a rename.
 */
export const TABLE_ID = 'admin-users';

/** The roles the RBAC seed defines (`apps/api/prisma/seed.ts`). */
export const AVAILABLE_ROLES = ['admin', 'contributor', 'viewer'] as const;

const ROLE_ENUM_VALUES = AVAILABLE_ROLES.map((role) => ({ value: role, label: role }));

/**
 * Column ids that are also valid `sortBy` values, and the narrowing that keeps
 * the two in step.
 *
 * `DataTableSortState.field` is a bare `string` — it comes back from a stored
 * layout, which is user-writable JSON. Narrowing here rather than casting at
 * the fetch boundary means a stale persisted sort on a column that has since
 * lost `sortable` is dropped, not sent to an endpoint that would 400 on it.
 */
const SORTABLE_FIELDS: readonly UserSortField[] = ['email', 'createdAt'];

export function asUserSortField(field: string | undefined): UserSortField | undefined {
  return SORTABLE_FIELDS.find((candidate) => candidate === field);
}

/** Effective display name: the user's own override, else the provider's. */
export function userDisplayName(user: UserListItem): string {
  return user.displayName || user.providerDisplayName || 'No name';
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString();
}

export function buildUserColumns(): DataTableColumn<UserListItem>[] {
  return [
    {
      /**
       * The row-unique `primary` column, and therefore the row's ACCESSIBLE
       * NAME: `rowAccessibleName()` takes the first visible `primary` column's
       * scalar and names every selection checkbox ("Select ada@example.com"),
       * every row-action button and every card after it.
       *
       * The avatar lives INSIDE this column's `render` rather than in a column
       * of its own. A thumbnail-only column has no scalar at all, so it would
       * export as an empty CSV cell, sort by nothing, and — worst — if it came
       * first it would hand `rowAccessibleName` an empty string and every
       * checkbox on the page would fall back to a UUID.
       *
       * `hideable: false` for the same reason: a user who hid this column would
       * be renaming every control on the page after whichever column happened
       * to be `primary` next.
       */
      id: 'email',
      label: 'Email',
      priority: 'primary',
      sortable: true, // sortBy=email
      searchable: true, // covered by ?search=
      hideable: false,
      minWidth: 240,
      flex: 1.4,
      value: (user) => user.email,
      render: (user) => (
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', minWidth: 0 }}>
          <Avatar
            src={user.profileImageUrl || undefined}
            alt={user.email}
            sx={{ width: 32, height: 32, flexShrink: 0 }}
          >
            {user.email[0]?.toUpperCase()}
          </Avatar>
          <Typography variant="body2" noWrap sx={{ minWidth: 0 }}>
            {user.email}
          </Typography>
        </Stack>
      ),
    },
    {
      /**
       * Not sortable — `sortBy` has no `isActive` member. Filterable with `is`
       * only, mapped by the page onto `?isActive=true|false`.
       */
      id: 'isActive',
      label: 'Status',
      priority: 'primary',
      filterable: ['is'],
      filterType: 'enum',
      enumValues: [
        { value: 'active', label: 'Active' },
        { value: 'inactive', label: 'Inactive' },
      ],
      width: 120,
      value: (user) => (user.isActive ? 'Active' : 'Inactive'),
      render: (user) =>
        user.isActive ? (
          <Chip label="Active" color="success" size="small" />
        ) : (
          <Chip label="Inactive" color="error" size="small" />
        ),
    },
    {
      id: 'displayName',
      label: 'Display Name',
      priority: 'secondary',
      searchable: true, // ?search= covers displayName AND providerDisplayName
      minWidth: 160,
      flex: 1,
      value: userDisplayName,
    },
    {
      id: 'roles',
      label: 'Roles',
      priority: 'secondary',
      filterable: ['is'], // ?role=<name>; see the module docblock
      filterType: 'enum',
      enumValues: ROLE_ENUM_VALUES,
      minWidth: 160,
      value: (user) => user.roles.join(', '),
      render: (user) => (
        <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
          {user.roles.map((role) => (
            <Chip key={role} label={role} size="small" />
          ))}
        </Box>
      ),
    },
    {
      id: 'createdAt',
      label: 'Created',
      priority: 'detail',
      sortable: true, // sortBy=createdAt (the endpoint's default order)
      width: 130,
      value: (user) => formatDate(user.createdAt),
    },
    {
      id: 'id',
      label: 'ID',
      priority: 'detail',
      truncate: true,
      minWidth: 160,
      value: (user) => user.id,
    },
  ];
}
