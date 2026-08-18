/**
 * Admin → Users (issue #67, epic #51).
 *
 * The hand-rolled `TableContainer` / `TablePagination` / `MoreVert` block this
 * file used to be is gone wholesale — not wrapped — and replaced by the shared
 * `DataTable`. What remains here is state: the query this page sends, the
 * selection it holds, and the dialog its row action opens.
 *
 * Four rules from the migration brief are load-bearing in this file:
 *
 *  1. **The table renders unconditionally; `loading` is a prop.** The previous
 *     `{isLoading ? <CircularProgress/> : <Table/>}` ternary UNMOUNTED the
 *     whole table on every refetch, taking row expansion, scroll offset and
 *     grid focus with it. `DataTable` draws a loading overlay above rows that
 *     stay on screen.
 *  2. **Refetch effects key on SCALARS.** Never on `filters` (an array) or on a
 *     row object: `useUsers` hands back brand-new objects on every fetch, so an
 *     effect keyed on one would refetch forever.
 *  3. **The row-action ARRAY is gated, never a rendered control.** A user
 *     without `users:write` gets an array that does not CONTAIN the activate /
 *     deactivate actions, so they are absent from the grid, the tablet expander
 *     and the card header at once. The old code hid a `<TableCell>` — a
 *     grid-shaped gate no card renderer can reproduce.
 *  4. **A per-row `disabled` replaces "render nothing".** "Activate user" stays
 *     visible (and tooltipped) on an already-active user rather than vanishing,
 *     so the set of actions does not change shape row to row.
 */

import { useEffect, useMemo, useState } from 'react';
import { Alert, Box, Paper, Typography } from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import BlockIcon from '@mui/icons-material/Block';
import SecurityIcon from '@mui/icons-material/Security';
import { DataTable } from '../datatable';
import type {
  DataTableFilterModel,
  DataTableRowAction,
  DataTableSortState,
} from '../datatable';
import { useUsers } from '../../hooks/useUsers';
import { usePermissions } from '../../hooks/usePermissions';
import { getUsers } from '../../services/api';
import type { UserListItem } from '../../types';
import { ManageRolesDialog } from './ManageRolesDialog';
import { TABLE_ID, asUserSortField, buildUserColumns } from './userListColumns';

/**
 * Read a single-operand `is` filter out of the model as a plain string.
 *
 * Returning a SCALAR (not the filter object) is what lets the refetch effect
 * below depend on it directly — see rule 2 in the module docblock.
 */
function readIsFilter(filters: DataTableFilterModel, columnId: string): string | undefined {
  const found = filters.find(
    (filter) => filter.columnId === columnId && filter.operator === 'is',
  );
  return typeof found?.value === 'string' && found.value ? found.value : undefined;
}

