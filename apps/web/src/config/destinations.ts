/**
 * The destination model — canonical keys, sections, route ownership, and
 * active state.
 *
 * Issues #70 (destination model) and #71 (rail sections), epic #19. This file
 * is the SINGLE source of truth for the app's navigation targets. Before it
 * existed the same four menu paths were spelled out in four places
 * (`App.tsx`, `Sidebar.tsx`, `UserMenu.tsx`, `home/QuickActions.tsx`), each
 * with its own idea of who was allowed to see them — which is how a
 * Contributor holding `system_settings:read` ended up with a working System
 * Settings page, a menu entry pointing at it, and no sidebar row: three gates,
 * three answers.
 *
 * Two rules make the ownership table trustworthy:
 *
 *  1. **A route is owned by at most one destination.** A test asserts this
 *     against the live route list in `App.tsx`, which is what keeps the table
 *     honest as routes are added — it fails loudly the day someone adds a
 *     route and forgets this file.
 *  2. **Matching respects segment boundaries.** A bare `startsWith` — what
 *     `Sidebar` used to do — would make `/settings` own `/settingsfoo` and
 *     `/admin/users` own `/admin/users-archive`.
 *
 * `Icon` is declared as a COMPONENT, never as a rendered element. The rail
 * draws it at `small` when collapsed and `medium` when expanded, and the
 * bottom bar draws it at its own size — so the size cannot be baked in here.
 */

import type { SvgIconComponent } from '@mui/icons-material';
import SpeedIcon from '@mui/icons-material/Speed';
import RocketLaunchIcon from '@mui/icons-material/RocketLaunch';
import PendingActionsIcon from '@mui/icons-material/PendingActions';
import ThumbsUpDownIcon from '@mui/icons-material/ThumbsUpDown';
import AccountTreeIcon from '@mui/icons-material/AccountTree';
import PaidIcon from '@mui/icons-material/Paid';
import SettingsIcon from '@mui/icons-material/Settings';
import PeopleIcon from '@mui/icons-material/People';
import AdminIcon from '@mui/icons-material/AdminPanelSettings';
import VerifiedUserIcon from '@mui/icons-material/VerifiedUser';

export type DestinationKey =
  | 'dashboard'
  | 'runs'
  | 'approvals'
  | 'trust'
  | 'queue'
  | 'projects'
  | 'cost'
  | 'settings'
  | 'users'
  | 'system';

/**
 * Sections group destinations in the rail and in the phone's overflow sheet.
 *
 * There are deliberately only three, and there is deliberately NO separate
 * `/admin` sub-area. A second navigation model for administration would mean
 * two ways to be "somewhere" in the app, and it would strand the
 * longest-prefix rule below on its only real justification (`/admin/users`
 * versus `/admin/settings` as siblings). Administration is a SECTION, not a
 * place.
 */
export type DestinationSection = 'operate' | 'account' | 'admin';

export const SECTIONS: readonly { key: DestinationSection; label: string }[] = [
  { key: 'operate', label: 'Operate' },
  { key: 'account', label: 'Account' },
  { key: 'admin', label: 'Administration' },
];

/**
 * Does `prefix` own `path`? True when the path equals the prefix or continues
 * with a `/`. `'/'` matches only itself — every path starts with it, so the
 * root has to be exact or the dashboard would own the entire app.
 */
