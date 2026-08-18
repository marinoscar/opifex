import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useUsers } from '../../hooks/useUsers';
import { server } from '../mocks/server';
import { http, HttpResponse } from 'msw';
import type { UserListItem, UsersResponse } from '../../types';

// Mock user data
const mockUser1: UserListItem = {
  id: 'user-1',
  email: 'user1@example.com',
  displayName: 'User One',
  providerDisplayName: 'User One (Provider)',
  profileImageUrl: null,
  providerProfileImageUrl: null,
  isActive: true,
  roles: ['Viewer'],
  createdAt: new Date('2024-01-01').toISOString(),
  updatedAt: new Date('2024-01-01').toISOString(),
};

const mockUser2: UserListItem = {
  id: 'user-2',
  email: 'user2@example.com',
  displayName: null,
  providerDisplayName: 'User Two (Provider)',
  profileImageUrl: null,
  providerProfileImageUrl: 'https://example.com/photo.jpg',
  isActive: true,
  roles: ['Contributor'],
  createdAt: new Date('2024-01-02').toISOString(),
  updatedAt: new Date('2024-01-02').toISOString(),
};

const mockUser3: UserListItem = {
  id: 'user-3',
  email: 'admin@example.com',
  displayName: 'Admin User',
  providerDisplayName: 'Admin (Provider)',
  profileImageUrl: 'https://example.com/admin.jpg',
  providerProfileImageUrl: null,
  isActive: false,
  roles: ['Admin'],
  createdAt: new Date('2024-01-03').toISOString(),
  updatedAt: new Date('2024-01-03').toISOString(),
};

const mockUsersResponse: UsersResponse = {
  items: [mockUser1, mockUser2],
  total: 2,
  page: 1,
  pageSize: 10,
  totalPages: 1,
};

