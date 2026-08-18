import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { render } from '@testing-library/react';
import { BrowserRouter, MemoryRouter } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { server } from './mocks/server';
import App from '../App';

/**
 * The two admin pages are replaced with UNGUARDED stand-ins.
 *
 * Both real pages already self-guard on the same permission and redirect to
 * `/`, so with them in place a route-guard test passes whether or not the route
 * guard exists — the page's own check produces an identical redirect. Mocking
 * them away is what makes these assertions actually about `App.tsx`'s wiring:
 * anything that renders here reached the page, and any redirect came from the
 * route.
 *
 * The page-level checks stay in the app as defence for a page mounted from
 * anywhere else; they are covered by those pages' own suites.
 */
vi.mock('../pages/SystemSettingsPage', () => ({
  default: () => <h1>System Settings</h1>,
}));

vi.mock('../pages/UserManagementPage', () => ({
  default: () => <h1>User Management</h1>,
}));

const API_BASE = '*/api';

/** Overrides `GET /auth/me` for one test, so the route tree sees this user. */
function signInAs(permissions: string[], roles: string[] = ['viewer']) {
  server.use(
    http.get(`${API_BASE}/auth/me`, () =>
      HttpResponse.json({
        data: {
          id: 'test-user-id',
          email: 'test@example.com',
          displayName: 'Test User',
          profileImageUrl: null,
          roles: roles.map((name) => ({ name })),
          permissions,
          isActive: true,
          createdAt: new Date().toISOString(),
        },
      }),
    ),
  );
}

describe('App', () => {
  it('renders without crashing and shows login page initially', async () => {
    render(
      <BrowserRouter>
        <App />
      </BrowserRouter>,
    );

    // Wait for lazy loaded component to render
    // The App will make an API call to check auth, MSW will handle it
    await waitFor(
      () => {
        // Should either show login page or home page depending on mock auth state
        const welcomeText = screen.queryByText(/Welcome/i);
        const homeText = screen.queryByText(/Home Page/i);
        expect(welcomeText || homeText).toBeTruthy();
      },
      { timeout: 5000 },
    );
  });

  describe('Route-level authorization', () => {
    /**
     * Issue #55. `ProtectedRoute` establishes only that SOMEONE is logged in.
     * Authorization now happens at the route too, through `RequirePermission`
     * — which until this change was dead code with zero usages anywhere in the
     * app despite existing, tested, in `components/common/`.
     *
     * These render the REAL route tree from `App.tsx` (with the pages stubbed
     * out, see the mocks above) because the thing under test is the wiring in
     * that file and nothing else.
     */
    it('redirects a user without system_settings:read away from /admin/settings', async () => {
      signInAs(['user_settings:read']);

      render(
        <MemoryRouter initialEntries={['/admin/settings']}>
          <App />
        </MemoryRouter>,
      );

      await waitFor(() => expect(screen.getByText(/welcome back/i)).toBeInTheDocument(), {
        timeout: 5000,
      });
      expect(screen.queryByRole('heading', { name: /system settings/i })).not.toBeInTheDocument();
    });

    it('redirects a user without users:read away from /admin/users', async () => {
      signInAs(['user_settings:read']);

      render(
        <MemoryRouter initialEntries={['/admin/users']}>
          <App />
        </MemoryRouter>,
      );

      await waitFor(() => expect(screen.getByText(/welcome back/i)).toBeInTheDocument(), {
        timeout: 5000,
      });
      expect(screen.queryByRole('heading', { name: /user management/i })).not.toBeInTheDocument();
    });

    it('lets a user holding system_settings:read reach /admin/settings', async () => {
      signInAs(['user_settings:read', 'system_settings:read'], ['admin']);

      render(
        <MemoryRouter initialEntries={['/admin/settings']}>
          <App />
        </MemoryRouter>,
      );

      await waitFor(
        () =>
          expect(screen.getByRole('heading', { name: /system settings/i })).toBeInTheDocument(),
        { timeout: 5000 },
      );
    });

    it('gates on the permission, not the admin role', async () => {
      // A Contributor granted `system_settings:read` gets in. That user is
      // precisely the one the old three-idiom gating stranded: a menu entry and
      // a quick action pointing at a page whose only route in was the URL bar.
      signInAs(['user_settings:read', 'system_settings:read'], ['contributor']);

      render(
        <MemoryRouter initialEntries={['/admin/settings']}>
          <App />
        </MemoryRouter>,
      );

      await waitFor(
        () =>
          expect(screen.getByRole('heading', { name: /system settings/i })).toBeInTheDocument(),
        { timeout: 5000 },
      );
    });

    it('admits an admin holding users:read to /admin/users', async () => {
      signInAs(['user_settings:read', 'users:read', 'allowlist:read'], ['admin']);

      render(
        <MemoryRouter initialEntries={['/admin/users']}>
          <App />
        </MemoryRouter>,
      );

      await waitFor(
        () =>
          expect(screen.getByRole('heading', { name: /user management/i })).toBeInTheDocument(),
        { timeout: 5000 },
      );
    });
  });
});
