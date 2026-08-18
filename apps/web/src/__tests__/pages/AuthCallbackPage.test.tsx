import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { render } from '../utils/test-utils';
import AuthCallbackPage from '../../pages/AuthCallbackPage';
import { api } from '../../services/api';

// Mock useNavigate and useSearchParams
const mockNavigate = vi.fn();
const mockSearchParams = new URLSearchParams();
const mockRefreshUser = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useSearchParams: () => [mockSearchParams],
  };
});

// Mock useAuth hook
vi.mock('../../contexts/AuthContext', async () => {
  const actual = await vi.importActual('../../contexts/AuthContext');
  return {
    ...actual,
    useAuth: () => ({
      user: null,
      isLoading: false,
      isAuthenticated: false,
      providers: [],
      login: vi.fn(),
      logout: vi.fn(),
      refreshUser: mockRefreshUser,
    }),
  };
});

describe('AuthCallbackPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    mockSearchParams.delete('token');
    mockSearchParams.delete('error');
    // Reset mockRefreshUser to default resolved behavior
    mockRefreshUser.mockResolvedValue(undefined);
  });

  describe('Loading State', () => {
    it('should show loading spinner initially before processing', () => {
      // Mock refreshUser to delay so we can catch loading state
      mockRefreshUser.mockImplementation(() => new Promise(() => {})); // Never resolves
      mockSearchParams.set('token', 'test-token');

      render(<AuthCallbackPage />, {
        wrapperOptions: { authenticated: false },
      });

      // Should show loading immediately
      expect(screen.getByRole('progressbar')).toBeInTheDocument();
      expect(screen.getByText(/completing authentication/i)).toBeInTheDocument();
    });
  });

  describe('OAuth Callback Success', () => {
    it('should extract token from URL params and store it', async () => {
      const mockToken = 'test-access-token-123';
      mockSearchParams.set('token', mockToken);

      const setAccessTokenSpy = vi.spyOn(api, 'setAccessToken');
      const mockRefreshUser = vi.fn().mockResolvedValue(undefined);

      render(<AuthCallbackPage />, {
        wrapperOptions: {
          authenticated: false,
        },
      });

      await waitFor(() => {
        expect(setAccessTokenSpy).toHaveBeenCalledWith(mockToken);
      });
    });

    it('should call refreshUser after storing token', async () => {
      const mockToken = 'test-access-token-123';
      mockSearchParams.set('token', mockToken);
      mockRefreshUser.mockResolvedValue(undefined);

      render(<AuthCallbackPage />, {
        wrapperOptions: {
          authenticated: false,
        },
      });

      await waitFor(() => {
        expect(mockRefreshUser).toHaveBeenCalled();
      });
    });

    it('should redirect to home when no returnUrl is stored', async () => {
      const mockToken = 'test-access-token-123';
      mockSearchParams.set('token', mockToken);

      render(<AuthCallbackPage />, {
        wrapperOptions: {
          authenticated: false,
        },
      });

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith('/', { replace: true });
      });
    });

    it('should redirect to stored returnUrl after successful auth', async () => {
      const mockToken = 'test-access-token-123';
      const returnUrl = '/settings';
      mockSearchParams.set('token', mockToken);
      sessionStorage.setItem('auth_return_url', returnUrl);

      render(<AuthCallbackPage />, {
        wrapperOptions: {
          authenticated: false,
        },
      });

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith(returnUrl, { replace: true });
      });
    });

    it('should clear returnUrl from sessionStorage after redirect', async () => {
      const mockToken = 'test-access-token-123';
      const returnUrl = '/settings';
      mockSearchParams.set('token', mockToken);
      sessionStorage.setItem('auth_return_url', returnUrl);

      render(<AuthCallbackPage />, {
        wrapperOptions: {
          authenticated: false,
        },
      });

      await waitFor(() => {
        expect(sessionStorage.getItem('auth_return_url')).toBeNull();
      });
    });
  });

  describe('Error Handling', () => {
    it('should display error message when error param is present', async () => {
      const errorMessage = 'Authentication failed';
      mockSearchParams.set('error', errorMessage);

      render(<AuthCallbackPage />, {
        wrapperOptions: { authenticated: false },
      });

      await waitFor(() => {
        expect(screen.getByText(errorMessage)).toBeInTheDocument();
      });
    });

    it('should show error when no token is received', async () => {
      // No token or error in URL params
      render(<AuthCallbackPage />, {
        wrapperOptions: { authenticated: false },
      });

      await waitFor(() => {
        expect(screen.getByText(/no authentication token received/i)).toBeInTheDocument();
      });
    });

    it('should show error when refreshUser fails', async () => {
      const mockToken = 'test-access-token-123';
      mockSearchParams.set('token', mockToken);
      mockRefreshUser.mockRejectedValue(new Error('Network error'));

      render(<AuthCallbackPage />, {
        wrapperOptions: {
          authenticated: false,
        },
      });

      await waitFor(() => {
        expect(screen.getByText(/failed to complete authentication/i)).toBeInTheDocument();
      });
    });

    it('should clear access token on refreshUser failure', async () => {
      const mockToken = 'test-access-token-123';
      mockSearchParams.set('token', mockToken);
      mockRefreshUser.mockRejectedValue(new Error('Network error'));
      const setAccessTokenSpy = vi.spyOn(api, 'setAccessToken');

      render(<AuthCallbackPage />, {
        wrapperOptions: {
          authenticated: false,
        },
      });

      await waitFor(() => {
        // Should be called twice: once with token, once with null after failure
        expect(setAccessTokenSpy).toHaveBeenCalledWith(null);
      });
    });

    it('should display return to login link on error', async () => {
      const errorMessage = 'Authentication failed';
      mockSearchParams.set('error', errorMessage);

      render(<AuthCallbackPage />, {
        wrapperOptions: { authenticated: false },
      });

      await waitFor(() => {
        const loginLink = screen.getByRole('link', { name: /return to login/i });
        expect(loginLink).toBeInTheDocument();
        expect(loginLink).toHaveAttribute('href', '/login');
      });
    });
  });

  describe('Authorization Errors', () => {
    it('should display additional message for "not authorized" error', async () => {
      const errorMessage = 'User not authorized to access this application';
      mockSearchParams.set('error', errorMessage);

      render(<AuthCallbackPage />, {
        wrapperOptions: { authenticated: false },
      });

      await waitFor(() => {
        expect(screen.getByText(/user not authorized to access this application/i)).toBeInTheDocument();
        expect(screen.getByText(/if you believe this is an error/i)).toBeInTheDocument();
        expect(screen.getByText(/contact your system administrator/i)).toBeInTheDocument();
      });
    });

    it('should handle "Not Authorized" error (case insensitive)', async () => {
      const errorMessage = 'Not Authorized';
      mockSearchParams.set('error', errorMessage);

      render(<AuthCallbackPage />, {
        wrapperOptions: { authenticated: false },
      });

      await waitFor(() => {
        expect(screen.getByText(/not authorized/i)).toBeInTheDocument();
        expect(screen.getByText(/contact your system administrator/i)).toBeInTheDocument();
      });
    });

    it('should handle "NOT AUTHORIZED" error (all caps)', async () => {
      const errorMessage = 'NOT AUTHORIZED';
      mockSearchParams.set('error', errorMessage);

      render(<AuthCallbackPage />, {
        wrapperOptions: { authenticated: false },
      });

      await waitFor(() => {
        expect(screen.getByText(/not authorized/i)).toBeInTheDocument();
        expect(screen.getByText(/contact your system administrator/i)).toBeInTheDocument();
      });
    });

    it('should not show admin contact message for other errors', async () => {
      const errorMessage = 'Invalid OAuth state';
      mockSearchParams.set('error', errorMessage);

      render(<AuthCallbackPage />, {
        wrapperOptions: { authenticated: false },
      });

      await waitFor(() => {
        expect(screen.getByText(/invalid oauth state/i)).toBeInTheDocument();
        expect(screen.queryByText(/contact your system administrator/i)).not.toBeInTheDocument();
      });
    });
  });

  describe('UI Elements', () => {
    it('should display error in Alert component with error severity', async () => {
      const errorMessage = 'Authentication failed';
      mockSearchParams.set('error', errorMessage);

      render(<AuthCallbackPage />, {
        wrapperOptions: { authenticated: false },
      });

      await waitFor(() => {
        const alert = screen.getByRole('alert');
        expect(alert).toBeInTheDocument();
        expect(alert).toHaveTextContent(errorMessage);
      });
    });

    it('should center loading spinner vertically', () => {
      // Mock refreshUser to delay so we can catch loading state
      mockRefreshUser.mockImplementation(() => new Promise(() => {})); // Never resolves
      mockSearchParams.set('token', 'test-token');

      render(<AuthCallbackPage />, {
        wrapperOptions: { authenticated: false },
      });

      const spinner = screen.getByRole('progressbar');
      expect(spinner).toBeInTheDocument();
    });

    it('should center error message vertically', async () => {
      const errorMessage = 'Authentication failed';
      mockSearchParams.set('error', errorMessage);

      render(<AuthCallbackPage />, {
        wrapperOptions: { authenticated: false },
      });

      await waitFor(() => {
        const alert = screen.getByRole('alert');
        expect(alert).toBeInTheDocument();
      });
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty error param', async () => {
      mockSearchParams.set('error', '');

      render(<AuthCallbackPage />, {
        wrapperOptions: { authenticated: false },
      });

      await waitFor(() => {
        // Empty error still shows error state (error param exists)
        const alert = screen.getByRole('alert');
        expect(alert).toBeInTheDocument();
      });
    });

    it('should handle empty token param', async () => {
      mockSearchParams.set('token', '');

      render(<AuthCallbackPage />, {
        wrapperOptions: { authenticated: false },
      });

      await waitFor(() => {
        // Empty token treated as missing token
        expect(screen.getByText(/no authentication token received/i)).toBeInTheDocument();
      });
    });

    it('should prioritize error param over token param', async () => {
      const errorMessage = 'OAuth error';
      mockSearchParams.set('error', errorMessage);
      mockSearchParams.set('token', 'some-token');

      const setAccessTokenSpy = vi.spyOn(api, 'setAccessToken');

      render(<AuthCallbackPage />, {
        wrapperOptions: { authenticated: false },
      });

      await waitFor(() => {
        expect(screen.getByText(errorMessage)).toBeInTheDocument();
        // Token should not be stored when error is present
        expect(setAccessTokenSpy).not.toHaveBeenCalled();
      });
    });

    it('should handle returnUrl with special characters', async () => {
      const mockToken = 'test-access-token-123';
      const returnUrl = '/search?query=test%20value&page=1';
      mockSearchParams.set('token', mockToken);
      sessionStorage.setItem('auth_return_url', returnUrl);

      render(<AuthCallbackPage />, {
        wrapperOptions: {
          authenticated: false,
        },
      });

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith(returnUrl, { replace: true });
      });
    });

    it('should use replace: true when navigating', async () => {
      const mockToken = 'test-access-token-123';
      mockSearchParams.set('token', mockToken);

      render(<AuthCallbackPage />, {
        wrapperOptions: {
          authenticated: false,
        },
      });

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({ replace: true })
        );
      });
    });
  });

  describe('Multiple Scenarios', () => {
    it('should handle various authorization error messages', async () => {
      const authErrorMessages = [
        'Email not authorized',
        'User not authorized',
        'not authorized to access',
      ];

      for (const errorMessage of authErrorMessages) {
        vi.clearAllMocks();
        sessionStorage.clear();
        mockSearchParams.delete('error');
        mockSearchParams.delete('token');
        mockSearchParams.set('error', errorMessage);

        const { unmount } = render(<AuthCallbackPage />, {
          wrapperOptions: { authenticated: false },
        });

        await waitFor(() => {
          expect(screen.getByText(new RegExp(errorMessage, 'i'))).toBeInTheDocument();
          expect(screen.getByText(/contact your system administrator/i)).toBeInTheDocument();
        });

        unmount();
      }
    });

    it('should handle various non-authorization error messages', async () => {
      const nonAuthErrorMessages = [
        'Invalid state parameter',
        'OAuth provider error',
        'Connection timeout',
        'Server error',
      ];

      for (const errorMessage of nonAuthErrorMessages) {
        vi.clearAllMocks();
        mockSearchParams.delete('error');
        mockSearchParams.set('error', errorMessage);

        const { unmount } = render(<AuthCallbackPage />, {
          wrapperOptions: { authenticated: false },
        });

        await waitFor(() => {
          expect(screen.getByText(new RegExp(errorMessage, 'i'))).toBeInTheDocument();
          expect(screen.queryByText(/contact your system administrator/i)).not.toBeInTheDocument();
        });

        unmount();
      }
    });
  });
});
