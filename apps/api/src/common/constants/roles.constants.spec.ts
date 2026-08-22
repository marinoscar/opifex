import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PERMISSIONS, ROLES, DEFAULT_ROLE } from './roles.constants';

/**
 * The registry and the seed are two copies of one list, and nothing but a
 * test keeps them in step. A permission that exists in `PERMISSIONS` but was
 * never seeded fails CLOSED at runtime — no role holds it, so every endpoint
 * guarding on it returns 403 for everyone, including the admin. That is a
 * production-only failure with no compile-time signal at all, which is
 * exactly the kind this file exists to catch.
 *
 * `prisma/seed.ts` is read as TEXT rather than imported: it calls `main()` at
 * module scope, so importing it would try to connect to a database. Parsing
 * the source is the same approach `apps/web/src/__tests__/config/
 * destinations.test.ts` takes against the live `App.tsx`, for the same
 * reason — the guarantee is only worth having if it is checked against the
 * real file rather than a copy of it.
 */
const rawSeedSource = readFileSync(
  join(__dirname, '..', '..', '..', 'prisma', 'seed.ts'),
  'utf8',
);

/**
 * Whole-line `//` comments removed before parsing.
 *
 * The seed's own comments quote permission strings — "no 'projects:write'" —
 * and a parser that reads them treats a note about what a role must NOT have
 * as a grant. Only full-line comments are stripped, so a `//` inside a string
 * literal (a URL, say) is left alone.
 */
const seedSource = rawSeedSource
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('//'))
  .join('\n');

/** Every `{ name: 'x', description: … }` entry in the seed's PERMISSIONS array. */
function seededPermissionNames(): string[] {
  const block = seedSource.match(/const PERMISSIONS = \[([\s\S]*?)\n\] as const;/);
  expect(block).not.toBeNull();
  return [...block![1].matchAll(/\{\s*name:\s*'([^']+)'/g)].map((m) => m[1]);
}

/** The seed's ROLE_PERMISSIONS map, as role name -> permission strings. */
function seededRolePermissions(): Record<string, string[]> {
  const block = seedSource.match(
    /const ROLE_PERMISSIONS: Record<string, string\[\]> = \{([\s\S]*?)\n\};/,
  );
  expect(block).not.toBeNull();

  const result: Record<string, string[]> = {};
  for (const role of [...block![1].matchAll(/^ {2}(\w+): \[([\s\S]*?)^ {2}\],$/gm)]) {
    result[role[1]] = [...role[2].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  }
  return result;
}

describe('roles.constants', () => {
  const permissionValues = Object.values(PERMISSIONS);

  it('has no duplicate permission strings', () => {
    expect(new Set(permissionValues).size).toBe(permissionValues.length);
  });

  it('names every permission as `resource:action`', () => {
    for (const permission of permissionValues) {
      expect(permission).toMatch(/^[a-z_]+:[a-z_]+$/);
    }
  });

  it('makes the least-privileged role the default', () => {
    expect(DEFAULT_ROLE).toBe(ROLES.VIEWER);
  });

  describe('against prisma/seed.ts', () => {
    it('seeds every permission in the registry', () => {
      const seeded = seededPermissionNames();
      const missing = permissionValues.filter((p) => !seeded.includes(p));

      // Named rather than counted: the failure message has to say WHICH
      // permission would 403 for everyone.
      expect(missing).toEqual([]);
    });

    it('seeds nothing the registry does not define', () => {
      const unknown = seededPermissionNames().filter(
        (p) => !permissionValues.includes(p as never),
      );

      expect(unknown).toEqual([]);
    });

    it('grants only known permissions to each role', () => {
      const seeded = seededPermissionNames();

      for (const [role, granted] of Object.entries(seededRolePermissions())) {
        expect(granted.filter((p) => !seeded.includes(p))).toEqual([]);
        expect(role).not.toHaveLength(0);
      }
    });

    it('seeds a mapping for exactly the three roles', () => {
      expect(Object.keys(seededRolePermissions()).sort()).toEqual(
        [ROLES.ADMIN, ROLES.CONTRIBUTOR, ROLES.VIEWER].sort(),
      );
    });

    it('grants the admin role every permission', () => {
      // The admin is the operator (VISION §11). A permission it does not hold
      // is one nobody can exercise, which is the same failure as not seeding
      // it at all — just harder to spot.
      const admin = seededRolePermissions()[ROLES.ADMIN];

      expect(permissionValues.filter((p) => !admin.includes(p))).toEqual([]);
    });

    it('keeps the viewer role read-only across the Opifex domain', () => {
      const viewer = seededRolePermissions()[ROLES.VIEWER];
      const domainWrites = [
        PERMISSIONS.PROJECTS_WRITE,
        PERMISSIONS.RUNS_CANCEL,
        PERMISSIONS.RUNS_WRITE,
        PERMISSIONS.WORKORDERS_WRITE,
        PERMISSIONS.RUNNERS_MANAGE,
        // Acknowledging is a claim that someone will act on the escalation,
        // which is why it is not a read.
        PERMISSIONS.ESCALATIONS_ACKNOWLEDGE,
      ];

      expect(domainWrites.filter((p) => viewer.includes(p))).toEqual([]);
    });

    it('withholds configuration of the factory from the contributor role', () => {
      const contributor = seededRolePermissions()[ROLES.CONTRIBUTOR];

      // Registering a repository decides what Opifex may touch, and a runner
      // registration decides what it hands repositories to. Both are admin
      // decisions even though a contributor may act on runs.
      expect(contributor).not.toContain(PERMISSIONS.PROJECTS_WRITE);
      expect(contributor).not.toContain(PERMISSIONS.RUNNERS_MANAGE);
      expect(contributor).toContain(PERMISSIONS.RUNS_CANCEL);
    });
  });
});
