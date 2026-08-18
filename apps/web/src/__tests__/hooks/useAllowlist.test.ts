import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useAllowlist } from '../../hooks/useAllowlist';
import * as api from '../../services/api';
import type { AllowlistResponse, AllowedEmailEntry } from '../../types';

// Mock the API module
vi.mock('../../services/api', () => ({
  getAllowlist: vi.fn(),
  addToAllowlist: vi.fn(),
  removeFromAllowlist: vi.fn(),
}));

// Mock data
const mockAllowedEmail1: AllowedEmailEntry = {
  id: 'entry-1',
  email: 'user1@example.com',
  addedBy: { id: 'admin-1', email: 'admin@example.com' },
  addedAt: '2026-01-20T10:00:00Z',
  claimedBy: null,
  claimedAt: null,
  notes: 'Test user 1',
};

const mockAllowedEmail2: AllowedEmailEntry = {
  id: 'entry-2',
  email: 'user2@example.com',
  addedBy: { id: 'admin-1', email: 'admin@example.com' },
  addedAt: '2026-01-21T10:00:00Z',
  claimedBy: { id: 'user-2', email: 'user2@example.com' },
  claimedAt: '2026-01-21T12:00:00Z',
  notes: null,
};

const mockAllowedEmail3: AllowedEmailEntry = {
  id: 'entry-3',
  email: 'user3@example.com',
  addedBy: { id: 'admin-1', email: 'admin@example.com' },
  addedAt: '2026-01-22T10:00:00Z',
  claimedBy: null,
  claimedAt: null,
  notes: 'Pending user',
};

const mockAllowlistResponse: AllowlistResponse = {
  items: [mockAllowedEmail1, mockAllowedEmail2, mockAllowedEmail3],
  total: 3,
  page: 1,
  pageSize: 10,
  totalPages: 1,
};

