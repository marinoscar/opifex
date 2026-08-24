import { describe, it, expect } from 'vitest';
import { isValidElement } from 'react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  BOTTOM_NAV_KEYS,
  BOTTOM_NAV_MAX_ACTIONS,
  DESTINATIONS,
  DESTINATION_ROUTES,
  SECTIONS,
  UNOWNED_ROUTES,
  bottomNavSplit,
  owns,
  resolveActiveDestination,
} from '../../config/destinations';
import type { Destination, DestinationKey } from '../../config/destinations';

/**
 * The route-ownership table is the one piece of this navigation that manual
 * testing cannot check: a route claimed by two destinations emits
 * `aria-current="page"` twice and highlights two rail rows, and a route claimed
 * by none silently highlights nothing. Both look fine on the screen you happen
 * to be standing on.
 *
 * So this suite reads the LIVE `App.tsx` rather than a copy of its route list.
 * A hand-maintained copy would drift the first time someone adds a route, which
 * is exactly the moment the assertion is supposed to fire.
 */
const APP_TSX = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../App.tsx',
);

function declaredRoutePaths(): string[] {
  const source = readFileSync(APP_TSX, 'utf8');
  const paths = [...source.matchAll(/path="([^"]+)"/g)].map(
    (match) => match[1],
  );
  // `*` is the catch-all, which renders `NotFoundPage` rather than belonging to
  // a destination. It is the one route that is deliberately owned by nothing
  // AND absent from `UNOWNED_ROUTES` — it is not a place, it is the absence of
  // one.
  return [...new Set(paths)].filter((path) => path !== '*');
}

const byKey = Object.fromEntries(DESTINATIONS.map((d) => [d.key, d])) as Record<
  DestinationKey,
  Destination
>;

describe('destinations — route ownership', () => {
  it('finds the declared routes in App.tsx at all', () => {
    // Guards the regex above: if it silently stopped matching, every assertion
    // below would pass vacuously over an empty list. The check is that every
    // destination path appears — NOT a hardcoded count, which is what made the
    // old version of this test a chore to maintain and a liability to trust.
    const paths = declaredRoutePaths();

    expect(paths).toEqual(
      expect.arrayContaining(DESTINATIONS.map((d) => d.path)),
    );
    expect(paths).toEqual(expect.arrayContaining([...UNOWNED_ROUTES]));
  });

  it('claims every route in App.tsx exactly once, or deliberately not at all', () => {
    for (const path of declaredRoutePaths()) {
      const owners = (
        Object.keys(DESTINATION_ROUTES) as DestinationKey[]
      ).filter((key) =>
        DESTINATION_ROUTES[key].some((prefix) => owns(prefix, path)),
      );

      if (UNOWNED_ROUTES.includes(path)) {
        expect(
          owners,
          `${path} is listed as unowned but a destination claims it`,
        ).toEqual([]);
      } else {
        // NOT `toHaveLength(1)` with a bare message: naming the owners is what
        // makes the failure actionable when it does fire.
        expect(
          owners,
          `${path} should be owned by exactly one destination`,
        ).toHaveLength(1);
      }
    }
  });

  it('lists every declared route as either owned or explicitly unowned', () => {
    // The complement of the assertion above: a route that is neither claimed
    // nor listed as deliberately unowned is an OVERSIGHT, and without this it
    // would pass the previous test by being "unowned by accident".
    for (const path of declaredRoutePaths()) {
      const owned = resolveActiveDestination(path) !== null;
      const explicitlyUnowned = UNOWNED_ROUTES.includes(path);
      expect(
        owned || explicitlyUnowned,
        `${path} is neither owned by a destination nor listed in UNOWNED_ROUTES`,
      ).toBe(true);
    }
  });

  it('routes every destination in the table from App.tsx', () => {
    // The other direction: a destination the rail offers but `App.tsx` never
    // routes is a link into a 404. Both halves are needed — the table and the
    // route list can each grow past the other.
    const paths = declaredRoutePaths();
    for (const destination of DESTINATIONS) {
      expect(paths, `${destination.key} has no route in App.tsx`).toContain(
        destination.path,
      );
    }
  });

  it('highlights NOTHING on the deliberately unowned routes', () => {
    // Asserted explicitly so a later contributor does not "fix" this into
    // highlighting something arbitrary. No destination is better than a wrong
    // one — the login screen does not belong to the cockpit.
    for (const path of UNOWNED_ROUTES) {
      expect(
        resolveActiveDestination(path),
        `${path} must activate no destination`,
      ).toBeNull();
    }
  });

  it('gives every destination in the table a route it owns', () => {
    for (const destination of DESTINATIONS) {
      expect(
        resolveActiveDestination(destination.path),
        `${destination.path} should activate ${destination.key}`,
      ).toBe(destination.key);
    }
  });
});

