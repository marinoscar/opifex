import { ThemeProvider } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { ThemeContextProvider, useThemeContext } from './contexts/ThemeContext';
import { ProtectedRoute } from './components/common/ProtectedRoute';
import { RequirePermission } from './components/common/RequirePermission';
import { Layout } from './components/common/Layout';
import { ErrorBoundary } from './components/common/ErrorBoundary';

// Pages (lazy loaded)
import { Suspense, lazy } from 'react';
import { LoadingSpinner } from './components/common/LoadingSpinner';

const LoginPage = lazy(() => import('./pages/LoginPage'));
const AuthCallbackPage = lazy(() => import('./pages/AuthCallbackPage'));
const ActivateDevicePage = lazy(() => import('./pages/ActivateDevicePage'));
const DashboardPage = lazy(() => import('./pages/DashboardPage'));
// The four planned cockpit pages. They are lazy like every other page, which
// costs nothing today and means the chunk boundary is already in place when
// each one grows a DataTable.
const RunsPage = lazy(() => import('./pages/RunsPage'));
const QueuePage = lazy(() => import('./pages/QueuePage'));
const ProjectsPage = lazy(() => import('./pages/ProjectsPage'));
const CostPage = lazy(() => import('./pages/CostPage'));
const NotFoundPage = lazy(() => import('./pages/NotFoundPage'));
const UserSettingsPage = lazy(() => import('./pages/UserSettingsPage'));
const SystemSettingsPage = lazy(() => import('./pages/SystemSettingsPage'));
const UserManagementPage = lazy(() => import('./pages/UserManagementPage'));

// Test login page (development only)
const TestLoginPage = import.meta.env.PROD
  ? null
  : lazy(() => import('./pages/TestLoginPage'));

function AppRoutes() {
  const { theme } = useThemeContext();

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <ErrorBoundary>
        <Suspense fallback={<LoadingSpinner fullScreen />}>
          <Routes>
            {/* Public routes */}
            <Route path="/login" element={<LoginPage />} />
            <Route path="/auth/callback" element={<AuthCallbackPage />} />

            {/* Test login (development only) */}
            {!import.meta.env.PROD && TestLoginPage && (
              <Route path="/testing/login" element={<TestLoginPage />} />
            )}

            {/* Protected routes */}
            <Route element={<ProtectedRoute />}>
              {/* Device activation page - without layout for full-screen experience */}
              <Route path="/activate" element={<ActivateDevicePage />} />

              <Route element={<Layout />}>
                <Route path="/" element={<DashboardPage />} />
                {/* The planned cockpit pages carry NO `RequirePermission`, and
                    that is the same decision as their `permission: undefined`
                    in `config/destinations.ts`: the permission a route requires
                    is the one its API controller enforces, and no controller
                    enforces anything here because no endpoint exists. Guarding
                    them on an invented string would gate them on a permission
                    the API can never grant. Each gains its real permission in
                    the pull request that adds its endpoint. */}
                <Route path="/runs" element={<RunsPage />} />
                <Route path="/queue" element={<QueuePage />} />
                <Route path="/projects" element={<ProjectsPage />} />
                <Route path="/cost" element={<CostPage />} />
                <Route path="/settings" element={<UserSettingsPage />} />
                {/* Route-level AUTHORIZATION, not just authentication.
                    `ProtectedRoute` above only establishes that someone is
                    logged in — before this, a Viewer typing `/admin/settings`
                    reached the page and only then watched every API call 403.
                    `RequirePermission` was already in the codebase but had zero
                    usages; wrapping these two routes is what turns it into the
                    enforcement point.

                    The permission on each route is the SAME string its
                    destination declares in `config/destinations.ts`, which is
                    the same string the API's controller enforces — so the rail
                    row, the menu entry, the quick action, and the route can no
                    longer disagree about who may go where. */}
                <Route
                  path="/admin/users"
                  element={
                    <RequirePermission
                      permission="users:read"
                      fallback={<Navigate to="/" replace />}
                    >
                      <UserManagementPage />
                    </RequirePermission>
                  }
                />
                <Route
                  path="/admin/settings"
                  element={
                    <RequirePermission
                      permission="system_settings:read"
                      fallback={<Navigate to="/" replace />}
                    >
                      <SystemSettingsPage />
                    </RequirePermission>
                  }
                />

                {/* The catch-all, and it lives HERE — inside `Layout`, as the
                    last child — rather than at the top level (issue #78).
                    Three consequences, all deliberate:

                      1. A bad URL renders a 404 instead of silently becoming
                         the dashboard. `<Navigate to="/" replace />` made a
                         renamed route, a stale bookmark and a typo look
                         identical, and none of them like a mistake.
                      2. The 404 keeps the app shell, so the rail and the bottom
                         bar are right there — the fastest way out of a wrong
                         address is the navigation.
                      3. It sits inside `ProtectedRoute`, which loses nothing:
                         that guard already redirects anonymous users to
                         `/login` carrying `state.from`, so the attempted URL
                         survives the sign-in round trip. */}
                <Route path="*" element={<NotFoundPage />} />
              </Route>
            </Route>
          </Routes>
        </Suspense>
      </ErrorBoundary>
    </ThemeProvider>
  );
}

export default function App() {
  return (
    <ThemeContextProvider>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </ThemeContextProvider>
  );
}
