import { useState, useCallback, useEffect } from 'react';
import type { PersonalAccessToken, PatCreatedResponse, PatDurationUnit } from '../types';
import {
  getPersonalAccessTokens as fetchTokensApi,
  createPersonalAccessToken as createTokenApi,
  revokePersonalAccessToken as revokeTokenApi,
} from '../services/api';
import { useIsMounted } from './useIsMounted';

interface UsePersonalAccessTokensResult {
  tokens: PersonalAccessToken[];
  isLoading: boolean;
  error: string | null;
  fetchTokens: () => Promise<void>;
  createToken: (data: {
    name: string;
    durationValue: number;
    durationUnit: PatDurationUnit;
  }) => Promise<PatCreatedResponse>;
  revokeToken: (id: string) => Promise<void>;
}

export function usePersonalAccessTokens(): UsePersonalAccessTokensResult {
  const [tokens, setTokens] = useState<PersonalAccessToken[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Every `setState` past an `await` is guarded: a request that settles after
  // the component is gone must not schedule an update on it. Only the state
  // write is skipped — what these functions return or throw is unchanged.
  const isMounted = useIsMounted();

  const fetchTokens = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await fetchTokensApi();
      if (isMounted()) setTokens(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch tokens';
      if (isMounted()) {
        setError(message);
        setTokens([]);
      }
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted]);

  const createToken = useCallback(
    async (data: {
      name: string;
      durationValue: number;
      durationUnit: PatDurationUnit;
    }): Promise<PatCreatedResponse> => {
      setError(null);
      try {
        const response = await createTokenApi(data);
        // Refresh the list
        await fetchTokens();
        return response;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to create token';
        if (isMounted()) setError(message);
        throw err;
      }
    },
    [fetchTokens, isMounted],
  );

  const revokeToken = useCallback(
    async (id: string) => {
      setError(null);
      try {
        await revokeTokenApi(id);
        // Refresh the list
        await fetchTokens();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to revoke token';
        if (isMounted()) setError(message);
        throw err;
      }
    },
    [fetchTokens, isMounted],
  );

  useEffect(() => {
    fetchTokens();
  }, [fetchTokens]);

  return {
    tokens,
    isLoading,
    error,
    fetchTokens,
    createToken,
    revokeToken,
  };
}