describe('destinations — segment-boundary matching', () => {
  it('matches a prefix only at a segment boundary', () => {
    expect(owns('/settings', '/settings')).toBe(true);
    expect(owns('/settings', '/settings/profile')).toBe(true);
    expect(owns('/settings', '/settingsfoo')).toBe(false);
    expect(owns('/settings', '/settings-archive')).toBe(false);
  });

  it('does not let /settingsfoo activate User Settings', () => {
    // A bare `startsWith` — what the old Sidebar's isActive did — matches here.
    expect(resolveActiveDestination('/settingsfoo')).toBeNull();
  });

  it('does not let /admin/users-archive activate User Management', () => {
    expect(resolveActiveDestination('/admin/users-archive')).toBeNull();
  });

  it('does not let /runsomething activate Runs', () => {
    // The same trap, on one of the new destinations.
    expect(resolveActiveDestination('/runsomething')).toBeNull();
  });

  it('activates the dashboard on / only, never on any other path', () => {
    // Every path starts with '/', so without the exact-match rule the dashboard
    // would own the entire app and beat nothing only by prefix length.
    expect(resolveActiveDestination('/')).toBe('dashboard');
    expect(resolveActiveDestination('/settings')).not.toBe('dashboard');
    expect(resolveActiveDestination('/runs')).not.toBe('dashboard');
    expect(resolveActiveDestination('/admin/settings')).not.toBe('dashboard');
    expect(owns('/', '/anything')).toBe(false);
  });

  it('activates a destination for its child routes', () => {
    expect(resolveActiveDestination('/settings/profile')).toBe('settings');
    expect(resolveActiveDestination('/admin/users/abc-123')).toBe('users');
    expect(resolveActiveDestination('/runs/wo_opifex_312_a3f91c2_a1')).toBe(
      'runs',
    );
  });

  it('gives the longest matching prefix the win', () => {
    // `/admin/users` and `/admin/settings` are siblings under a common `/admin`.
    // Nothing claims the bare `/admin` today, but the rule is what keeps the
    // siblings correct the day something does.
    expect(resolveActiveDestination('/admin/settings')).toBe('system');
    expect(resolveActiveDestination('/admin/users')).toBe('users');
    expect(resolveActiveDestination('/admin')).toBeNull();
  });

  it('resolves a project-scoped run list to Projects, not to Runs', () => {
    // The nested route the longest-prefix rule now earns its keep on twice
    // over: Runs owns `/runs` and nothing else, so `/projects/:id/runs` stays
    // with the destination the operator navigated FROM.
    expect(resolveActiveDestination('/projects/opifex/runs')).toBe('projects');
  });
});

describe('destinations — reachability regression', () => {
  /**
   * The redesign added four destinations and renamed `home` to `dashboard`.
   * Neither may cost an existing page its way in — a rename that quietly
   * orphans `/settings` is precisely the kind of regression the whole
   * single-source-of-truth exercise is supposed to make impossible.
   */
  const PRE_REDESIGN_PATHS = [
    '/',
    '/settings',
    '/admin/users',
    '/admin/settings',
  ];

  it('still resolves every path that existed before the redesign', () => {
    for (const path of PRE_REDESIGN_PATHS) {
      expect(
        resolveActiveDestination(path),
        `${path} became unreachable`,
      ).not.toBeNull();
    }
  });

  it('still offers every pre-redesign path as a destination', () => {
    // A subset assertion, NOT set equality: the old version of this test
    // asserted the destination paths were EXACTLY the old four, which made
    // adding a destination a test failure rather than a feature.
    const paths = DESTINATIONS.map((destination) => destination.path);
    for (const path of PRE_REDESIGN_PATHS) {
      expect(paths, `${path} is no longer a destination`).toContain(path);
    }
  });
});