describe('useAllowlist', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Initial Loading State', () => {
    it('should start with empty entries and not loading', () => {
      const { result } = renderHook(() => useAllowlist());

      expect(result.current.entries).toEqual([]);
      expect(result.current.total).toBe(0);
      expect(result.current.page).toBe(1);
      expect(result.current.pageSize).toBe(10);
      expect(result.current.totalPages).toBe(0);
      expect(result.current.isLoading).toBe(false);
      expect(result.current.error).toBeNull();
    });

    it('should provide all expected functions', () => {
      const { result } = renderHook(() => useAllowlist());

      expect(typeof result.current.fetchAllowlist).toBe('function');
      expect(typeof result.current.addEmail).toBe('function');
      expect(typeof result.current.removeEmail).toBe('function');
    });
  });

  describe('Successful Allowlist Fetch with Pagination', () => {
    it('should fetch allowlist data successfully', async () => {
      vi.mocked(api.getAllowlist).mockResolvedValue(mockAllowlistResponse);

      const { result } = renderHook(() => useAllowlist());

      await act(async () => {
        await result.current.fetchAllowlist();
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(api.getAllowlist).toHaveBeenCalledWith(undefined);
      expect(result.current.entries).toEqual(mockAllowlistResponse.items);
      expect(result.current.total).toBe(3);
      expect(result.current.page).toBe(1);
      expect(result.current.pageSize).toBe(10);
      expect(result.current.totalPages).toBe(1);
      expect(result.current.error).toBeNull();
    });

    it('should set loading state during fetch', async () => {
      let resolveAllowlist: (value: AllowlistResponse) => void;
      const allowlistPromise = new Promise<AllowlistResponse>((resolve) => {
        resolveAllowlist = resolve;
      });
      vi.mocked(api.getAllowlist).mockReturnValue(allowlistPromise);

      const { result } = renderHook(() => useAllowlist());

      expect(result.current.isLoading).toBe(false);

      act(() => {
        result.current.fetchAllowlist();
      });

      expect(result.current.isLoading).toBe(true);

      await act(async () => {
        resolveAllowlist!(mockAllowlistResponse);
        await allowlistPromise;
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });
    });

    it('should fetch with pagination parameters', async () => {
      const pageResponse: AllowlistResponse = {
        items: [mockAllowedEmail2],
        total: 3,
        page: 2,
        pageSize: 1,
        totalPages: 3,
      };
      vi.mocked(api.getAllowlist).mockResolvedValue(pageResponse);

      const { result } = renderHook(() => useAllowlist());

      await act(async () => {
        await result.current.fetchAllowlist({ page: 2, pageSize: 1 });
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(api.getAllowlist).toHaveBeenCalledWith({ page: 2, pageSize: 1 });
      expect(result.current.entries).toEqual([mockAllowedEmail2]);
      expect(result.current.page).toBe(2);
      expect(result.current.pageSize).toBe(1);
      expect(result.current.total).toBe(3);
      expect(result.current.totalPages).toBe(3);
    });

    it('should fetch with search parameter', async () => {
      vi.mocked(api.getAllowlist).mockResolvedValue(mockAllowlistResponse);

      const { result } = renderHook(() => useAllowlist());

      await act(async () => {
        await result.current.fetchAllowlist({ search: 'user1@example.com' });
      });

      expect(api.getAllowlist).toHaveBeenCalledWith({
        search: 'user1@example.com',
      });
    });

    it('should update pagination state from response', async () => {
      const multiPageResponse: AllowlistResponse = {
        items: [mockAllowedEmail1],
        total: 25,
        page: 3,
        pageSize: 10,
        totalPages: 3,
      };
      vi.mocked(api.getAllowlist).mockResolvedValue(multiPageResponse);

      const { result } = renderHook(() => useAllowlist());

      await act(async () => {
        await result.current.fetchAllowlist({ page: 3, pageSize: 10 });
      });

      await waitFor(() => {
        expect(result.current.page).toBe(3);
        expect(result.current.pageSize).toBe(10);
        expect(result.current.total).toBe(25);
        expect(result.current.totalPages).toBe(3);
      });
    });
  });

  describe('Error Handling on Fetch Failure', () => {
    it('should handle API errors during fetch', async () => {
      const error = new Error('Failed to fetch allowlist');
      vi.mocked(api.getAllowlist).mockRejectedValue(error);

      const { result } = renderHook(() => useAllowlist());

      await act(async () => {
        await result.current.fetchAllowlist();
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.error).toBe('Failed to fetch allowlist');
      expect(result.current.entries).toEqual([]);
    });

    it('should handle generic errors during fetch', async () => {
      vi.mocked(api.getAllowlist).mockRejectedValue(new Error('Network error'));

      const { result } = renderHook(() => useAllowlist());

      await act(async () => {
        await result.current.fetchAllowlist();
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.error).toBe('Network error');
      expect(result.current.entries).toEqual([]);
    });

    it('should handle non-Error objects during fetch', async () => {
      vi.mocked(api.getAllowlist).mockRejectedValue('String error');

      const { result } = renderHook(() => useAllowlist());

      await act(async () => {
        await result.current.fetchAllowlist();
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.error).toBe('Failed to fetch allowlist');
      expect(result.current.entries).toEqual([]);
    });

    it('should clear entries on fetch error', async () => {
      // First successful fetch
      vi.mocked(api.getAllowlist).mockResolvedValueOnce(mockAllowlistResponse);

      const { result } = renderHook(() => useAllowlist());

      await act(async () => {
        await result.current.fetchAllowlist();
      });

      await waitFor(() => {
        expect(result.current.entries.length).toBe(3);
      });

      // Second fetch fails
      vi.mocked(api.getAllowlist).mockRejectedValue(new Error('Server error'));

      await act(async () => {
        await result.current.fetchAllowlist();
      });

      await waitFor(() => {
        expect(result.current.entries).toEqual([]);
        expect(result.current.error).toBe('Server error');
      });
    });

    it('should clear error on successful fetch after error', async () => {
      // First fetch fails
      vi.mocked(api.getAllowlist).mockRejectedValueOnce(
        new Error('Failed to fetch'),
      );

      const { result } = renderHook(() => useAllowlist());

      await act(async () => {
        await result.current.fetchAllowlist();
      });

      await waitFor(() => {
        expect(result.current.error).toBe('Failed to fetch');
      });

      // Second fetch succeeds
      vi.mocked(api.getAllowlist).mockResolvedValue(mockAllowlistResponse);

      await act(async () => {
        await result.current.fetchAllowlist();
      });

      await waitFor(() => {
        expect(result.current.error).toBeNull();
        expect(result.current.entries.length).toBe(3);
      });
    });
  });

  describe('Status Filtering (pending/claimed)', () => {
    it('should fetch with pending status filter', async () => {
      const pendingResponse: AllowlistResponse = {
        items: [mockAllowedEmail1, mockAllowedEmail3],
        total: 2,
        page: 1,
        pageSize: 10,
        totalPages: 1,
      };
      vi.mocked(api.getAllowlist).mockResolvedValue(pendingResponse);

      const { result } = renderHook(() => useAllowlist());

      await act(async () => {
        await result.current.fetchAllowlist({ status: 'pending' });
      });

      expect(api.getAllowlist).toHaveBeenCalledWith({ status: 'pending' });
      expect(result.current.entries).toEqual([
        mockAllowedEmail1,
        mockAllowedEmail3,
      ]);
      expect(result.current.total).toBe(2);
    });

    it('should fetch with claimed status filter', async () => {
      const claimedResponse: AllowlistResponse = {
        items: [mockAllowedEmail2],
        total: 1,
        page: 1,
        pageSize: 10,
        totalPages: 1,
      };
      vi.mocked(api.getAllowlist).mockResolvedValue(claimedResponse);

      const { result } = renderHook(() => useAllowlist());

      await act(async () => {
        await result.current.fetchAllowlist({ status: 'claimed' });
      });

      expect(api.getAllowlist).toHaveBeenCalledWith({ status: 'claimed' });
      expect(result.current.entries).toEqual([mockAllowedEmail2]);
      expect(result.current.total).toBe(1);
    });

    it('should fetch with all status filter', async () => {
      vi.mocked(api.getAllowlist).mockResolvedValue(mockAllowlistResponse);

      const { result } = renderHook(() => useAllowlist());

      await act(async () => {
        await result.current.fetchAllowlist({ status: 'all' });
      });

      expect(api.getAllowlist).toHaveBeenCalledWith({ status: 'all' });
      expect(result.current.entries.length).toBe(3);
    });

    it('should combine status filter with other parameters', async () => {
      const filteredResponse: AllowlistResponse = {
        items: [mockAllowedEmail3],
        total: 1,
        page: 1,
        pageSize: 5,
        totalPages: 1,
      };
      vi.mocked(api.getAllowlist).mockResolvedValue(filteredResponse);

      const { result } = renderHook(() => useAllowlist());

      await act(async () => {
        await result.current.fetchAllowlist({
          status: 'pending',
          search: 'user3',
          page: 1,
          pageSize: 5,
        });
      });

      expect(api.getAllowlist).toHaveBeenCalledWith({
        status: 'pending',
        search: 'user3',
        page: 1,
        pageSize: 5,
      });
    });
  });

  describe('addEmail - Adding Email to Allowlist', () => {
    it('should add email successfully', async () => {
      const newEmail: AllowedEmailEntry = {
        id: 'entry-4',
        email: 'newuser@example.com',
        addedBy: { id: 'admin-1', email: 'admin@example.com' },
        addedAt: '2026-01-23T10:00:00Z',
        claimedBy: null,
        claimedAt: null,
        notes: 'New user',
      };

      vi.mocked(api.addToAllowlist).mockResolvedValue(newEmail);
      vi.mocked(api.getAllowlist).mockResolvedValue({
        ...mockAllowlistResponse,
        items: [...mockAllowlistResponse.items, newEmail],
        total: 4,
      });

      const { result } = renderHook(() => useAllowlist());

      await act(async () => {
        await result.current.addEmail('newuser@example.com', 'New user');
      });

      expect(api.addToAllowlist).toHaveBeenCalledWith(
        'newuser@example.com',
        'New user',
      );
      // Should refresh the list after adding
      expect(api.getAllowlist).toHaveBeenCalledWith({ page: 1, pageSize: 10 });
    });

    it('should add email without notes', async () => {
      const newEmail: AllowedEmailEntry = {
        id: 'entry-5',
        email: 'another@example.com',
        addedBy: { id: 'admin-1', email: 'admin@example.com' },
        addedAt: '2026-01-23T11:00:00Z',
        claimedBy: null,
        claimedAt: null,
        notes: null,
      };

      vi.mocked(api.addToAllowlist).mockResolvedValue(newEmail);
      vi.mocked(api.getAllowlist).mockResolvedValue(mockAllowlistResponse);

      const { result } = renderHook(() => useAllowlist());

      await act(async () => {
        await result.current.addEmail('another@example.com');
      });

      expect(api.addToAllowlist).toHaveBeenCalledWith('another@example.com', undefined);
    });

    it('should handle errors during email addition', async () => {
      const error = new Error('Failed to add email');
      vi.mocked(api.addToAllowlist).mockRejectedValue(error);

      const { result } = renderHook(() => useAllowlist());

      let thrownError: Error | null = null;
      await act(async () => {
        try {
          await result.current.addEmail('test@example.com');
        } catch (err) {
          thrownError = err as Error;
        }
      });

      expect(thrownError).not.toBeNull();
      expect(thrownError?.message).toBe('Failed to add email');
      expect(result.current.error).toBe('Failed to add email');
      // Should not call getAllowlist if add failed
      expect(api.getAllowlist).not.toHaveBeenCalled();
    });

    it('should handle duplicate email errors', async () => {
      const duplicateError = new Error('Email already exists in allowlist');
      vi.mocked(api.addToAllowlist).mockRejectedValue(duplicateError);

      const { result } = renderHook(() => useAllowlist());

      let thrownError: Error | null = null;
      await act(async () => {
        try {
          await result.current.addEmail('user1@example.com');
        } catch (err) {
          thrownError = err as Error;
        }
      });

      expect(thrownError).not.toBeNull();
      expect(thrownError?.message).toBe('Email already exists in allowlist');
      expect(result.current.error).toBe('Email already exists in allowlist');
    });

    it('should clear error before adding email', async () => {
      // First, create an error state
      vi.mocked(api.getAllowlist).mockRejectedValueOnce(
        new Error('Previous error'),
      );

      const { result } = renderHook(() => useAllowlist());

      await act(async () => {
        await result.current.fetchAllowlist();
      });

      await waitFor(() => {
        expect(result.current.error).toBe('Previous error');
      });

      // Now add email successfully
      const newEmail: AllowedEmailEntry = {
        id: 'entry-6',
        email: 'newuser@example.com',
        addedBy: { id: 'admin-1', email: 'admin@example.com' },
        addedAt: '2026-01-23T10:00:00Z',
        claimedBy: null,
        claimedAt: null,
        notes: null,
      };

      vi.mocked(api.addToAllowlist).mockResolvedValue(newEmail);
      vi.mocked(api.getAllowlist).mockResolvedValue(mockAllowlistResponse);

      await act(async () => {
        await result.current.addEmail('newuser@example.com');
      });

      // Error should be cleared (either null or not set, depending on refresh)
      await waitFor(() => {
        expect(result.current.error).toBeNull();
      });
    });

    it('should handle generic errors during email addition', async () => {
      vi.mocked(api.addToAllowlist).mockRejectedValue('String error');

      const { result } = renderHook(() => useAllowlist());

      let thrownError: unknown = null;
      await act(async () => {
        try {
          await result.current.addEmail('test@example.com');
        } catch (err) {
          thrownError = err;
        }
      });

      expect(thrownError).toBe('String error');
      expect(result.current.error).toBe('Failed to add email');
    });
  });

  describe('removeEmail - Removing Email from Allowlist', () => {
    it('should remove email successfully', async () => {
      vi.mocked(api.removeFromAllowlist).mockResolvedValue(undefined);
      vi.mocked(api.getAllowlist).mockResolvedValue({
        ...mockAllowlistResponse,
        items: [mockAllowedEmail2, mockAllowedEmail3],
        total: 2,
      });

      const { result } = renderHook(() => useAllowlist());

      await act(async () => {
        await result.current.removeEmail('entry-1');
      });

      expect(api.removeFromAllowlist).toHaveBeenCalledWith('entry-1');
      // Should refresh the list after removing
      expect(api.getAllowlist).toHaveBeenCalledWith({ page: 1, pageSize: 10 });
    });

    it('should handle errors during email removal', async () => {
      const error = new Error('Failed to remove email');
      vi.mocked(api.removeFromAllowlist).mockRejectedValue(error);

      const { result } = renderHook(() => useAllowlist());

      let thrownError: Error | null = null;
      await act(async () => {
        try {
          await result.current.removeEmail('entry-1');
        } catch (err) {
          thrownError = err as Error;
        }
      });

      expect(thrownError).not.toBeNull();
      expect(thrownError?.message).toBe('Failed to remove email');
      expect(result.current.error).toBe('Failed to remove email');
      // Should not call getAllowlist if remove failed
      expect(api.getAllowlist).not.toHaveBeenCalled();
    });

    it('should handle not found errors during removal', async () => {
      const notFoundError = new Error('Email not found');
      vi.mocked(api.removeFromAllowlist).mockRejectedValue(notFoundError);

      const { result } = renderHook(() => useAllowlist());

      let thrownError: Error | null = null;
      await act(async () => {
        try {
          await result.current.removeEmail('nonexistent-id');
        } catch (err) {
          thrownError = err as Error;
        }
      });

      expect(thrownError).not.toBeNull();
      expect(thrownError?.message).toBe('Email not found');
      expect(result.current.error).toBe('Email not found');
    });

    it('should clear error before removing email', async () => {
      // First, create an error state
      vi.mocked(api.getAllowlist).mockRejectedValueOnce(
        new Error('Previous error'),
      );

      const { result } = renderHook(() => useAllowlist());

      await act(async () => {
        await result.current.fetchAllowlist();
      });

      await waitFor(() => {
        expect(result.current.error).toBe('Previous error');
      });

      // Now remove email successfully
      vi.mocked(api.removeFromAllowlist).mockResolvedValue(undefined);
      vi.mocked(api.getAllowlist).mockResolvedValue(mockAllowlistResponse);

      await act(async () => {
        await result.current.removeEmail('entry-1');
      });

      // Error should be cleared
      await waitFor(() => {
        expect(result.current.error).toBeNull();
      });
    });

    it('should handle generic errors during email removal', async () => {
      vi.mocked(api.removeFromAllowlist).mockRejectedValue('String error');

      const { result } = renderHook(() => useAllowlist());

      let thrownError: unknown = null;
      await act(async () => {
        try {
          await result.current.removeEmail('entry-1');
        } catch (err) {
          thrownError = err;
        }
      });

      expect(thrownError).toBe('String error');
      expect(result.current.error).toBe('Failed to remove email');
    });
  });

  describe('Auto-Refresh After Mutations', () => {
    it('should refresh list after successful addEmail', async () => {
      const newEmail: AllowedEmailEntry = {
        id: 'entry-4',
        email: 'newuser@example.com',
        addedBy: { id: 'admin-1', email: 'admin@example.com' },
        addedAt: '2026-01-23T10:00:00Z',
        claimedBy: null,
        claimedAt: null,
        notes: null,
      };

      vi.mocked(api.addToAllowlist).mockResolvedValue(newEmail);

      // First call returns updated list
      const updatedResponse: AllowlistResponse = {
        items: [...mockAllowlistResponse.items, newEmail],
        total: 4,
        page: 1,
        pageSize: 10,
        totalPages: 1,
      };
      vi.mocked(api.getAllowlist).mockResolvedValue(updatedResponse);

      const { result } = renderHook(() => useAllowlist());

      await act(async () => {
        await result.current.addEmail('newuser@example.com');
      });

      await waitFor(() => {
        expect(result.current.entries.length).toBe(4);
        expect(result.current.total).toBe(4);
      });
    });

    it('should refresh list after successful removeEmail', async () => {
      vi.mocked(api.removeFromAllowlist).mockResolvedValue(undefined);

      const updatedResponse: AllowlistResponse = {
        items: [mockAllowedEmail2, mockAllowedEmail3],
        total: 2,
        page: 1,
        pageSize: 10,
        totalPages: 1,
      };
      vi.mocked(api.getAllowlist).mockResolvedValue(updatedResponse);

      const { result } = renderHook(() => useAllowlist());

      await act(async () => {
        await result.current.removeEmail('entry-1');
      });

      await waitFor(() => {
        expect(result.current.entries.length).toBe(2);
        expect(result.current.total).toBe(2);
      });
    });

    it('should preserve pagination state when refreshing after mutation', async () => {
      // Set up on page 2
      const page2Response: AllowlistResponse = {
        items: [mockAllowedEmail3],
        total: 11,
        page: 2,
        pageSize: 5,
        totalPages: 3,
      };
      vi.mocked(api.getAllowlist).mockResolvedValue(page2Response);

      const { result } = renderHook(() => useAllowlist());

      // Fetch page 2
      await act(async () => {
        await result.current.fetchAllowlist({ page: 2, pageSize: 5 });
      });

      await waitFor(() => {
        expect(result.current.page).toBe(2);
        expect(result.current.pageSize).toBe(5);
      });

      // Add email - should refresh with current page/pageSize
      const newEmail: AllowedEmailEntry = {
        id: 'entry-4',
        email: 'newuser@example.com',
        addedBy: { id: 'admin-1', email: 'admin@example.com' },
        addedAt: '2026-01-23T10:00:00Z',
        claimedBy: null,
        claimedAt: null,
        notes: null,
      };

      vi.mocked(api.addToAllowlist).mockResolvedValue(newEmail);

      await act(async () => {
        await result.current.addEmail('newuser@example.com');
      });

      // Should have called getAllowlist with preserved pagination
      expect(api.getAllowlist).toHaveBeenLastCalledWith({
        page: 2,
        pageSize: 5,
      });
    });

    it('should not refresh if mutation fails', async () => {
      vi.mocked(api.addToAllowlist).mockRejectedValue(
        new Error('Failed to add'),
      );

      const { result } = renderHook(() => useAllowlist());

      vi.clearAllMocks(); // Clear any initial calls

      await expect(async () => {
        await act(async () => {
          await result.current.addEmail('test@example.com');
        });
      }).rejects.toThrow();

      // getAllowlist should not have been called
      expect(api.getAllowlist).not.toHaveBeenCalled();
    });
  });

  describe('Loading States During Operations', () => {
    it('should maintain isLoading state during fetchAllowlist', async () => {
      let resolveAllowlist: (value: AllowlistResponse) => void;
      const allowlistPromise = new Promise<AllowlistResponse>((resolve) => {
        resolveAllowlist = resolve;
      });
      vi.mocked(api.getAllowlist).mockReturnValue(allowlistPromise);

      const { result } = renderHook(() => useAllowlist());

      expect(result.current.isLoading).toBe(false);

      act(() => {
        result.current.fetchAllowlist();
      });

      expect(result.current.isLoading).toBe(true);

      await act(async () => {
        resolveAllowlist!(mockAllowlistResponse);
        await allowlistPromise;
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });
    });

    it('should set isLoading to false after fetch error', async () => {
      vi.mocked(api.getAllowlist).mockRejectedValue(
        new Error('Failed to fetch'),
      );

      const { result } = renderHook(() => useAllowlist());

      await act(async () => {
        await result.current.fetchAllowlist();
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });
    });

    it('should handle isLoading during refresh after addEmail', async () => {
      let resolveAllowlist: (value: AllowlistResponse) => void;
      const allowlistPromise = new Promise<AllowlistResponse>((resolve) => {
        resolveAllowlist = resolve;
      });

      const newEmail: AllowedEmailEntry = {
        id: 'entry-4',
        email: 'newuser@example.com',
        addedBy: { id: 'admin-1', email: 'admin@example.com' },
        addedAt: '2026-01-23T10:00:00Z',
        claimedBy: null,
        claimedAt: null,
        notes: null,
      };

      vi.mocked(api.addToAllowlist).mockResolvedValue(newEmail);
      vi.mocked(api.getAllowlist).mockReturnValue(allowlistPromise);

      const { result } = renderHook(() => useAllowlist());

      act(() => {
        result.current.addEmail('newuser@example.com');
      });

      // Wait for addEmail to complete and start fetching
      await vi.waitFor(() => {
        expect(result.current.isLoading).toBe(true);
      });

      await act(async () => {
        resolveAllowlist!(mockAllowlistResponse);
        await allowlistPromise;
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });
    });

    it('should handle isLoading during refresh after removeEmail', async () => {
      let resolveAllowlist: (value: AllowlistResponse) => void;
      const allowlistPromise = new Promise<AllowlistResponse>((resolve) => {
        resolveAllowlist = resolve;
      });

      vi.mocked(api.removeFromAllowlist).mockResolvedValue(undefined);
      vi.mocked(api.getAllowlist).mockReturnValue(allowlistPromise);

      const { result } = renderHook(() => useAllowlist());

      act(() => {
        result.current.removeEmail('entry-1');
      });

      // Wait for removeEmail to complete and start fetching
      await vi.waitFor(() => {
        expect(result.current.isLoading).toBe(true);
      });

      await act(async () => {
        resolveAllowlist!(mockAllowlistResponse);
        await allowlistPromise;
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });
    });
  });

  describe('Error Message Handling', () => {
    it('should set error message on fetch failure', async () => {
      vi.mocked(api.getAllowlist).mockRejectedValue(
        new Error('Server unavailable'),
      );

      const { result } = renderHook(() => useAllowlist());

      await act(async () => {
        await result.current.fetchAllowlist();
      });

      await waitFor(() => {
        expect(result.current.error).toBe('Server unavailable');
      });
    });

    it('should set error message on addEmail failure', async () => {
      vi.mocked(api.addToAllowlist).mockRejectedValue(
        new Error('Validation error'),
      );

      const { result } = renderHook(() => useAllowlist());

      await act(async () => {
        try {
          await result.current.addEmail('invalid-email');
        } catch {
          // Error is expected
        }
      });

      expect(result.current.error).toBe('Validation error');
    });

    it('should set error message on removeEmail failure', async () => {
      vi.mocked(api.removeFromAllowlist).mockRejectedValue(
        new Error('Unauthorized'),
      );

      const { result } = renderHook(() => useAllowlist());

      await act(async () => {
        try {
          await result.current.removeEmail('entry-1');
        } catch {
          // Error is expected
        }
      });

      expect(result.current.error).toBe('Unauthorized');
    });

    it('should use default error message for non-Error objects', async () => {
      vi.mocked(api.getAllowlist).mockRejectedValue({ code: 'ERR_UNKNOWN' });

      const { result } = renderHook(() => useAllowlist());

      await act(async () => {
        await result.current.fetchAllowlist();
      });

      await waitFor(() => {
        expect(result.current.error).toBe('Failed to fetch allowlist');
      });
    });
  });

  describe('Callback Stability', () => {
    it('should maintain stable callback references', () => {
      const { result, rerender } = renderHook(() => useAllowlist());

      const firstFetchAllowlist = result.current.fetchAllowlist;
      const firstAddEmail = result.current.addEmail;
      const firstRemoveEmail = result.current.removeEmail;

      rerender();

      expect(result.current.fetchAllowlist).toBe(firstFetchAllowlist);
      expect(result.current.addEmail).toBe(firstAddEmail);
      expect(result.current.removeEmail).toBe(firstRemoveEmail);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty allowlist response', async () => {
      const emptyResponse: AllowlistResponse = {
        items: [],
        total: 0,
        page: 1,
        pageSize: 10,
        totalPages: 0,
      };
      vi.mocked(api.getAllowlist).mockResolvedValue(emptyResponse);

      const { result } = renderHook(() => useAllowlist());

      await act(async () => {
        await result.current.fetchAllowlist();
      });

      await waitFor(() => {
        expect(result.current.entries).toEqual([]);
        expect(result.current.total).toBe(0);
        expect(result.current.totalPages).toBe(0);
      });
    });

    it('should handle multiple consecutive fetches', async () => {
      vi.mocked(api.getAllowlist)
        .mockResolvedValueOnce(mockAllowlistResponse)
        .mockResolvedValueOnce({
          items: [mockAllowedEmail1],
          total: 1,
          page: 1,
          pageSize: 10,
          totalPages: 1,
        });

      const { result } = renderHook(() => useAllowlist());

      await act(async () => {
        await result.current.fetchAllowlist();
      });

      expect(result.current.entries.length).toBe(3);

      await act(async () => {
        await result.current.fetchAllowlist({ status: 'pending' });
      });

      await waitFor(() => {
        expect(result.current.entries.length).toBe(1);
      });
    });

    it('should handle rapid mutations', async () => {
      const newEmail1: AllowedEmailEntry = {
        id: 'entry-4',
        email: 'user4@example.com',
        addedBy: { id: 'admin-1', email: 'admin@example.com' },
        addedAt: '2026-01-23T10:00:00Z',
        claimedBy: null,
        claimedAt: null,
        notes: null,
      };

      const newEmail2: AllowedEmailEntry = {
        id: 'entry-5',
        email: 'user5@example.com',
        addedBy: { id: 'admin-1', email: 'admin@example.com' },
        addedAt: '2026-01-23T11:00:00Z',
        claimedBy: null,
        claimedAt: null,
        notes: null,
      };

      vi.mocked(api.addToAllowlist)
        .mockResolvedValueOnce(newEmail1)
        .mockResolvedValueOnce(newEmail2);

      vi.mocked(api.getAllowlist)
        .mockResolvedValueOnce({
          ...mockAllowlistResponse,
          items: [...mockAllowlistResponse.items, newEmail1],
          total: 4,
        })
        .mockResolvedValueOnce({
          ...mockAllowlistResponse,
          items: [...mockAllowlistResponse.items, newEmail1, newEmail2],
          total: 5,
        });

      const { result } = renderHook(() => useAllowlist());

      await act(async () => {
        await result.current.addEmail('user4@example.com');
        await result.current.addEmail('user5@example.com');
      });

      await waitFor(() => {
        expect(result.current.total).toBe(5);
      });
    });
  });
});
