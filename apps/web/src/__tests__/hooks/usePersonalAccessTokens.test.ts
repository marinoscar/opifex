import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { usePersonalAccessTokens } from '../../hooks/usePersonalAccessTokens';
import * as api from '../../services/api';
import type { PersonalAccessToken, PatCreatedResponse } from '../../types';

// Mock the API module
vi.mock('../../services/api', () => ({
  getPersonalAccessTokens: vi.fn(),
  createPersonalAccessToken: vi.fn(),
  revokePersonalAccessToken: vi.fn(),
}));

// Mock data
const mockToken1: PersonalAccessToken = {
  id: 'pat-id-1',
  name: 'CI Pipeline Token',
  tokenPrefix: 'pat_ab12',
  durationValue: 30,
  durationUnit: 'days',
  expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  lastUsedAt: null,
  createdAt: new Date().toISOString(),
  revokedAt: null,
};

const mockToken2: PersonalAccessToken = {
  id: 'pat-id-2',
  name: 'Local Dev Token',
  tokenPrefix: 'pat_cd34',
  durationValue: 7,
  durationUnit: 'days',
  expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  lastUsedAt: new Date().toISOString(),
  createdAt: new Date().toISOString(),
  revokedAt: null,
};

const mockCreatedResponse: PatCreatedResponse = {
  token: 'pat_abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
  id: 'pat-id-new',
  name: 'New Token',
  tokenPrefix: 'pat_abcd',
  expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  createdAt: new Date().toISOString(),
};

