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
vi.mock('../pages/ControlCenterPage', () => ({
  default: () => <h1>Control Center</h1>,
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
        // Either the login page or the cockpit, depending on the mocked auth
        // state. The dashboard's h1 is matched by ROLE rather than by text:
        // "Cockpit" is also the navigation rail's label for `/`, so a bare
        // text query would pass on the chrome alone.
        const cockpitHeading = screen.queryByRole('heading', {
          level: 1,
          name: /^cockpit$/i,
        });
        const loginText = screen.queryByText(/sign in/i);
        expect(cockpitHeading || loginText).toBeTruthy();
      },
      { timeout: 5000 },
    );
  });

  describe('Route-level authorization', () => {
    /**
     * Epic #19. `ProtectedRoute` establishes only that SOMEONE is logged in.
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

      await waitFor(
        () =>
          expect(
            screen.getByRole('heading', { level: 1, name: /^cockpit$/i }),
          ).toBeInTheDocument(),
        { timeout: 5000 },
      );
      expect(
        screen.queryByRole('heading', { name: /control center/i }),
      ).not.toBeInTheDocument();
    });

    it('redirects a user without users:read away from /admin/users', async () => {
      signInAs(['user_settings:read']);

      render(
        <MemoryRouter initialEntries={['/admin/users']}>
          <App />
        </MemoryRouter>,
      );

      await waitFor(
        () =>
          expect(
            screen.getByRole('heading', { level: 1, name: /^cockpit$/i }),
          ).toBeInTheDocument(),
        { timeout: 5000 },
      );
      expect(
        screen.queryByRole('heading', { name: /user management/i }),
      ).not.toBeInTheDocument();
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
          expect(
            screen.getByRole('heading', { name: /control center/i }),
          ).toBeInTheDocument(),
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
          expect(
            screen.getByRole('heading', { name: /control center/i }),
          ).toBeInTheDocument(),
        { timeout: 5000 },
      );
    });

    it('admits an admin holding users:read to /admin/users', async () => {
      signInAs(
        ['user_settings:read', 'users:read', 'allowlist:read'],
        ['admin'],
      );

      render(
        <MemoryRouter initialEntries={['/admin/users']}>
          <App />
        </MemoryRouter>,
      );

      await waitFor(
        () =>
          expect(
            screen.getByRole('heading', { name: /user management/i }),
          ).toBeInTheDocument(),
        { timeout: 5000 },
      );
    });

    it('mounts the planned cockpit routes for any authenticated user', async () => {
      // The four planned destinations carry no permission — no controller
      // enforces one — so no `RequirePermission` guards their routes either.
      // A Viewer must reach all four; see `config/destinations.ts`.
      for (const [path, heading] of [
        ['/runs', /^runs$/i],
        ['/queue', /^queue$/i],
        ['/projects', /^projects$/i],
        ['/cost', /^cost$/i],
      ] as const) {
        signInAs(['user_settings:read']);

        const { unmount } = render(
          <MemoryRouter initialEntries={[path]}>
            <App />
          </MemoryRouter>,
        );

        await waitFor(
          () =>
            expect(
              screen.getByRole('heading', { level: 1, name: heading }),
            ).toBeInTheDocument(),
          { timeout: 5000 },
        );

        unmount();
      }
    });
  });

  describe('The catch-all', () => {
    /**
     * Issue #78. This route used to be `<Navigate to="/" replace />` at the top
     * level, so a stale bookmark, a renamed route and a plain typo all became
     * the dashboard silently. Two things are asserted here, and the second is
     * the one the placement inside `Layout` buys:
     *   1. a bad URL renders the 404 rather than redirecting;
     *   2. it renders INSIDE the shell, so the navigation is right there.
     */
    it('renders the 404 page inside the shell for an authenticated user', async () => {
      signInAs(['user_settings:read']);

      render(
        <MemoryRouter initialEntries={['/no-such-page']}>
          <App />
        </MemoryRouter>,
      );

      await waitFor(
        () =>
          expect(
            screen.getByRole('heading', { level: 1, name: /page not found/i }),
          ).toBeInTheDocument(),
        { timeout: 5000 },
      );

      // The attempted path is echoed — the entire diagnostic value of a 404.
      expect(screen.getByText('/no-such-page')).toBeInTheDocument();
      // …and the shell came with it.
      expect(screen.getByRole('banner')).toBeInTheDocument();
    });

    it('no longer redirects an unknown path to the dashboard', async () => {
      signInAs(['user_settings:read']);

      render(
        <MemoryRouter initialEntries={['/no-such-page']}>
          <App />
        </MemoryRouter>,
      );

      await waitFor(
        () =>
          expect(
            screen.getByRole('heading', { level: 1, name: /page not found/i }),
          ).toBeInTheDocument(),
        { timeout: 5000 },
      );
      expect(
        screen.queryByRole('heading', { level: 1, name: /^cockpit$/i }),
      ).not.toBeInTheDocument();
    });

    it('sends an anonymous visitor to the login page instead', async () => {
      // Moving the catch-all inside `ProtectedRoute` loses nothing: the guard
      // already preserves the attempted location in `state.from`.
      server.use(
        http.get(
          `${API_BASE}/auth/me`,
          () => new HttpResponse(null, { status: 401 }),
        ),
        http.post(
          `${API_BASE}/auth/refresh`,
          () => new HttpResponse(null, { status: 401 }),
        ),
      );

      render(
        <MemoryRouter initialEntries={['/no-such-page']}>
          <App />
        </MemoryRouter>,
      );

      await waitFor(
        () =>
          expect(
            screen.getByRole('heading', { name: /welcome/i }),
          ).toBeInTheDocument(),
        { timeout: 5000 },
      );
      expect(screen.queryByText(/page not found/i)).not.toBeInTheDocument();
    });
  });
});