describe('useUsers', () => {
  beforeEach(() => {
    // Reset to default successful handlers
    server.resetHandlers();
  });

  describe('Initial Loading State', () => {
    it('should start with empty users and not loading', () => {
      const { result } = renderHook(() => useUsers());

      expect(result.current.users).toEqual([]);
      expect(result.current.total).toBe(0);
      expect(result.current.page).toBe(1);
      expect(result.current.pageSize).toBe(10);
      expect(result.current.totalPages).toBe(0);
      expect(result.current.isLoading).toBe(false);
      expect(result.current.error).toBeNull();
    });

    it('should provide all expected methods', () => {
      const { result } = renderHook(() => useUsers());

      expect(typeof result.current.fetchUsers).toBe('function');
      expect(typeof result.current.updateUser).toBe('function');
      expect(typeof result.current.updateUserRoles).toBe('function');
    });
  });

  describe('Successful Users Fetch with Pagination', () => {
    it('should fetch users successfully', async () => {
      server.use(
        http.get('*/api/users', () => {
          return HttpResponse.json(mockUsersResponse);
        })
      );

      const { result } = renderHook(() => useUsers());

      await act(async () => {
        await result.current.fetchUsers();
      });

      expect(result.current.isLoading).toBe(false);
      expect(result.current.users).toEqual(mockUsersResponse.items);
      expect(result.current.total).toBe(2);
      expect(result.current.page).toBe(1);
      expect(result.current.pageSize).toBe(10);
      expect(result.current.totalPages).toBe(1);
      expect(result.current.error).toBeNull();
    });

    it('should set loading state during fetch', async () => {
      let resolveRequest: (value: unknown) => void;
      const requestPromise = new Promise((resolve) => {
        resolveRequest = resolve;
      });

      server.use(
        http.get('*/api/users', async () => {
          await requestPromise;
          return HttpResponse.json(mockUsersResponse);
        })
      );

      const { result } = renderHook(() => useUsers());

      let fetchPromise: Promise<void>;
      act(() => {
        fetchPromise = result.current.fetchUsers();
      });

      // Should be loading
      await waitFor(() => {
        expect(result.current.isLoading).toBe(true);
      });

      resolveRequest!(null);
      await act(async () => {
        await fetchPromise;
      });

      // Should no longer be loading
      expect(result.current.isLoading).toBe(false);
    });

    it('should fetch users with pagination parameters', async () => {
      let requestUrl: string | undefined;

      server.use(
        http.get('*/api/users', ({ request }) => {
          requestUrl = request.url;
          return HttpResponse.json({
            ...mockUsersResponse,
            page: 2,
            pageSize: 20,
          });
        })
      );

      const { result } = renderHook(() => useUsers());

      await act(async () => {
        await result.current.fetchUsers({ page: 2, pageSize: 20 });
      });

      expect(requestUrl).toContain('page=2');
      expect(requestUrl).toContain('pageSize=20');
      expect(result.current.page).toBe(2);
      expect(result.current.pageSize).toBe(20);
    });

    it('should handle paginated results with multiple pages', async () => {
      server.use(
        http.get('*/api/users', () => {
          return HttpResponse.json({
            items: [mockUser1],
            total: 25,
            page: 1,
            pageSize: 10,
            totalPages: 3,
          });
        })
      );

      const { result } = renderHook(() => useUsers());

      await act(async () => {
        await result.current.fetchUsers();
      });

      expect(result.current.total).toBe(25);
      expect(result.current.totalPages).toBe(3);
      expect(result.current.users.length).toBe(1);
    });
  });

  describe('Error Handling on Fetch Failure', () => {
    it('should handle generic fetch error', async () => {
      server.use(
        http.get('*/api/users', () => {
          return HttpResponse.json(
            { message: 'Internal server error' },
            { status: 500 }
          );
        })
      );

      const { result } = renderHook(() => useUsers());

      await act(async () => {
        await result.current.fetchUsers();
      });

      expect(result.current.isLoading).toBe(false);
      expect(result.current.users).toEqual([]);
      expect(result.current.error).toBe('Internal server error');
    });

    it('should handle network error', async () => {
      server.use(
        http.get('*/api/users', () => {
          return HttpResponse.error();
        })
      );

      const { result } = renderHook(() => useUsers());

      await act(async () => {
        await result.current.fetchUsers();
      });

      expect(result.current.isLoading).toBe(false);
      expect(result.current.users).toEqual([]);
      expect(result.current.error).toBe('Failed to fetch');
    });

    it('should handle 403 permission error', async () => {
      server.use(
        http.get('*/api/users', () => {
          return HttpResponse.json(
            { message: 'Forbidden - Admin access required' },
            { status: 403 }
          );
        })
      );

      const { result } = renderHook(() => useUsers());

      await act(async () => {
        await result.current.fetchUsers();
      });

      expect(result.current.users).toEqual([]);
      expect(result.current.error).toBe('Forbidden - Admin access required');
    });

    it('should clear users on error', async () => {
      server.use(
        http.get('*/api/users', () => {
          return HttpResponse.json(mockUsersResponse);
        })
      );

      const { result } = renderHook(() => useUsers());

      // First fetch successfully
      await act(async () => {
        await result.current.fetchUsers();
      });

      expect(result.current.users.length).toBeGreaterThan(0);

      // Now make it fail
      server.use(
        http.get('*/api/users', () => {
          return HttpResponse.json(
            { message: 'Server error' },
            { status: 500 }
          );
        })
      );

      await act(async () => {
        await result.current.fetchUsers();
      });

      // Users should be cleared
      expect(result.current.users).toEqual([]);
    });
  });

  describe('Search/Filter Functionality', () => {
    it('should fetch users with search parameter', async () => {
      let requestUrl: string | undefined;

      server.use(
        http.get('*/api/users', ({ request }) => {
          requestUrl = request.url;
          return HttpResponse.json({
            items: [mockUser1],
            total: 1,
            page: 1,
            pageSize: 10,
            totalPages: 1,
          });
        })
      );

      const { result } = renderHook(() => useUsers());

      await act(async () => {
        await result.current.fetchUsers({ search: 'user1@example.com' });
      });

      expect(requestUrl).toContain('search=user1%40example.com');
      expect(result.current.users.length).toBe(1);
    });

    it('should fetch users with role filter', async () => {
      let requestUrl: string | undefined;

      server.use(
        http.get('*/api/users', ({ request }) => {
          requestUrl = request.url;
          return HttpResponse.json({
            items: [mockUser3],
            total: 1,
            page: 1,
            pageSize: 10,
            totalPages: 1,
          });
        })
      );

      const { result } = renderHook(() => useUsers());

      await act(async () => {
        await result.current.fetchUsers({ role: 'Admin' });
      });

      expect(requestUrl).toContain('role=Admin');
      expect(result.current.users[0].roles).toContain('Admin');
    });

    it('should fetch users with isActive filter', async () => {
      let requestUrl: string | undefined;

      server.use(
        http.get('*/api/users', ({ request }) => {
          requestUrl = request.url;
          return HttpResponse.json({
            items: [mockUser3],
            total: 1,
            page: 1,
            pageSize: 10,
            totalPages: 1,
          });
        })
      );

      const { result } = renderHook(() => useUsers());

      await act(async () => {
        await result.current.fetchUsers({ isActive: false });
      });

      expect(requestUrl).toContain('isActive=false');
      expect(result.current.users[0].isActive).toBe(false);
    });

    it('should fetch users with multiple filters', async () => {
      let requestUrl: string | undefined;

      server.use(
        http.get('*/api/users', ({ request }) => {
          requestUrl = request.url;
          return HttpResponse.json(mockUsersResponse);
        })
      );

      const { result } = renderHook(() => useUsers());

      await act(async () => {
        await result.current.fetchUsers({
          search: 'user',
          role: 'Viewer',
          isActive: true,
          page: 2,
          pageSize: 5,
        });
      });

      expect(requestUrl).toContain('search=user');
      expect(requestUrl).toContain('role=Viewer');
      expect(requestUrl).toContain('isActive=true');
      expect(requestUrl).toContain('page=2');
      expect(requestUrl).toContain('pageSize=5');
    });
  });

  describe('updateUser - User Activation/Deactivation', () => {
    it('should toggle user active status', async () => {
      server.use(
        http.get('*/api/users', () => {
          return HttpResponse.json(mockUsersResponse);
        }),
        http.patch('*/api/users/:id', ({ params }) => {
          if (params.id === 'user-1') {
            return HttpResponse.json({
              ...mockUser1,
              isActive: false,
            });
          }
          return HttpResponse.json({ message: 'Not found' }, { status: 404 });
        })
      );

      const { result } = renderHook(() => useUsers());

      // First fetch users
      await act(async () => {
        await result.current.fetchUsers();
      });

      expect(result.current.users[0].isActive).toBe(true);

      // Now toggle active status
      await act(async () => {
        await result.current.updateUser('user-1', { isActive: false });
      });

      // User in the list should be updated
      expect(result.current.users[0].isActive).toBe(false);
      expect(result.current.error).toBeNull();
    });

    it('should update user display name', async () => {
      server.use(
        http.get('*/api/users', () => {
          return HttpResponse.json(mockUsersResponse);
        }),
        http.patch('*/api/users/:id', async ({ params, request }) => {
          if (params.id === 'user-1') {
            const body = await request.json() as { displayName?: string };
            return HttpResponse.json({
              ...mockUser1,
              displayName: body.displayName || mockUser1.displayName,
            });
          }
          return HttpResponse.json({ message: 'Not found' }, { status: 404 });
        })
      );

      const { result } = renderHook(() => useUsers());

      await act(async () => {
        await result.current.fetchUsers();
      });

      await act(async () => {
        await result.current.updateUser('user-1', { displayName: 'Updated Name' });
      });

      expect(result.current.users[0].displayName).toBe('Updated Name');
    });

    it('should update both displayName and isActive', async () => {
      server.use(
        http.get('*/api/users', () => {
          return HttpResponse.json(mockUsersResponse);
        }),
        http.patch('*/api/users/:id', ({ params }) => {
          if (params.id === 'user-1') {
            return HttpResponse.json({
              ...mockUser1,
              displayName: 'New Name',
              isActive: false,
            });
          }
          return HttpResponse.json({ message: 'Not found' }, { status: 404 });
        })
      );

      const { result } = renderHook(() => useUsers());

      await act(async () => {
        await result.current.fetchUsers();
      });

      await act(async () => {
        await result.current.updateUser('user-1', {
          displayName: 'New Name',
          isActive: false,
        });
      });

      expect(result.current.users[0].displayName).toBe('New Name');
      expect(result.current.users[0].isActive).toBe(false);
    });

    it('should handle update error', async () => {
      server.use(
        http.get('*/api/users', () => {
          return HttpResponse.json(mockUsersResponse);
        }),
        http.patch('*/api/users/:id', () => {
          return HttpResponse.json(
            { message: 'Update failed' },
            { status: 500 }
          );
        })
      );

      const { result } = renderHook(() => useUsers());

      await act(async () => {
        await result.current.fetchUsers();
      });

      const originalUsers = [...result.current.users];

      await expect(async () => {
        await act(async () => {
          await result.current.updateUser('user-1', { isActive: false });
        });
      }).rejects.toThrow();

      // Users should remain unchanged
      expect(result.current.users).toEqual(originalUsers);
    });

    it('should handle 403 permission error on update', async () => {
      server.use(
        http.get('*/api/users', () => {
          return HttpResponse.json(mockUsersResponse);
        }),
        http.patch('*/api/users/:id', () => {
          return HttpResponse.json(
            { message: 'Forbidden - Admin access required' },
            { status: 403 }
          );
        })
      );

      const { result } = renderHook(() => useUsers());

      await act(async () => {
        await result.current.fetchUsers();
      });

      await expect(async () => {
        await act(async () => {
          await result.current.updateUser('user-1', { isActive: false });
        });
      }).rejects.toThrow();
    });

    it('should update only the specified user in the list', async () => {
      server.use(
        http.get('*/api/users', () => {
          return HttpResponse.json(mockUsersResponse);
        }),
        http.patch('*/api/users/:id', ({ params }) => {
          if (params.id === 'user-2') {
            return HttpResponse.json({
              ...mockUser2,
              isActive: false,
            });
          }
          return HttpResponse.json({ message: 'Not found' }, { status: 404 });
        })
      );

      const { result } = renderHook(() => useUsers());

      await act(async () => {
        await result.current.fetchUsers();
      });

      await act(async () => {
        await result.current.updateUser('user-2', { isActive: false });
      });

      // First user should remain unchanged
      expect(result.current.users[0].id).toBe('user-1');
      expect(result.current.users[0].isActive).toBe(true);

      // Second user should be updated
      expect(result.current.users[1].id).toBe('user-2');
      expect(result.current.users[1].isActive).toBe(false);
    });
  });

  describe('updateUserRoles - Role Assignment', () => {
    it('should update user roles successfully', async () => {
      server.use(
        http.get('*/api/users', () => {
          return HttpResponse.json(mockUsersResponse);
        }),
        http.put('*/api/users/:id/roles', async ({ params, request }) => {
          if (params.id === 'user-1') {
            const body = await request.json() as { roles: string[] };
            return HttpResponse.json({
              ...mockUser1,
              roles: body.roles,
            });
          }
          return HttpResponse.json({ message: 'Not found' }, { status: 404 });
        })
      );

      const { result } = renderHook(() => useUsers());

      await act(async () => {
        await result.current.fetchUsers();
      });

      expect(result.current.users[0].roles).toEqual(['Viewer']);

      await act(async () => {
        await result.current.updateUserRoles('user-1', ['Admin', 'Contributor']);
      });

      expect(result.current.users[0].roles).toEqual(['Admin', 'Contributor']);
      expect(result.current.error).toBeNull();
    });

    it('should handle role update error', async () => {
      server.use(
        http.get('*/api/users', () => {
          return HttpResponse.json(mockUsersResponse);
        }),
        http.put('*/api/users/:id/roles', () => {
          return HttpResponse.json(
            { message: 'Failed to update user roles' },
            { status: 500 }
          );
        })
      );

      const { result } = renderHook(() => useUsers());

      await act(async () => {
        await result.current.fetchUsers();
      });

      const originalRoles = [...result.current.users[0].roles];

      await expect(async () => {
        await act(async () => {
          await result.current.updateUserRoles('user-1', ['Admin']);
        });
      }).rejects.toThrow();

      // Roles should remain unchanged
      expect(result.current.users[0].roles).toEqual(originalRoles);
    });

    it('should handle 403 permission error on role update', async () => {
      server.use(
        http.get('*/api/users', () => {
          return HttpResponse.json(mockUsersResponse);
        }),
        http.put('*/api/users/:id/roles', () => {
          return HttpResponse.json(
            { message: 'Forbidden - Admin access required' },
            { status: 403 }
          );
        })
      );

      const { result } = renderHook(() => useUsers());

      await act(async () => {
        await result.current.fetchUsers();
      });

      await expect(async () => {
        await act(async () => {
          await result.current.updateUserRoles('user-1', ['Admin']);
        });
      }).rejects.toThrow();
    });

    it('should update roles for the correct user', async () => {
      server.use(
        http.get('*/api/users', () => {
          return HttpResponse.json(mockUsersResponse);
        }),
        http.put('*/api/users/:id/roles', ({ params }) => {
          if (params.id === 'user-2') {
            return HttpResponse.json({
              ...mockUser2,
              roles: ['Admin'],
            });
          }
          return HttpResponse.json({ message: 'Not found' }, { status: 404 });
        })
      );

      const { result } = renderHook(() => useUsers());

      await act(async () => {
        await result.current.fetchUsers();
      });

      await act(async () => {
        await result.current.updateUserRoles('user-2', ['Admin']);
      });

      // First user roles should remain unchanged
      expect(result.current.users[0].roles).toEqual(['Viewer']);

      // Second user roles should be updated
      expect(result.current.users[1].roles).toEqual(['Admin']);
    });

    it('should handle removing all roles', async () => {
      server.use(
        http.get('*/api/users', () => {
          return HttpResponse.json(mockUsersResponse);
        }),
        http.put('*/api/users/:id/roles', ({ params }) => {
          if (params.id === 'user-1') {
            return HttpResponse.json({
              ...mockUser1,
              roles: [],
            });
          }
          return HttpResponse.json({ message: 'Not found' }, { status: 404 });
        })
      );

      const { result } = renderHook(() => useUsers());

      await act(async () => {
        await result.current.fetchUsers();
      });

      await act(async () => {
        await result.current.updateUserRoles('user-1', []);
      });

      expect(result.current.users[0].roles).toEqual([]);
    });
  });

  describe('refresh - Manual Refresh Capability', () => {
    it('should refresh users list on demand', async () => {
      server.use(
        http.get('*/api/users', () => {
          return HttpResponse.json(mockUsersResponse);
        })
      );

      const { result } = renderHook(() => useUsers());

      // Initial fetch
      await act(async () => {
        await result.current.fetchUsers();
      });

      expect(result.current.users.length).toBe(2);

      // Mock updated users list
      server.use(
        http.get('*/api/users', () => {
          return HttpResponse.json({
            items: [mockUser1, mockUser2, mockUser3],
            total: 3,
            page: 1,
            pageSize: 10,
            totalPages: 1,
          });
        })
      );

      // Refresh
      await act(async () => {
        await result.current.fetchUsers();
      });

      expect(result.current.users.length).toBe(3);
      expect(result.current.total).toBe(3);
    });

    it('should preserve filter parameters on refresh', async () => {
      let requestUrl: string | undefined;
      let callCount = 0;

      server.use(
        http.get('*/api/users', ({ request }) => {
          callCount++;
          requestUrl = request.url;
          return HttpResponse.json(mockUsersResponse);
        })
      );

      const { result } = renderHook(() => useUsers());

      // Fetch with filters
      await act(async () => {
        await result.current.fetchUsers({ search: 'admin', role: 'Admin' });
      });

      const firstUrl = requestUrl;

      // Fetch again with same parameters to simulate refresh
      await act(async () => {
        await result.current.fetchUsers({ search: 'admin', role: 'Admin' });
      });

      // Both requests should have the same parameters
      expect(requestUrl).toBe(firstUrl);
      expect(callCount).toBe(2);
    });

    it('should clear error on successful refresh', async () => {
      // First request fails
      server.use(
        http.get('*/api/users', () => {
          return HttpResponse.json(
            { message: 'Server error' },
            { status: 500 }
          );
        })
      );

      const { result } = renderHook(() => useUsers());

      await act(async () => {
        await result.current.fetchUsers();
      });

      expect(result.current.error).not.toBeNull();

      // Now make it succeed
      server.use(
        http.get('*/api/users', () => {
          return HttpResponse.json(mockUsersResponse);
        })
      );

      await act(async () => {
        await result.current.fetchUsers();
      });

      expect(result.current.error).toBeNull();
      expect(result.current.users.length).toBe(2);
    });
  });

  describe('Loading States During Operations', () => {
    it('should not be loading initially', () => {
      const { result } = renderHook(() => useUsers());
      expect(result.current.isLoading).toBe(false);
    });

    it('should set loading to true during fetch', async () => {
      let resolveRequest: (value: unknown) => void;
      const requestPromise = new Promise((resolve) => {
        resolveRequest = resolve;
      });

      server.use(
        http.get('*/api/users', async () => {
          await requestPromise;
          return HttpResponse.json(mockUsersResponse);
        })
      );

      const { result } = renderHook(() => useUsers());

      let fetchPromise: Promise<void>;
      act(() => {
        fetchPromise = result.current.fetchUsers();
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(true);
      });

      resolveRequest!(null);
      await act(async () => {
        await fetchPromise;
      });

      expect(result.current.isLoading).toBe(false);
    });

    it('should clear loading state even when fetch fails', async () => {
      server.use(
        http.get('*/api/users', () => {
          return HttpResponse.json(
            { message: 'Server error' },
            { status: 500 }
          );
        })
      );

      const { result } = renderHook(() => useUsers());

      await act(async () => {
        await result.current.fetchUsers();
      });

      expect(result.current.isLoading).toBe(false);
    });

    it('should not set loading state during update operations', async () => {
      server.use(
        http.get('*/api/users', () => {
          return HttpResponse.json(mockUsersResponse);
        }),
        http.patch('*/api/users/:id', () => {
          return HttpResponse.json({
            ...mockUser1,
            isActive: false,
          });
        })
      );

      const { result } = renderHook(() => useUsers());

      await act(async () => {
        await result.current.fetchUsers();
      });

      expect(result.current.isLoading).toBe(false);

      await act(async () => {
        await result.current.updateUser('user-1', { isActive: false });
      });

      // isLoading should remain false for updates (no loading state for updates)
      expect(result.current.isLoading).toBe(false);
    });

    it('should not set loading state during role update operations', async () => {
      server.use(
        http.get('*/api/users', () => {
          return HttpResponse.json(mockUsersResponse);
        }),
        http.put('*/api/users/:id/roles', () => {
          return HttpResponse.json({
            ...mockUser1,
            roles: ['Admin'],
          });
        })
      );

      const { result } = renderHook(() => useUsers());

      await act(async () => {
        await result.current.fetchUsers();
      });

      expect(result.current.isLoading).toBe(false);

      await act(async () => {
        await result.current.updateUserRoles('user-1', ['Admin']);
      });

      expect(result.current.isLoading).toBe(false);
    });
  });

  describe('Error Recovery', () => {
    it('should clear error after successful fetch', async () => {
      // First request fails
      server.use(
        http.get('*/api/users', () => {
          return HttpResponse.json(
            { message: 'Fetch error' },
            { status: 500 }
          );
        })
      );

      const { result } = renderHook(() => useUsers());

      await act(async () => {
        await result.current.fetchUsers();
      });

      expect(result.current.error).not.toBeNull();

      // Now make it succeed
      server.use(
        http.get('*/api/users', () => {
          return HttpResponse.json(mockUsersResponse);
        })
      );

      await act(async () => {
        await result.current.fetchUsers();
      });

      expect(result.current.error).toBeNull();
    });

    it('should clear error before update operation', async () => {
      server.use(
        http.get('*/api/users', () => {
          return HttpResponse.json(mockUsersResponse);
        })
      );

      const { result } = renderHook(() => useUsers());

      await act(async () => {
        await result.current.fetchUsers();
      });

      // Simulate an error from a previous operation (fetch error)
      server.use(
        http.get('*/api/users', () => {
          return HttpResponse.json(
            { message: 'First error' },
            { status: 500 }
          );
        })
      );

      await act(async () => {
        await result.current.fetchUsers();
      });

      expect(result.current.error).toBe('First error');

      // Now make update succeed (which clears error via setError(null))
      server.use(
        http.patch('*/api/users/:id', () => {
          return HttpResponse.json({
            ...mockUser1,
            isActive: false,
          });
        })
      );

      await act(async () => {
        await result.current.updateUser('user-1', { isActive: false });
      });

      // Error should be cleared
      expect(result.current.error).toBeNull();
    });

    it('should clear error before role update operation', async () => {
      server.use(
        http.get('*/api/users', () => {
          return HttpResponse.json(mockUsersResponse);
        })
      );

      const { result } = renderHook(() => useUsers());

      await act(async () => {
        await result.current.fetchUsers();
      });

      // Simulate an error from a previous operation (fetch error)
      server.use(
        http.get('*/api/users', () => {
          return HttpResponse.json(
            { message: 'First error' },
            { status: 500 }
          );
        })
      );

      await act(async () => {
        await result.current.fetchUsers();
      });

      expect(result.current.error).toBe('First error');

      // Now make role update succeed (which clears error via setError(null))
      server.use(
        http.put('*/api/users/:id/roles', () => {
          return HttpResponse.json({
            ...mockUser1,
            roles: ['Admin'],
          });
        })
      );

      await act(async () => {
        await result.current.updateUserRoles('user-1', ['Admin']);
      });

      // Error should be cleared
      expect(result.current.error).toBeNull();
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty users list', async () => {
      server.use(
        http.get('*/api/users', () => {
          return HttpResponse.json({
            items: [],
            total: 0,
            page: 1,
            pageSize: 10,
            totalPages: 0,
          });
        })
      );

      const { result } = renderHook(() => useUsers());

      await act(async () => {
        await result.current.fetchUsers();
      });

      expect(result.current.users).toEqual([]);
      expect(result.current.total).toBe(0);
      expect(result.current.totalPages).toBe(0);
      expect(result.current.error).toBeNull();
    });

    it('should handle updating non-existent user', async () => {
      server.use(
        http.get('*/api/users', () => {
          return HttpResponse.json(mockUsersResponse);
        }),
        http.patch('*/api/users/:id', () => {
          return HttpResponse.json(
            { message: 'User not found' },
            { status: 404 }
          );
        })
      );

      const { result } = renderHook(() => useUsers());

      await act(async () => {
        await result.current.fetchUsers();
      });

      await expect(async () => {
        await act(async () => {
          await result.current.updateUser('non-existent-id', { isActive: false });
        });
      }).rejects.toThrow();
    });

    it('should handle updating roles for non-existent user', async () => {
      server.use(
        http.get('*/api/users', () => {
          return HttpResponse.json(mockUsersResponse);
        }),
        http.put('*/api/users/:id/roles', () => {
          return HttpResponse.json(
            { message: 'User not found' },
            { status: 404 }
          );
        })
      );

      const { result } = renderHook(() => useUsers());

      await act(async () => {
        await result.current.fetchUsers();
      });

      await expect(async () => {
        await act(async () => {
          await result.current.updateUserRoles('non-existent-id', ['Admin']);
        });
      }).rejects.toThrow();
    });

    it('should handle concurrent fetch requests', async () => {
      let requestCount = 0;

      server.use(
        http.get('*/api/users', async () => {
          requestCount++;
          // Simulate network delay
          await new Promise((resolve) => setTimeout(resolve, 10));
          return HttpResponse.json(mockUsersResponse);
        })
      );

      const { result } = renderHook(() => useUsers());

      // Start multiple fetches concurrently
      await act(async () => {
        await Promise.all([
          result.current.fetchUsers(),
          result.current.fetchUsers(),
          result.current.fetchUsers(),
        ]);
      });

      // All should complete successfully
      expect(result.current.users.length).toBe(2);
      expect(result.current.error).toBeNull();
      // Should have made 3 requests
      expect(requestCount).toBe(3);
    });

    it('should handle update while users list is empty', async () => {
      // Don't set up a handler, so users list stays empty
      const { result } = renderHook(() => useUsers());

      expect(result.current.users).toEqual([]);

      server.use(
        http.patch('*/api/users/:id', () => {
          return HttpResponse.json({
            ...mockUser1,
            isActive: false,
          });
        })
      );

      // Update should succeed but not affect the empty list
      await act(async () => {
        await result.current.updateUser('user-1', { isActive: false });
      });

      // List should still be empty since user wasn't in it
      expect(result.current.users).toEqual([]);
    });
  });

  describe('State Consistency', () => {
    it('should maintain state consistency after multiple operations', async () => {
      server.use(
        http.get('*/api/users', () => {
          return HttpResponse.json(mockUsersResponse);
        }),
        http.patch('*/api/users/:id', ({ params }) => {
          if (params.id === 'user-1') {
            return HttpResponse.json({
              ...mockUser1,
              isActive: false,
            });
          }
          return HttpResponse.json({ message: 'Not found' }, { status: 404 });
        }),
        http.put('*/api/users/:id/roles', ({ params }) => {
          if (params.id === 'user-1') {
            return HttpResponse.json({
              ...mockUser1,
              isActive: false,
              roles: ['Admin'],
            });
          }
          return HttpResponse.json({ message: 'Not found' }, { status: 404 });
        })
      );

      const { result } = renderHook(() => useUsers());

      // Fetch users
      await act(async () => {
        await result.current.fetchUsers();
      });

      expect(result.current.users.length).toBe(2);

      // Update user
      await act(async () => {
        await result.current.updateUser('user-1', { isActive: false });
      });

      expect(result.current.users[0].isActive).toBe(false);

      // Update roles
      await act(async () => {
        await result.current.updateUserRoles('user-1', ['Admin']);
      });

      expect(result.current.users[0].roles).toEqual(['Admin']);
      expect(result.current.users.length).toBe(2); // Length should still be 2
      expect(result.current.error).toBeNull();
    });
  });
});