describe('destinations — the table itself', () => {
  /**
   * The permissions the API REALLY enforces on a navigable page, verified
   * against the controllers rather than assumed:
   *   users.controller.ts           → PERMISSIONS.USERS_READ
   *   system-settings.controller.ts → PERMISSIONS.SYSTEM_SETTINGS_READ
   *   cockpit/queue.controller.ts   → PERMISSIONS.WORKORDERS_READ   (#80)
   *   cockpit/runs.controller.ts    → PERMISSIONS.RUNS_READ         (#80)
   *   cockpit/cost.controller.ts    → PERMISSIONS.RUNS_READ         (#80)
   *   repositories.controller.ts    → PERMISSIONS.PROJECTS_READ     (#43)
   *   approvals.controller.ts       → PERMISSIONS.APPROVALS_READ    (#98)
   *   trust/trust.controller.ts     → PERMISSIONS.TRUST_READ        (#101)
   *   promotion/promotion.controller.ts → PERMISSIONS.TRUST_READ    (#101)
   * Nothing else in `apps/api` guards a page this app routes to.
   */
  const ENFORCED_PERMISSIONS = [
    'users:read',
    'system_settings:read',
    'workorders:read',
    'runs:read',
    'projects:read',
    'approvals:read',
    'trust:read',
  ];

  it('gates the admin destinations on the permission the API enforces', () => {
    expect(byKey.users.permission).toBe('users:read');
    expect(byKey.system.permission).toBe('system_settings:read');
  });

  it('leaves the account destination open to any authenticated user', () => {
    expect(byKey.settings.permission).toBeUndefined();
    expect(byKey.dashboard.permission).toBeUndefined();
  });

  it('only ever requires a permission the API actually enforces', () => {
    // The doctrine in the file header, as an executable rule. An invented
    // permission string would not merely be untidy: no role grants it, so the
    // destination would be invisible to EVERY user including an admin, and the
    // page would be reachable only by typing its URL.
    for (const destination of DESTINATIONS) {
      if (!destination.permission) continue;
      expect(
        ENFORCED_PERMISSIONS,
        `${destination.key} requires ${destination.permission}, which no controller enforces`,
      ).toContain(destination.permission);
    }
  });

  it('gates trust on the READ permission, not the revoking one', () => {
    // #101. `TrustController` and `PromotionController` both enforce
    // `trust:read` on every read, and all three seeded roles hold it. Gating
    // the DESTINATION on `trust:revoke` instead would hide from a viewer the
    // one screen that says what the factory may currently do unattended — a
    // destination gate is about REACHABILITY, and the revoke and demote
    // controls gate themselves inside the page.
    expect(byKey.trust.permission).toBe('trust:read');
    expect(byKey.trust.status).toBe('live');
  });

  it('gates approvals on the READ permission, not the decide one', () => {
    // #98. `ApprovalsController` enforces `approvals:read` on both the queue
    // and the detail screen, and all three seeded roles hold it. Gating the
    // DESTINATION on `approvals:decide` instead would hide the queue from a
    // viewer who is entitled to read it — a destination gate is about
    // REACHABILITY, and the buttons inside the page gate themselves.
    expect(byKey.approvals.permission).toBe('approvals:read');
    expect(byKey.approvals.status).toBe('live');
  });

  it('gates the queue on the permission its controller enforces', () => {
    // #80. `workorders:read` is the string `QueueController` really requires,
    // and it is granted to all three seeded roles including `viewer` — so the
    // destination narrows to nobody it should not.
    expect(byKey.queue.permission).toBe('workorders:read');
  });

  it('gates runs on the permission its controller enforces', () => {
    expect(byKey.runs.permission).toBe('runs:read');
  });

  it('gates cost on the permission its controller enforces', () => {
    // `runs:read`, not `projects:read`: cost lives on the run, and gating an
    // aggregate more loosely than its rows would let somebody total up runs
    // they cannot open.
    expect(byKey.cost.permission).toBe('runs:read');
  });

  it('gates projects on the permission the REPOSITORIES controller enforces', () => {
    // #80 flipped this without writing a new endpoint. `GET /api/repositories`
    // (#43) has been gated on `projects:read` since Phase 1; what was missing
    // was the flip, not a controller.
    expect(byKey.projects.permission).toBe('projects:read');
  });

  it('gives every PLANNED destination no permission at all', () => {
    // The rule survives having nothing left to apply it to: a destination
    // added tomorrow must not carry a permission before its endpoint does.
    // Kept rather than deleted for exactly that reason.
    for (const destination of DESTINATIONS) {
      if (destination.status !== 'planned') continue;
      expect(
        destination.permission,
        `${destination.key} is planned but declares a permission no controller enforces`,
      ).toBeUndefined();
    }
  });

  it('marks exactly the destinations with a real API as live', () => {
    // `queue`, `runs`, `cost` and `projects` all joined across #80, each in
    // the same pull request as the endpoint that backs it. That simultaneity
    // is the rule this file's header sets, and this list is what makes
    // breaking it fail rather than merely be noticed in review.
    const live = DESTINATIONS.filter((d) => d.status === 'live').map(
      (d) => d.key,
    );
    expect(live.sort()).toEqual([
      // #98, in the same pull request as `ApprovalsController`.
      'approvals',
      'cost',
      'dashboard',
      'projects',
      'queue',
      'runs',
      'settings',
      'system',
      // #101, in the same pull request as `TrustController` and
      // `PromotionController`.
      'trust',
      'users',
    ]);
  });

  it('has no planned destinations left', () => {
    // Every destination in the table is now backed by a real endpoint. This
    // asserts the END of #80's flips rather than deleting the check — a new
    // planned destination should show up here as a failure to be re-stated,
    // not slip in unnoticed.
    const planned = DESTINATIONS.filter((d) => d.status === 'planned').map(
      (d) => d.key,
    );
    expect(planned).toEqual([]);
  });

  it('puts every destination in a declared section', () => {
    const sectionKeys = SECTIONS.map((section) => section.key);
    for (const destination of DESTINATIONS) {
      expect(
        sectionKeys,
        `${destination.key} has an unknown section`,
      ).toContain(destination.section);
    }
  });

  it('gives every declared section at least one destination', () => {
    // An empty section is a header with nothing under it. The rail drops those
    // at render time, but a permanently empty one is dead config and should be
    // deleted rather than tolerated.
    for (const section of SECTIONS) {
      expect(
        DESTINATIONS.some((destination) => destination.section === section.key),
        `section ${section.key} has no destinations`,
      ).toBe(true);
    }
  });

  it('declares Icon as a component, never as a rendered element', () => {
    // Surfaces draw the icon at different sizes — the rail at `small` when
    // collapsed and `medium` when expanded — so a pre-rendered element here
    // would bake one size into every surface that consumes the table.
    for (const destination of DESTINATIONS) {
      expect(
        isValidElement(destination.Icon),
        `${destination.key} Icon must be a component, not a rendered element`,
      ).toBe(false);
      expect(destination.Icon).toBeTruthy();
    }
  });

  it('gives every destination a compactLabel short enough for a 56px rail', () => {
    for (const destination of DESTINATIONS) {
      expect(
        destination.compactLabel.length,
        `${destination.key} compactLabel`,
      ).toBeLessThanOrEqual(8);
    }
  });

  it('gives every destination a unique key and a unique path', () => {
    expect(new Set(DESTINATIONS.map((d) => d.key)).size).toBe(
      DESTINATIONS.length,
    );
    expect(new Set(DESTINATIONS.map((d) => d.path)).size).toBe(
      DESTINATIONS.length,
    );
  });
});

