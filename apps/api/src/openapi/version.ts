import { readFileSync } from 'fs';
import { dirname, join } from 'path';

/**
 * Version stamped into `info.version`.
 *
 * Resolution order, and why:
 *
 *  1. `APP_VERSION` — set by the deploy pipeline on the built image. This is the
 *     only source that knows about a release tag, so it wins.
 *  2. `npm_package_version` — set when the process was started through an npm
 *     script, which covers local `start:dev`.
 *  3. `apps/api/package.json`, found by walking up from this file. `require`ing
 *     it directly is not an option: `resolveJsonModule` is off, and the
 *     relative depth differs between `src/` under ts-jest and `dist/` under
 *     `node dist/main`. Walking up finds it from either.
 *
 * Never throws — a docs page is not worth failing a boot over, so an
 * unresolvable version degrades to `'0.0.0'`.
 */
export function resolveApiVersion(): string {
  if (process.env.APP_VERSION) return process.env.APP_VERSION;
  if (process.env.npm_package_version) return process.env.npm_package_version;

  let dir = __dirname;
  // Bounded walk: deep enough to escape `dist/openapi`, short enough that a
  // stray package.json far up the tree (the monorepo root) is still reachable
  // but a runaway loop is not possible.
  for (let depth = 0; depth < 6; depth += 1) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        version?: unknown;
      };
      if (typeof parsed.version === 'string' && parsed.version.length > 0) {
        return parsed.version;
      }
    } catch {
      // Not this directory — keep walking.
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return '0.0.0';
}
