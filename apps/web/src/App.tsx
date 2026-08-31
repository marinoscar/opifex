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
const RunDetailPage = lazy(() => import('./pages/RunDetailPage'));
const WorkOrderDetailPage = lazy(() => import('./pages/WorkOrderDetailPage'));
const QueuePage = lazy(() => import('./pages/QueuePage'));
const SteeringPage = lazy(() => import('./pages/SteeringPage'));
const ApprovalsPage = lazy(() => import('./pages/ApprovalsPage'));
const ApprovalDetailPage = lazy(() => import('./pages/ApprovalDetailPage'));
const TrustPage = lazy(() => import('./pages/TrustPage'));
const TrustGrantDetailPage = lazy(() => import('./pages/TrustGrantDetailPage'));
const ProjectsPage = lazy(() => import('./pages/ProjectsPage'));
const CostPage = lazy(() => import('./pages/CostPage'));
const QuotaPage = lazy(() => import('./pages/QuotaPage'));
const NotFoundPage = lazy(() => import('./pages/NotFoundPage'));
const UserSettingsPage = lazy(() => import('./pages/UserSettingsPage'));
// `/admin/settings` — the Control Center (#347, epic #332). It replaced
// `SystemSettingsPage` at the same route rather than beside it: two settings
// screens would be two answers to "where is this configured".
const ControlCenterPage = lazy(() => import('./pages/ControlCenterPage'));
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
                <Route path="/runs/:id" element={<RunDetailPage />} />
                <Route
                  path="/work-orders/:idOrIdentity"
                  element={<WorkOrderDetailPage />}
                />
                <Route path="/queue" element={<QueuePage />} />
                {/* Steering (#426, epic #419). Gated on `workorders:write`,
                    which is what `SteeringController` enforces on BOTH of its
                    endpoints — propose as well as apply, because computing a
                    blast radius reads a whole backlog and is of no use to
                    somebody who could not apply the result.

                    This is the one Operate route whose gate is a WRITE
                    permission, and it is a reachability gate rather than a
                    content one for a reason peculiar to this page: there is
                    nothing here to read. Unlike the queue, the approvals list
                    or the trust screen, it has no list a viewer could usefully
                    look at with the buttons removed — the whole surface is a
                    box that calls an endpoint a viewer is refused. Applying
                    additionally needs an INTERACTIVE session (#346), which no
                    route guard can check and the API enforces: a confirmation
                    a script can send is not a confirmation. */}
                <Route
                  path="/steering"
                  element={
                    <RequirePermission
                      permission="workorders:write"
                      fallback={<Navigate to="/" replace />}
                    >
                      <SteeringPage />
                    </RequirePermission>
                  }
                />
                {/* Approvals (#98, epic #22). Unlike the cockpit routes above,
                    these DO carry a `RequirePermission`, because there is a
                    controller behind them enforcing exactly this string:
                    `ApprovalsController` requires `approvals:read` on both the
                    queue and the detail. The same string is what
                    `config/destinations.ts` declares, so the rail row and the
                    route cannot disagree about who may go where.

                    `approvals:decide` is deliberately NOT a route gate. A
                    viewer holds `approvals:read` and not `approvals:decide`,
                    and the queue is worth reaching to READ — what they must
                    not get is buttons, which the pages gate themselves. A
                    reachability gate and a content gate are different
                    questions, the same split `/admin/users` makes for its
                    Allowlist tab. */}
                <Route
                  path="/approvals"
                  element={
                    <RequirePermission
                      permission="approvals:read"
                      fallback={<Navigate to="/" replace />}
                    >
                      <ApprovalsPage />
                    </RequirePermission>
                  }
                />
                <Route
                  path="/approvals/:id"
                  element={
                    <RequirePermission
                      permission="approvals:read"
                      fallback={<Navigate to="/" replace />}
                    >
                      <ApprovalDetailPage />
                    </RequirePermission>
                  }
                />
                {/* Trust (#101, epic #22). Gated on `trust:read`, which is
                    the string `TrustController` and `PromotionController` both
                    enforce on every read, and which all three seeded roles
                    hold — a viewer may see what runs unattended and stop
                    nothing.

                    `trust:revoke` is deliberately NOT a route gate, for the
                    same reason `approvals:decide` is not: a viewer is entitled
                    to READ what may run unattended, and what they must not get
                    is the buttons. The page gates those itself. Note that
                    `trust:revoke` is held by contributors as well as admins —
                    narrowing autonomy is always the safe direction, and an
                    operator who can see a grant misbehaving must never have to
                    find an admin before stopping it. */}
                <Route
                  path="/trust"
                  element={
                    <RequirePermission
                      permission="trust:read"
                      fallback={<Navigate to="/" replace />}
                    >
                      <TrustPage />
                    </RequirePermission>
                  }
                />
                <Route
                  path="/trust/grants/:id"
                  element={
                    <RequirePermission
                      permission="trust:read"
                      fallback={<Navigate to="/" replace />}
                    >
                      <TrustGrantDetailPage />
                    </RequirePermission>
                  }
                />
                {/* `projects:read` — the string `ProjectsController` and
                    `RepositoriesController` both enforce, and the one
                    `config/destinations.ts` declares for this destination.
                    The page WRITES now (#406), so reaching it without the read
                    permission would be a screen of 403s rather than a table
                    that happened to be empty. */}
                <Route
                  path="/projects"
                  element={
                    <RequirePermission
                      permission="projects:read"
                      fallback={<Navigate to="/" replace />}
                    >
                      <ProjectsPage />
                    </RequirePermission>
                  }
                />
                <Route path="/cost" element={<CostPage />} />
                {/* Quota (#231's gauge, #476's history). Gated on
                    `runs:read`, the string `QuotaController` enforces on all
                    three of its routes — the same one Cost gates on, and for
                    the same reason: these are sums over run events, and gating
                    an aggregate more loosely than its rows would let somebody
                    total up runs they cannot open. Unlike `/cost` and `/runs`,
                    whose guards predate their endpoints, this route carries the
                    `RequirePermission` from the start: there is a controller
                    behind it enforcing exactly this string, so a viewer without
                    it should be turned away at the door rather than shown a
                    screen of 403s. */}
                <Route
                  path="/quota"
                  element={
                    <RequirePermission
                      permission="runs:read"
                      fallback={<Navigate to="/" replace />}
                    >
                      <QuotaPage />
                    </RequirePermission>
                  }
                />
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
                      <ControlCenterPage />
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