describe('destinations — the bottom-bar split', () => {
  const seeEverything = () => true;
  const seeNoAdmin = (destination: Destination) => !destination.permission;

  it('leaves room for the More action inside the four-action ceiling', () => {
    // The ceiling exists so `showLabels` stays valid at 360px. This is the
    // assertion that fires if someone adds a fourth primary key without
    // reading why there are three.
    expect(BOTTOM_NAV_KEYS.length + 1).toBeLessThanOrEqual(
      BOTTOM_NAV_MAX_ACTIONS,
    );
  });

  it('promotes the configured keys, in bar order', () => {
    const { primary } = bottomNavSplit(seeEverything);
    expect(primary.map((d) => d.key)).toEqual([...BOTTOM_NAV_KEYS]);
  });

  it('never returns more primaries than the bar can draw alongside More', () => {
    for (const canSee of [seeEverything, seeNoAdmin, () => false]) {
      const { primary } = bottomNavSplit(canSee);
      expect(primary.length).toBeLessThanOrEqual(BOTTOM_NAV_MAX_ACTIONS - 1);
    }
  });

  it('loses no visible destination between the two halves', () => {
    // REACHABILITY is the invariant. The bar may be wrong about which three
    // destinations matter most; it may never make one unreachable.
    for (const canSee of [seeEverything, seeNoAdmin]) {
      const { primary, overflow } = bottomNavSplit(canSee);
      const split = [...primary, ...overflow].map((d) => d.key).sort();
      const visible = DESTINATIONS.filter(canSee)
        .map((d) => d.key)
        .sort();
      expect(split).toEqual(visible);
    }
  });

  it('puts a destination in exactly one half', () => {
    const { primary, overflow } = bottomNavSplit(seeEverything);
    const overflowKeys = new Set(overflow.map((d) => d.key));
    for (const destination of primary) {
      expect(overflowKeys.has(destination.key)).toBe(false);
    }
  });

  it('drops a primary the user cannot see rather than leaving a hole', () => {
    // A user who can see everything EXCEPT `runs`. Written as an explicit key
    // exclusion rather than `!d.permission`, which is what it used to be: once
    // #80 gave `queue` a real permission that predicate started excluding it
    // too, and the test would have gone on passing while exercising a
    // one-primary case instead of the drop-one case it is named for.
    const { primary } = bottomNavSplit((d) => d.key !== 'runs');
    expect(primary.map((d) => d.key)).toEqual(['dashboard', 'queue']);
  });

  it('drops a primary the user lacks the permission for', () => {
    // The permission path specifically, now that a primary destination has
    // one: a viewer without `workorders:read` loses the Queue tab and the bar
    // closes up rather than rendering a gap.
    const { primary } = bottomNavSplit(
      (d) => d.permission !== 'workorders:read',
    );
    expect(primary.map((d) => d.key)).toEqual(['dashboard', 'runs']);
  });

  it('keeps the overflow in table order, not in permission order', () => {
    const { overflow } = bottomNavSplit(seeEverything);
    expect(overflow.map((d) => d.key)).toEqual([
      // Approvals is NOT one of the three bottom-bar tabs: the notification
      // deep-links to the approval itself, so the bar is not how a phone
      // reaches it. It sits in the sheet, in table order.
      'approvals',
      'trust',
      'projects',
      'cost',
      'settings',
      'users',
      'system',
    ]);
  });

  it('returns an empty overflow when nothing is left over', () => {
    // The state that makes `BottomNav` hide More entirely: a trigger that opens
    // an empty sheet is a control that does nothing.
    const { primary, overflow } = bottomNavSplit((d) =>
      BOTTOM_NAV_KEYS.includes(d.key),
    );
    expect(primary).toHaveLength(BOTTOM_NAV_KEYS.length);
    expect(overflow).toEqual([]);
  });

  it('returns both halves empty for a user who can see nothing', () => {
    const { primary, overflow } = bottomNavSplit(() => false);
    expect(primary).toEqual([]);
    expect(overflow).toEqual([]);
  });
});
