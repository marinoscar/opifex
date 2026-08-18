import { useState, useCallback } from 'react';
import type { AllowedEmailEntry, AllowlistResponse } from '../types';
import type { AllowlistSortField } from '../services/api';
import {
  getAllowlist as fetchAllowlistApi,
  addToAllowlist as addToAllowlistApi,
  removeFromAllowlist as removeFromAllowlistApi,
} from '../services/api';
import { useIsMounted } from './useIsMounted';

/** The query `GET /api/allowlist` accepts. See `services/api.ts`. */
export interface AllowlistParams {
  page?: number;
  pageSize?: number;
  search?: string;
  status?: 'all' | 'pending' | 'claimed';
  sortBy?: AllowlistSortField;
  sortOrder?: 'asc' | 'desc';
}

interface UseAllowlistResult {
  entries: AllowedEmailEntry[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  isLoading: boolean;
  error: string | null;
  fetchAllowlist: (params?: AllowlistParams) => Promise<void>;
  addEmail: (email: string, notes?: string) => Promise<void>;
  removeEmail: (id: string) => Promise<void>;
}

export function useAllowlist(): UseAllowlistResult {
  const [entries, setEntries] = useState<AllowedEmailEntry[]>([]);
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

  const fetchAllowlist = useCallback(
    async (params?: AllowlistParams) => {
      setIsLoading(true);
      setError(null);
      try {
        const response: AllowlistResponse = await fetchAllowlistApi(params);
        if (isMounted()) {
          setEntries(response.items);
          setTotal(response.total);
          setPage(response.page);
          setPageSize(response.pageSize);
          setTotalPages(response.totalPages);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to fetch allowlist';
        if (isMounted()) {
          setError(message);
          setEntries([]);
        }
      } finally {
        if (isMounted()) setIsLoading(false);
      }
    },
    [isMounted],
  );

  const addEmail = useCallback(
    async (email: string, notes?: string) => {
      setError(null);
      try {
        await addToAllowlistApi(email, notes);
        // Refresh the list
        await fetchAllowlist({ page, pageSize });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to add email';
        if (isMounted()) setError(message);
        throw err;
      }
    },
    [fetchAllowlist, page, pageSize, isMounted],
  );

  const removeEmail = useCallback(
    async (id: string) => {
      setError(null);
      try {
        await removeFromAllowlistApi(id);
        // Refresh the list
        await fetchAllowlist({ page, pageSize });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to remove email';
        if (isMounted()) setError(message);
        throw err;
      }
    },
    [fetchAllowlist, page, pageSize, isMounted],
  );

  return {
    entries,
    total,
    page,
    pageSize,
    totalPages,
    isLoading,
    error,
    fetchAllowlist,
    addEmail,
    removeEmail,
  };
}
