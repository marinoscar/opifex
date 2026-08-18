import { describe, it, expect } from 'vitest';
import { isValidElement } from 'react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  DESTINATIONS,
  DESTINATION_ROUTES,
  UNOWNED_ROUTES,
  owns,
  resolveActiveDestination,
} from '../../config/destinations';
import type { DestinationKey } from '../../config/destinations';

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
const APP_TSX = resolve(dirname(fileURLToPath(import.meta.url)), '../../App.tsx');

function declaredRoutePaths(): string[] {
  const source = readFileSync(APP_TSX, 'utf8');
  const paths = [...source.matchAll(/path="([^"]+)"/g)].map((match) => match[1]);
  // `*` is the catch-all, which redirects to `/` rather than rendering a page.
  return [...new Set(paths)].filter((path) => path !== '*');
}

describe('destinations — route ownership', () => {
  it('finds at least the four destination routes plus the public ones in App.tsx', () => {
    // Guards the regex above: if it silently stopped matching, every assertion
    // below would pass vacuously over an empty list.
    const paths = declaredRoutePaths();
    expect(paths).toEqual(expect.arrayContaining(['/', '/settings', '/admin/users', '/admin/settings']));
    expect(paths.length).toBeGreaterThanOrEqual(8);
  });

  it('claims every route in App.tsx exactly once, or deliberately not at all', () => {
    for (const path of declaredRoutePaths()) {
      const owners = (Object.keys(DESTINATION_ROUTES) as DestinationKey[]).filter((key) =>
        DESTINATION_ROUTES[key].some((prefix) => owns(prefix, path)),
      );

      if (UNOWNED_ROUTES.includes(path)) {
        expect(owners, `${path} is listed as unowned but a destination claims it`).toEqual([]);
      } else {
        // NOT `toHaveLength(1)` with a bare message: naming the owners is what
        // makes the failure actionable when it does fire.
        expect(owners, `${path} should be owned by exactly one destination`).toHaveLength(1);
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

  it('highlights NOTHING on the deliberately unowned routes', () => {
    // Asserted explicitly so a later contributor does not "fix" this into
    // highlighting something arbitrary. No destination is better than a wrong
    // one — the login screen does not belong to Home.
    for (const path of UNOWNED_ROUTES) {
      expect(resolveActiveDestination(path), `${path} must activate no destination`).toBeNull();
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

  it('activates Home on / only, never on any other path', () => {
    // Every path starts with '/', so without the exact-match rule Home would
    // own the entire app and beat nothing only by prefix length.
    expect(resolveActiveDestination('/')).toBe('home');
    expect(resolveActiveDestination('/settings')).not.toBe('home');
    expect(resolveActiveDestination('/admin/settings')).not.toBe('home');
    expect(owns('/', '/anything')).toBe(false);
  });

  it('activates a destination for its child routes', () => {
    expect(resolveActiveDestination('/settings/profile')).toBe('settings');
    expect(resolveActiveDestination('/admin/users/abc-123')).toBe('users');
  });

  it('gives the longest matching prefix the win', () => {
    // `/admin/users` and `/admin/settings` are siblings under a common `/admin`.
    // Nothing claims the bare `/admin` today, but the rule is what keeps the
    // siblings correct the day something does.
    expect(resolveActiveDestination('/admin/settings')).toBe('system');
    expect(resolveActiveDestination('/admin/users')).toBe('users');
    expect(resolveActiveDestination('/admin')).toBeNull();
  });
});

describe('destinations — reachability regression', () => {
  /**
   * The design's central claim is that replacing the drawer makes nothing
   * unreachable. These are the four rows the deleted `Sidebar` offered, by the
   * paths it navigated to.
   */
  const OLD_SIDEBAR_PATHS = ['/', '/settings', '/admin/users', '/admin/settings'];

  it('still resolves every path the old Sidebar menu offered', () => {
    for (const path of OLD_SIDEBAR_PATHS) {
      expect(resolveActiveDestination(path), `${path} became unreachable`).not.toBeNull();
    }
  });

  it('still offers every old Sidebar path as a destination', () => {
    expect(DESTINATIONS.map((destination) => destination.path).sort()).toEqual(
      [...OLD_SIDEBAR_PATHS].sort(),
    );
  });
});

describe('destinations — the table itself', () => {
  it('gates the admin destinations on the permission the API enforces', () => {
    // Verified against the controllers, not assumed:
    //   users.controller.ts           → PERMISSIONS.USERS_READ
    //   system-settings.controller.ts → PERMISSIONS.SYSTEM_SETTINGS_READ
    const byKey = Object.fromEntries(DESTINATIONS.map((d) => [d.key, d]));
    expect(byKey.users.permission).toBe('users:read');
    expect(byKey.system.permission).toBe('system_settings:read');
  });

  it('leaves the non-admin destinations open to any authenticated user', () => {
    const byKey = Object.fromEntries(DESTINATIONS.map((d) => [d.key, d]));
    expect(byKey.home.permission).toBeUndefined();
    expect(byKey.settings.permission).toBeUndefined();
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
      expect(destination.compactLabel.length, `${destination.key} compactLabel`).toBeLessThanOrEqual(
        8,
      );
    }
  });

  it('caps the destination set at four — the bottom bar ceiling', () => {
    expect(DESTINATIONS.length).toBeLessThanOrEqual(4);
  });
});