describe('usePersonalAccessTokens', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ============================================================================
  // Initial state and auto-fetch
  // ============================================================================

  describe('Initial State', () => {
    it('should start with empty tokens', () => {
      vi.mocked(api.getPersonalAccessTokens).mockResolvedValue([mockToken1]);

      const { result } = renderHook(() => usePersonalAccessTokens());

      // Before initial fetch resolves
      expect(result.current.tokens).toEqual([]);
    });

    it('should start with isLoading true while initial fetch is in progress', async () => {
      let resolve: (tokens: PersonalAccessToken[]) => void;
      const promise = new Promise<PersonalAccessToken[]>((r) => { resolve = r; });

      vi.mocked(api.getPersonalAccessTokens).mockReturnValue(promise);

      const { result } = renderHook(() => usePersonalAccessTokens());

      expect(result.current.isLoading).toBe(true);

      await act(async () => {
        resolve!([]);
        await promise;
      });

      await waitFor(() => expect(result.current.isLoading).toBe(false));
    });

    it('should start with null error', () => {
      vi.mocked(api.getPersonalAccessTokens).mockResolvedValue([]);

      const { result } = renderHook(() => usePersonalAccessTokens());

      expect(result.current.error).toBeNull();
    });

    it('should provide fetchTokens, createToken, and revokeToken functions', () => {
      vi.mocked(api.getPersonalAccessTokens).mockResolvedValue([]);

      const { result } = renderHook(() => usePersonalAccessTokens());

      expect(typeof result.current.fetchTokens).toBe('function');
      expect(typeof result.current.createToken).toBe('function');
      expect(typeof result.current.revokeToken).toBe('function');
    });
  });

  // ============================================================================
  // fetchTokens
  // ============================================================================

  describe('fetchTokens', () => {
    it('should fetch and set tokens on success', async () => {
      vi.mocked(api.getPersonalAccessTokens).mockResolvedValue([mockToken1, mockToken2]);

      const { result } = renderHook(() => usePersonalAccessTokens());

      await waitFor(() => expect(result.current.isLoading).toBe(false));

      expect(result.current.tokens).toEqual([mockToken1, mockToken2]);
      expect(result.current.error).toBeNull();
    });

    it('should automatically fetch tokens on mount', async () => {
      vi.mocked(api.getPersonalAccessTokens).mockResolvedValue([mockToken1]);

      const { result } = renderHook(() => usePersonalAccessTokens());

      await waitFor(() => expect(result.current.isLoading).toBe(false));

      expect(api.getPersonalAccessTokens).toHaveBeenCalledTimes(1);
      expect(result.current.tokens).toHaveLength(1);
    });

    it('should set isLoading to false when fetch completes', async () => {
      vi.mocked(api.getPersonalAccessTokens).mockResolvedValue([]);

      const { result } = renderHook(() => usePersonalAccessTokens());

      await waitFor(() => expect(result.current.isLoading).toBe(false));
    });

    it('should set error and empty tokens when fetch fails', async () => {
      vi.mocked(api.getPersonalAccessTokens).mockRejectedValue(new Error('Network error'));

      const { result } = renderHook(() => usePersonalAccessTokens());

      await waitFor(() => expect(result.current.isLoading).toBe(false));

      expect(result.current.error).toBe('Network error');
      expect(result.current.tokens).toEqual([]);
    });

    it('should use a generic error message for non-Error failures', async () => {
      vi.mocked(api.getPersonalAccessTokens).mockRejectedValue('some string error');

      const { result } = renderHook(() => usePersonalAccessTokens());

      await waitFor(() => expect(result.current.isLoading).toBe(false));

      expect(result.current.error).toBe('Failed to fetch tokens');
    });

    it('should clear error on successful re-fetch', async () => {
      vi.mocked(api.getPersonalAccessTokens)
        .mockRejectedValueOnce(new Error('First failure'))
        .mockResolvedValueOnce([mockToken1]);

      const { result } = renderHook(() => usePersonalAccessTokens());

      await waitFor(() => expect(result.current.error).toBe('First failure'));

      await act(async () => {
        await result.current.fetchTokens();
      });

      await waitFor(() => expect(result.current.error).toBeNull());
      expect(result.current.tokens).toEqual([mockToken1]);
    });

    it('should handle empty token list', async () => {
      vi.mocked(api.getPersonalAccessTokens).mockResolvedValue([]);

      const { result } = renderHook(() => usePersonalAccessTokens());

      await waitFor(() => expect(result.current.isLoading).toBe(false));

      expect(result.current.tokens).toEqual([]);
      expect(result.current.error).toBeNull();
    });
  });

  // ============================================================================
  // createToken
  // ============================================================================

  describe('createToken', () => {
    it('should return the PatCreatedResponse with raw token', async () => {
      // Initial fetch returns empty list
      vi.mocked(api.getPersonalAccessTokens)
        .mockResolvedValueOnce([]) // initial mount fetch
        .mockResolvedValueOnce([mockToken1]); // refresh after create

      vi.mocked(api.createPersonalAccessToken).mockResolvedValue(mockCreatedResponse);

      const { result } = renderHook(() => usePersonalAccessTokens());
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      let response!: PatCreatedResponse;
      await act(async () => {
        response = await result.current.createToken({
          name: 'New Token',
          durationValue: 30,
          durationUnit: 'days',
        });
      });

      expect(response).toEqual(mockCreatedResponse);
      expect(response.token).toMatch(/^pat_/);
    });

    it('should call createPersonalAccessToken with correct data', async () => {
      vi.mocked(api.getPersonalAccessTokens).mockResolvedValue([]);
      vi.mocked(api.createPersonalAccessToken).mockResolvedValue(mockCreatedResponse);

      const { result } = renderHook(() => usePersonalAccessTokens());
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await act(async () => {
        await result.current.createToken({
          name: 'My Token',
          durationValue: 15,
          durationUnit: 'minutes',
        });
      });

      expect(api.createPersonalAccessToken).toHaveBeenCalledWith({
        name: 'My Token',
        durationValue: 15,
        durationUnit: 'minutes',
      });
    });

    it('should refresh the token list after creating', async () => {
      const newToken: PersonalAccessToken = {
        id: mockCreatedResponse.id,
        name: mockCreatedResponse.name,
        tokenPrefix: mockCreatedResponse.tokenPrefix,
        durationValue: 30,
        durationUnit: 'days',
        expiresAt: mockCreatedResponse.expiresAt,
        lastUsedAt: null,
        createdAt: mockCreatedResponse.createdAt,
        revokedAt: null,
      };

      vi.mocked(api.getPersonalAccessTokens)
        .mockResolvedValueOnce([]) // initial mount fetch
        .mockResolvedValueOnce([newToken]); // refresh after create

      vi.mocked(api.createPersonalAccessToken).mockResolvedValue(mockCreatedResponse);

      const { result } = renderHook(() => usePersonalAccessTokens());
      await waitFor(() => expect(result.current.tokens).toEqual([]));

      await act(async () => {
        await result.current.createToken({
          name: 'New Token',
          durationValue: 30,
          durationUnit: 'days',
        });
      });

      await waitFor(() => expect(result.current.tokens).toHaveLength(1));
      expect(result.current.tokens[0].id).toBe(mockCreatedResponse.id);
    });

    it('should set error and rethrow when create fails', async () => {
      vi.mocked(api.getPersonalAccessTokens).mockResolvedValue([]);
      vi.mocked(api.createPersonalAccessToken).mockRejectedValue(new Error('Create failed'));

      const { result } = renderHook(() => usePersonalAccessTokens());
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      let caughtError: Error | null = null;
      await act(async () => {
        try {
          await result.current.createToken({
            name: 'Token',
            durationValue: 30,
            durationUnit: 'days',
          });
        } catch (err) {
          caughtError = err as Error;
        }
      });

      expect(caughtError).not.toBeNull();
      expect((caughtError as Error).message).toBe('Create failed');
      await waitFor(() => expect(result.current.error).toBe('Create failed'));
    });

    it('should clear error before attempting create', async () => {
      vi.mocked(api.getPersonalAccessTokens)
        .mockRejectedValueOnce(new Error('Initial error'))
        .mockResolvedValue([]);

      vi.mocked(api.createPersonalAccessToken).mockResolvedValue(mockCreatedResponse);

      const { result } = renderHook(() => usePersonalAccessTokens());
      await waitFor(() => expect(result.current.error).toBe('Initial error'));

      await act(async () => {
        await result.current.createToken({
          name: 'Token',
          durationValue: 30,
          durationUnit: 'days',
        });
      });

      expect(result.current.error).toBeNull();
    });
  });

  // ============================================================================
  // revokeToken
  // ============================================================================

  describe('revokeToken', () => {
    it('should call revokePersonalAccessToken with the token id', async () => {
      vi.mocked(api.getPersonalAccessTokens).mockResolvedValue([mockToken1, mockToken2]);
      vi.mocked(api.revokePersonalAccessToken).mockResolvedValue(undefined);

      const { result } = renderHook(() => usePersonalAccessTokens());
      await waitFor(() => expect(result.current.tokens).toHaveLength(2));

      await act(async () => {
        await result.current.revokeToken('pat-id-1');
      });

      expect(api.revokePersonalAccessToken).toHaveBeenCalledWith('pat-id-1');
    });

    it('should refresh the token list after revoking', async () => {
      vi.mocked(api.getPersonalAccessTokens)
        .mockResolvedValueOnce([mockToken1, mockToken2]) // initial mount
        .mockResolvedValueOnce([mockToken2]); // refresh after revoke (token1 gone)

      vi.mocked(api.revokePersonalAccessToken).mockResolvedValue(undefined);

      const { result } = renderHook(() => usePersonalAccessTokens());
      await waitFor(() => expect(result.current.tokens).toHaveLength(2));

      await act(async () => {
        await result.current.revokeToken('pat-id-1');
      });

      await waitFor(() => expect(result.current.tokens).toHaveLength(1));
      expect(result.current.tokens[0].id).toBe('pat-id-2');
    });

    it('should set error and rethrow when revoke fails', async () => {
      vi.mocked(api.getPersonalAccessTokens).mockResolvedValue([mockToken1]);
      vi.mocked(api.revokePersonalAccessToken).mockRejectedValue(new Error('Revoke failed'));

      const { result } = renderHook(() => usePersonalAccessTokens());
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      let caughtError: Error | null = null;
      await act(async () => {
        try {
          await result.current.revokeToken('pat-id-1');
        } catch (err) {
          caughtError = err as Error;
        }
      });

      expect(caughtError).not.toBeNull();
      expect((caughtError as Error).message).toBe('Revoke failed');
      await waitFor(() => expect(result.current.error).toBe('Revoke failed'));
    });

    it('should use generic error message for non-Error failures on revoke', async () => {
      vi.mocked(api.getPersonalAccessTokens).mockResolvedValue([mockToken1]);
      vi.mocked(api.revokePersonalAccessToken).mockRejectedValue('unknown failure');

      const { result } = renderHook(() => usePersonalAccessTokens());
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await act(async () => {
        try {
          await result.current.revokeToken('pat-id-1');
        } catch {
          // expected
        }
      });

      await waitFor(() => expect(result.current.error).toBe('Failed to revoke token'));
    });

    it('should clear error before attempting revoke', async () => {
      vi.mocked(api.getPersonalAccessTokens)
        .mockRejectedValueOnce(new Error('Initial fetch error'))
        .mockResolvedValue([mockToken1]);

      vi.mocked(api.revokePersonalAccessToken).mockResolvedValue(undefined);

      const { result } = renderHook(() => usePersonalAccessTokens());
      await waitFor(() => expect(result.current.error).toBe('Initial fetch error'));

      await act(async () => {
        await result.current.revokeToken('pat-id-1');
      });

      expect(result.current.error).toBeNull();
    });
  });
});