export function UserList() {
  const { users, total, isLoading, error, fetchUsers, updateUser, updateUserRoles } =
    useUsers();
  const { hasPermission } = usePermissions();

  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(10);
  const [sort, setSort] = useState<DataTableSortState | null>(null);
  const [filters, setFilters] = useState<DataTableFilterModel>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [rolesDialogUser, setRolesDialogUser] = useState<UserListItem | null>(null);

  const columns = useMemo(() => buildUserColumns(), []);

  // --- Query params, flattened to scalars ------------------------------------
  const roleFilter = useMemo(() => readIsFilter(filters, 'roles'), [filters]);
  const statusFilter = useMemo(() => readIsFilter(filters, 'isActive'), [filters]);
  // Narrowed against the endpoint's `sortBy` enum: a stored layout is
  // user-writable JSON, so an unrecognised field is dropped rather than sent.
  const sortField = asUserSortField(sort?.field);
  const sortDirection = sort?.direction;

  useEffect(() => {
    fetchUsers({
      page: page + 1, // the table is zero-based, the API is one-based
      pageSize,
      search: search || undefined,
      role: roleFilter,
      isActive: statusFilter === undefined ? undefined : statusFilter === 'active',
      ...(sortField ? { sortBy: sortField, sortOrder: sortDirection } : {}),
    });
    // Every dependency is a scalar. `fetchUsers` is `useCallback([])`-stable.
  }, [
    page,
    pageSize,
    search,
    roleFilter,
    statusFilter,
    sortField,
    sortDirection,
    fetchUsers,
  ]);

  // --- Row actions ------------------------------------------------------------
  // `hasPermission` is memoized by `usePermissions`, so keying this on it is
  // safe and the array keeps its identity between renders.
  const rowActions = useMemo(() => {
    const actions: DataTableRowAction<UserListItem>[] = [];

    // PATCH /api/users/{id} enforces users:read + users:write.
    if (hasPermission('users:write')) {
      actions.push(
        {
          id: 'activate',
          label: 'Activate user',
          icon: <CheckCircleIcon fontSize="small" />,
          disabled: (user) => user.isActive,
          onClick: (user) => {
            void updateUser(user.id, { isActive: true }).catch(() => {
              /* surfaced through the hook's `error` */
            });
          },
        },
        {
          id: 'deactivate',
          label: 'Deactivate user',
          icon: <BlockIcon fontSize="small" />,
          destructive: true,
          disabled: (user) => !user.isActive,
          onClick: (user) => {
            void updateUser(user.id, { isActive: false }).catch(() => {
              /* surfaced through the hook's `error` */
            });
          },
        },
      );
    }

    // PUT /api/users/{id}/roles enforces rbac:manage — a different permission
    // from the two above, so it is a separate gate rather than one `isAdmin`.
    if (hasPermission('rbac:manage')) {
      actions.push({
        id: 'manage-roles',
        label: 'Manage roles',
        icon: <SecurityIcon fontSize="small" />,
        onClick: (user) => setRolesDialogUser(user),
      });
    }

    return actions;
  }, [hasPermission, updateUser]);

  const emptyState = useMemo(
    () => (
      <Typography color="text.secondary">
        {search ? 'No users found matching your search' : 'No users found'}
      </Typography>
    ),
    [search],
  );

  return (
    <Paper sx={{ width: '100%', p: 2 }}>
      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      <Box sx={{ minWidth: 0 }}>
        <DataTable<UserListItem>
          tableId={TABLE_ID}
          data-testid="admin-users-table"
          ariaLabel="Users"
          columns={columns}
          rows={users}
          rowId={(user) => user.id}
          loading={isLoading}
          emptyState={emptyState}
          pagination={{
            page,
            pageSize,
            total,
            pageSizeOptions: [5, 10, 25, 50],
            onPaginationChange: (next) => {
              setPage(next.page);
              setPageSize(next.pageSize);
            },
          }}
          sort={{ sort, onSortChange: setSort }}
          filters={filters}
          onFiltersChange={(next) => {
            setFilters(next);
            setPage(0);
          }}
          quickSearch={{
            value: search,
            ariaLabel: 'Search by email or name',
            placeholder: 'Search by email or name',
            onChange: (next) => {
              setSearch(next);
              setPage(0);
            },
          }}
          selection={{
            selectedIds,
            onSelectionChange: setSelectedIds,
          }}
          rowActions={rowActions}
          csvExport={{
            filename: 'users',
            // Replays THIS page's own query, so an export can only ever contain
            // what the user's own list request already returns.
            fetchAllRows: async ({ page: exportPage, pageSize: exportPageSize }) => {
              const response = await getUsers({
                page: exportPage + 1,
                pageSize: exportPageSize,
                search: search || undefined,
                role: roleFilter,
                isActive: statusFilter === undefined ? undefined : statusFilter === 'active',
              });
              return response.items;
            },
          }}
        />
      </Box>

      <ManageRolesDialog
        user={rolesDialogUser}
        onClose={() => setRolesDialogUser(null)}
        onSave={updateUserRoles}
      />
    </Paper>
  );
}