export function owns(prefix: string, path: string): boolean {
  if (prefix === '/') return path === '/';
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * Route prefixes each destination owns. Child routes are covered by their
 * parent prefix (`/admin/users/:id`, `/projects/:id/runs`, …) and do not need
 * their own entries.
 */
export const DESTINATION_ROUTES: Record<DestinationKey, readonly string[]> = {
  dashboard: ['/'],
  // `/work-orders/:idOrIdentity` (#84) is claimed by Runs rather than Queue.
  // A work order is queued before it executes, but the detail page is mostly
  // its ATTEMPTS — and the next place a reader goes from it is a run. Leaving
  // the rail on Runs matches where they came from and where they are going.
  runs: ['/runs', '/work-orders'],
  // `/approvals/:id` is covered by this prefix — the detail screen is the
  // destination's whole point, not a place of its own.
  approvals: ['/approvals'],
  // `/trust/grants/:id` is covered by this prefix. A grant's detail screen is
  // not a place of its own — it is the destination's whole point.
  trust: ['/trust'],
  queue: ['/queue'],
  projects: ['/projects'],
  cost: ['/cost'],
  settings: ['/settings'],
  users: ['/admin/users'],
  system: ['/admin/settings'],
};

/**
 * Routes deliberately owned by NO destination.
 *
 * These are reached from outside the authenticated shell entirely — the login
 * flow, the OAuth round trip, the device-activation screen — and most do not
 * even mount `Layout`. **On these routes no destination renders as active, and
 * that is correct rather than a bug.** Exported so a test can assert it
 * explicitly, which is what stops a future contributor from "fixing" it into
 * highlighting something arbitrary.
 */
export const UNOWNED_ROUTES: readonly string[] = [
  '/login',
  '/auth/callback',
  '/activate',
  '/testing/login',
];

/**
 * A navigation destination, fully described for every surface that draws it.
 *
 * `permission` is the API permission that makes the destination REACHABLE, and
 * it is deliberately the same string the corresponding controller enforces —
 * see the comments on each entry. A destination with no `permission` is
 * available to every authenticated user.
 */
export interface Destination {
  key: DestinationKey;
  /** Full label — the expanded rail, the More sheet, the user menu. */
  label: string;
  /** Shown in the 56px collapsed rail and the bottom bar. Max 8 characters. */
  compactLabel: string;
  Icon: SvgIconComponent;
  path: string;
  section: DestinationSection;
  /** API permission required to reach it; absent means "any authenticated user". */
  permission?: string;
  /**
   * `live` — the page is wired to an API that exists.
   * `planned` — the page renders an honest not-yet-wired state.
   *
   * A planned destination is still NAVIGABLE on purpose: the cockpit's shape
   * is part of what the app communicates (VISION §10), and a route that 404s
   * until Phase 4 teaches the operator nothing. What it must never do is
   * pretend to have data — see `components/common/NotWiredState.tsx`.
   */
  status: 'live' | 'planned';
}

/**
 * The destinations, in navigation order.
 *
 * GATING IS BY PERMISSION, NOT BY ROLE, and the permission is the one the API
 * actually enforces — verified against the controllers rather than assumed:
 *
 *   - `/admin/users`    → `users:read`          (`users.controller.ts`)
 *   - `/admin/settings` → `system_settings:read` (`system-settings.controller.ts`)
 *
 * `/admin/users` hosts two tabs whose data comes from two different
 * controllers: Users (`users:read`) and Allowlist (`allowlist:read`). The
 * DESTINATION gates on `users:read` only — a destination gate is about
 * REACHABILITY, and the page is worth reaching for its Users tab alone. The
 * Allowlist tab gates itself on `allowlist:read` inside the page, because a
 * tab gate is about CONTENT.
 *
 * `isAdmin` is no longer a navigation gate anywhere. It still exists (and
 * `AdminOnly` with it) for non-navigation uses, but a role check here is what
 * produced the split-brain described in the file header.
 *
 * ## Planned destinations carry NO permission, and that is load-bearing
 *
 * The doctrine above is that a `permission` here is a string some controller
 * REALLY enforces. `apps/api` has no runs, queue, projects or cost module, so
 * there is no `runs:read` to require; inventing one would make this file lie,
 * and — worse — would hide four destinations behind a permission the API can
 * never grant, since it is in no role's permission set. A test asserts the
 * invariant in both directions. When the runs controller lands, its
 * destination flips to `live` and gains its real permission in the SAME pull
 * request that adds the endpoint.
 *
 * Gating them on `system_settings.features` instead was considered and
 * rejected: `GET /api/system-settings` 403s for non-admins, so a viewer's
 * navigation would collapse to nothing. Never gate always-mounted chrome on
 * an admin-only fetch.
 */
export const DESTINATIONS: readonly Destination[] = [
  {
    key: 'dashboard',
    label: 'Cockpit',
    compactLabel: 'Cockpit',
    Icon: SpeedIcon,
    path: '/',
    section: 'operate',
    status: 'live',
  },
  {
    key: 'runs',
    label: 'Runs',
    compactLabel: 'Runs',
    Icon: RocketLaunchIcon,
    path: '/runs',
    section: 'operate',
    // LIVE as of #80, gaining its real permission in the same pull request as
    // the endpoint. `runs:read` is what `RunsController` enforces, and the
    // seeded viewer role holds it.
    status: 'live',
    permission: 'runs:read',
  },
  {
    key: 'approvals',
    label: 'Approvals',
    // Seven characters. "Approvals" is nine and would be clipped in the 56px
    // rail; the verb is what the destination is for anyway.
    compactLabel: 'Approve',
    Icon: ThumbsUpDownIcon,
    path: '/approvals',
    section: 'operate',
    // LIVE as of #98, gaining its real permission in the same pull request as
    // the endpoint — the rule this file's header sets. `approvals:read` is
    // what `ApprovalsController` enforces on the list and the detail, and all
    // three seeded roles hold it (a viewer may see what is waiting and answer
    // nothing). Deciding needs `approvals:decide`, which is a CONTENT gate
    // inside the page rather than a reachability one: the queue is worth
    // reaching to read.
    status: 'live',
    permission: 'approvals:read',
  },
  {
    key: 'trust',
    label: 'Trust',
    compactLabel: 'Trust',
    Icon: VerifiedUserIcon,
    path: '/trust',
    section: 'operate',
    // LIVE as of #101, gaining its real permission in the same pull request as
    // the endpoints — the rule this file's header sets. `trust:read` is what
    // `TrustController` and `PromotionController` both enforce on every read,
    // and all three seeded roles hold it: a viewer may see what runs
    // unattended and why it stopped.
    //
    // NOT `trust:revoke`, which a viewer lacks. Gating the destination on the
    // acting permission would hide from a viewer the one screen that says what
    // the factory is currently allowed to do without asking — a destination
    // gate is about REACHABILITY, and the revoke and demote controls gate
    // themselves inside the page.
    status: 'live',
    permission: 'trust:read',
  },
  {
    key: 'queue',
    label: 'Queue',
    compactLabel: 'Queue',
    Icon: PendingActionsIcon,
    path: '/queue',
    section: 'operate',
    // LIVE as of #80, and gaining its real permission in the same pull request
    // that added the endpoint — which is the rule this file's header sets.
    // `workorders:read` is the string `QueueController` actually enforces, and
    // it is in all three seeded roles including `viewer`, so this narrows the
    // destination to nobody it should not.
    status: 'live',
    permission: 'workorders:read',
  },
  {
    key: 'projects',
    label: 'Projects',
    compactLabel: 'Projects',
    Icon: AccountTreeIcon,
    path: '/projects',
    section: 'operate',
    // LIVE as of #80 — and NOT because a new endpoint was written for it.
    // `RepositoriesController` (#43) has served `GET /api/repositories` gated
    // on `projects:read` since Phase 1; what was missing was this flip, not an
    // endpoint. Building a cockpit read model beside it would have been a
    // second way to read the same rows.
    status: 'live',
    permission: 'projects:read',
  },
  {
    key: 'cost',
    label: 'Cost',
    compactLabel: 'Cost',
    Icon: PaidIcon,
    path: '/cost',
    section: 'operate',
    // LIVE as of #80. `runs:read` rather than `projects:read`: cost lives on
    // the run, and gating an aggregate more loosely than its rows would let
    // somebody total up runs they cannot open.
    status: 'live',
    permission: 'runs:read',
  },
  {
    key: 'settings',
    label: 'User Settings',
    compactLabel: 'Settings',
    Icon: SettingsIcon,
    path: '/settings',
    section: 'account',
    status: 'live',
  },
  {
    key: 'users',
    label: 'User Management',
    compactLabel: 'Users',
    Icon: PeopleIcon,
    path: '/admin/users',
    section: 'admin',
    permission: 'users:read',
    status: 'live',
  },
  {
    key: 'system',
    label: 'System Settings',
    compactLabel: 'System',
    Icon: AdminIcon,
    path: '/admin/settings',
    section: 'admin',
    permission: 'system_settings:read',
    status: 'live',
  },
];

/**
 * Which destination, if any, owns `pathname`.
 *
 * Longest prefix wins where prefixes overlap. That rule earns its keep twice
 * over: `/admin/users` and `/admin/settings` are siblings under a common
 * `/admin`, so the day anything claims the bare `/admin` prefix the more
 * specific sibling must still win on its own route — and `/projects/:id/runs`
 * must resolve to Projects rather than to Runs, which it does because Runs
 * owns `/runs` and nothing else.
 */
export function resolveActiveDestination(
  pathname: string,
): DestinationKey | null {
  let best: { key: DestinationKey; length: number } | null = null;

  for (const [key, prefixes] of Object.entries(DESTINATION_ROUTES) as [
    DestinationKey,
    readonly string[],
  ][]) {
    for (const prefix of prefixes) {
      if (!owns(prefix, pathname)) continue;
      if (!best || prefix.length > best.length) {
        best = { key, length: prefix.length };
      }
    }
  }

  return best?.key ?? null;
}

/**
 * The hard ceiling on bottom-bar actions.
 *
 * FOUR is not a style preference. At 360px — the narrowest phone this app
 * targets — four labelled tabs give each ~90px, which is exactly enough for
 * an icon over one short word. A fifth forces a choice between the tab and
 * `showLabels`, and dropping the labels is not available to this app: "Runs"
 * versus "Queue" versus "Cost" are not distinguishable as icons alone, and
 * Material 3 caps a label-less bar at five anyway. So the bar holds at most
 * three real destinations plus the synthetic More action below.
 */
export const BOTTOM_NAV_MAX_ACTIONS = 4;

/**
 * The destinations that get a tab of their own on a phone, in bar order.
 *
 * Chosen by what an operator opens while walking away from the desk — the
 * cockpit, what is running, what is waiting. Projects, Cost and everything
 * administrative are reference material, and reference material belongs
 * behind More rather than competing for one of three thumb-reachable slots.
 */
export const BOTTOM_NAV_KEYS: readonly DestinationKey[] = [
  'dashboard',
  'runs',
  'queue',
];

export interface BottomNavSplit {
  /** Rendered as real tabs, in `BOTTOM_NAV_KEYS` order. */
  primary: Destination[];
  /** Rendered inside the More sheet, in `DESTINATIONS` order. */
  overflow: Destination[];
}

/**
 * Split the destinations this user can see into bar tabs and sheet entries.
 *
 * `canSee` is passed in rather than read from `usePermissions` here because
 * this module is pure config — it has no hooks, which is what lets the split
 * be unit-tested against arbitrary permission shapes without a React tree.
 *
 * The `slice` is not decoration. It guarantees `primary.length + 1 <=
 * BOTTOM_NAV_MAX_ACTIONS` even if someone later appends a fourth key to
 * `BOTTOM_NAV_KEYS`, and anything it drops falls through to `overflow` rather
 * than disappearing — the bar can be wrong about PRIORITY, never about
 * REACHABILITY.
 */
export function bottomNavSplit(
  canSee: (destination: Destination) => boolean,
): BottomNavSplit {
  const visible = DESTINATIONS.filter(canSee);

  const preferred = BOTTOM_NAV_KEYS.map((key) =>
    visible.find((destination) => destination.key === key),
  ).filter(
    (destination): destination is Destination => destination !== undefined,
  );

  const primary = preferred.slice(0, BOTTOM_NAV_MAX_ACTIONS - 1);
  const primaryKeys = new Set(primary.map((destination) => destination.key));

  return {
    primary,
    overflow: visible.filter(
      (destination) => !primaryKeys.has(destination.key),
    ),
  };
}
