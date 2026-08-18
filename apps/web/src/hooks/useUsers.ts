import { useState, useCallback } from 'react';
import type { UserListItem, UsersResponse } from '../types';
import type { UserSortField } from '../services/api';
import {
  getUsers as getUsersApi,
  updateUser as updateUserApi,
  updateUserRoles as updateUserRolesApi,
} from '../services/api';
import { useIsMounted } from './useIsMounted';

/**
 * The query `GET /api/users` accepts. `sortBy` is the endpoint's own enum
 * (see `services/api.ts`), so a table column that declares itself sortable
 * against an unsupported field will not compile.
 */
export interface UserListParams {
  page?: number;
  pageSize?: number;
  search?: string;
  role?: string;
  isActive?: boolean;
  sortBy?: UserSortField;
  sortOrder?: 'asc' | 'desc';
}

interface UseUsersResult {
  users: UserListItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  isLoading: boolean;
  error: string | null;
  fetchUsers: (params?: UserListParams) => Promise<void>;
  updateUser: (
    id: string,
    data: { displayName?: string; isActive?: boolean },
  ) => Promise<void>;
  updateUserRoles: (id: string, roles: string[]) => Promise<void>;
}

export function useUsers(): UseUsersResult {
  const [users, setUsers] = useState<UserListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [totalPages, setTotalPages] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Every `setState` past an `await` is guarded: a request that settles after
  // the component is gone must not schedule an update on it. Only the state
  // write is skipped — what these functions return or throw is unchanged.
  const isMounted = useIsMounted();

  const fetchUsers = useCallback(
    async (params?: UserListParams) => {
      setIsLoading(true);
      setError(null);
      try {
        const response: UsersResponse = await getUsersApi(params);
        if (isMounted()) {
          setUsers(response.items);
          setTotal(response.total);
          setPage(response.page);
          setPageSize(response.pageSize);
          setTotalPages(response.totalPages);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to fetch users';
        if (isMounted()) {
          setError(message);
          setUsers([]);
        }
      } finally {
        if (isMounted()) setIsLoading(false);
      }
    },
    [isMounted],
  );

  const updateUser = useCallback(
    async (id: string, data: { displayName?: string; isActive?: boolean }) => {
      setError(null);
      try {
        const updatedUser = await updateUserApi(id, data);
        // Update the user in the list
        if (isMounted()) {
          setUsers((prevUsers) =>
            prevUsers.map((user) => (user.id === id ? updatedUser : user)),
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to update user';
        if (isMounted()) setError(message);
        throw err;
      }
    },
    [isMounted],
  );

  const updateUserRoles = useCallback(
    async (id: string, roles: string[]) => {
      setError(null);
      try {
        const updatedUser = await updateUserRolesApi(id, roles);
        // Update the user in the list
        if (isMounted()) {
          setUsers((prevUsers) =>
            prevUsers.map((user) => (user.id === id ? updatedUser : user)),
          );
        }
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Failed to update user roles';
        if (isMounted()) setError(message);
        throw err;
      }
    },
    [isMounted],
  );

  return {
    users,
    total,
    page,
    pageSize,
    totalPages,
    isLoading,
    error,
    fetchUsers,
    updateUser,
    updateUserRoles,
  };
}
