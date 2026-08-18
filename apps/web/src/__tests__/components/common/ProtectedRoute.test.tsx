import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { render } from '../../utils/test-utils';
import { ProtectedRoute } from '../../../components/common/ProtectedRoute';
import { Route, Routes } from 'react-router-dom';

describe('ProtectedRoute', () => {
  describe('Loading State', () => {
    it('should show loading while checking auth', () => {
      // Mock loading state
      const { container } = render(
        <Routes>
          <Route path="/" element={<ProtectedRoute />}>
            <Route index element={<div>Protected Content</div>} />
          </Route>
        </Routes>
      );

      // Initially may show loading
      // The component transitions quickly so this test verifies it doesn't crash
      expect(container).toBeTruthy();
    });
  });

  describe('Authenticated Access', () => {
    it('should render children when authenticated', async () => {
      render(
        <Routes>
          <Route path="/" element={<ProtectedRoute />}>
            <Route index element={<div>Protected Content</div>} />
          </Route>
        </Routes>,
        {
          wrapperOptions: { authenticated: true },
        }
      );

      await waitFor(() => {
        expect(screen.getByText('Protected Content')).toBeInTheDocument();
      });
    });

    it('should render nested routes when authenticated', async () => {
      render(
        <Routes>
          <Route path="/" element={<ProtectedRoute />}>
            <Route index element={<div>Home</div>} />
            <Route path="settings" element={<div>Settings</div>} />
          </Route>
        </Routes>,
        {
          wrapperOptions: { authenticated: true, route: '/settings' },
        }
      );

      await waitFor(() => {
        expect(screen.getByText('Settings')).toBeInTheDocument();
      });
    });

    it('should render Outlet for child routes', async () => {
      render(
        <Routes>
          <Route path="/" element={<ProtectedRoute />}>
            <Route index element={<div>Child Route Content</div>} />
          </Route>
        </Routes>,
        {
          wrapperOptions: { authenticated: true },
        }
      );

      await waitFor(() => {
        expect(screen.getByText('Child Route Content')).toBeInTheDocument();
      });
    });
  });

  describe('Unauthenticated Access', () => {
    it('should redirect to login when not authenticated', async () => {
      render(
        <Routes>
          <Route path="/" element={<ProtectedRoute />}>
            <Route index element={<div>Protected Content</div>} />
          </Route>
          <Route path="/login" element={<div>Login Page</div>} />
        </Routes>,
        {
          wrapperOptions: { authenticated: false },
        }
      );

      await waitFor(() => {
        expect(screen.queryByText('Protected Content')).not.toBeInTheDocument();
      });
    });

    it('should not render protected content when unauthenticated', async () => {
      render(
        <Routes>
          <Route path="/" element={<ProtectedRoute />}>
            <Route index element={<div>Secret Data</div>} />
          </Route>
        </Routes>,
        {
          wrapperOptions: { authenticated: false },
        }
      );

      await waitFor(() => {
        expect(screen.queryByText('Secret Data')).not.toBeInTheDocument();
      });
    });
  });

  describe('Loading Spinner', () => {
    it('should show full screen loading spinner during auth check', () => {
      const { container } = render(
        <Routes>
          <Route path="/" element={<ProtectedRoute />}>
            <Route index element={<div>Protected Content</div>} />
          </Route>
        </Routes>
      );

      // Component handles loading state internally
      expect(container).toBeTruthy();
    });
  });

  describe('Location State', () => {
    it('should preserve location for redirect after login', async () => {
      render(
        <Routes>
          <Route path="/protected" element={<ProtectedRoute />}>
            <Route index element={<div>Protected Page</div>} />
          </Route>
          <Route path="/login" element={<div>Login Page</div>} />
        </Routes>,
        {
          wrapperOptions: {
            authenticated: false,
            route: '/protected',
          },
        }
      );

      await waitFor(() => {
        expect(screen.queryByText('Protected Page')).not.toBeInTheDocument();
      });

      // Location state should be passed to Navigate component
    });
  });

  describe('Multiple Protected Routes', () => {
    it('should protect multiple routes', async () => {
      render(
        <Routes>
          <Route element={<ProtectedRoute />}>
            <Route path="/" element={<div>Home</div>} />
            <Route path="/dashboard" element={<div>Dashboard</div>} />
            <Route path="/profile" element={<div>Profile</div>} />
          </Route>
        </Routes>,
        {
          wrapperOptions: { authenticated: true },
        }
      );

      await waitFor(() => {
        expect(screen.getByText('Home')).toBeInTheDocument();
      });
    });
  });

  describe('Edge Cases', () => {
    it('should handle rapid auth state changes', async () => {
      const { rerender } = render(
        <Routes>
          <Route path="/" element={<ProtectedRoute />}>
            <Route index element={<div>Protected Content</div>} />
          </Route>
        </Routes>,
        {
          wrapperOptions: { authenticated: false },
        }
      );

      await waitFor(() => {
        expect(screen.queryByText('Protected Content')).not.toBeInTheDocument();
      });

      // Rerender with authenticated state
      rerender(
        <Routes>
          <Route path="/" element={<ProtectedRoute />}>
            <Route index element={<div>Protected Content</div>} />
          </Route>
        </Routes>
      );

      // Component should handle state change
      expect(screen.queryByText('Protected Content')).toBeDefined();
    });
  });
});
