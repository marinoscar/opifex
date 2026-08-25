import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';

import { PERMISSIONS } from '../common/constants/roles.constants';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Every permission string this build enforces, sorted.
 *
 * Derived from `PERMISSIONS` rather than restated, so a permission added to
 * the constant is covered by this check on the same commit that adds it —
 * which is the whole point: the drift in #173 survived because the only two
 * places that knew the full set (the constant and `prisma/seed.ts`) were both
 * write-only as far as the running system was concerned.
 *
 * Bounded at compile time, which is why the report below can afford to name
 * every missing entry instead of truncating: the list cannot be longer than
 * this constant.
 */
export const EXPECTED_PERMISSIONS: readonly string[] = Object.freeze(
  [...new Set(Object.values(PERMISSIONS))].sort(),
);

/**
 * How long a successful check is reused before the database is asked again.
 *
 * The `permissions` table changes on exactly two occasions — a seed run and a
 * migration — so a minute-old answer is as true as a fresh one in every case
 * except the minute immediately after an operator fixes the drift, where the
 * cost is that they may have to curl twice. Set against that: readiness is
 * probed on a timer for the life of the process, and this check has no right
 * to add a query to each probe forever to detect a condition that changes
 * roughly never.
 */
const CHECK_TTL_MS = 60_000;

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * What the database says about the permission set, as of `checkedAt`.
 *
 * `checked: false` is a third state and deliberately not folded into
 * "everything is missing": a database that cannot be queried is the database
 * indicator's story to tell, and reporting seed drift on top of it would
 * invent a second failure out of one fact — the "synthesized reassurance"
 * failure of #161 with the sign flipped.
 */
export type SeedIntegrityReport =
  | {
      checked: true;
      checkedAt: Date;
      expected: number;
      /** In `PERMISSIONS`, absent from the table. The drift #173 is about. */
      missing: string[];
      /** In the table, absent from `PERMISSIONS`. Reported, never a failure. */
      unexpected: string[];
    }
  | {
      checked: false;
      checkedAt: Date;
      error: string;
    };

export function hasSeedDrift(report: SeedIntegrityReport): boolean {
  return report.checked && report.missing.length > 0;
}

/**
 * Asserts that the deployed database actually carries the permissions this
 * build enforces (#173).
 *
 * ## The condition this exists to catch
 *
 * `PermissionsGuard` compares the strings a controller declares against the
 * ones resolved for the caller, and those come from `role_permissions` joined
 * to `permissions`. A permission row that was never inserted therefore cannot
 * be held by anybody, INCLUDING an admin — so every endpoint gated on it
 * returns 403 to every user, forever, with no error anywhere and a database
 * that is perfectly healthy. That is not a hypothesis: on the dev deployment
 * the ten Opifex-domain permissions had never been seeded, and every cockpit
 * endpoint delivered by #80 had been 403ing for its entire deployed life while
 * `/api/health/ready` answered `{"status":"ok"}` throughout.
 *
 * The cause is that `npm run prisma:seed` is a first-time-setup step: adding a
 * row to `prisma/seed.ts` does not put it on any deployment until somebody
 * remembers to re-run it. `docs/ssl-nginx-setup.md` now says to run it on
 * every redeploy, but a runbook step is a request, not an assertion — this
 * class is the assertion, and it is what makes the next omission detectable
 * without a human first noticing a 403.
 *
 * ## What counts as drift, and what does not
 *
 * MISSING is drift: a string this build enforces with no row behind it is a
 * gate nobody can pass.
 *
 * UNEXPECTED — a row whose name is not in `PERMISSIONS` — is reported and is
 * NOT a failure, for three reasons. It grants nothing: no controller checks a
 * string this build does not contain, so the row is inert. The seed is
 * deliberately non-destructive (all `upsert`, no `deleteMany`), so a
 * permission RETIRED from the constant leaves its row behind by design, and
 * failing on it would turn every removal into a false alarm — and pressure
 * somebody into adding a delete to the seed, which is a much worse thing to
 * own. And when it does mean something, it means the opposite of drift #173:
 * a database seeded by NEWER code than the image that is running, i.e. a
 * rollback or a stale image, which is a different fact deserving a different
 * response. It is worth seeing while diagnosing; it is not worth failing on.
 *
 * ## Why this reports rather than throws
 *
 * `PrismaService` argues at length that an unreachable database must not stop
 * the boot, because a process that has exited cannot be asked what is wrong.
 * The same holds here and more easily: an unseeded database leaves the API
 * able to serve everything that is not gated on a missing permission,
 * including `/api/auth/*` and the health endpoints themselves — and the fix
 * (`prisma:seed`) is run INSIDE this very container. Refusing to boot would
 * remove both the diagnosis and the remedy to punish a condition one command
 * clears.
 */
@Injectable()
export class SeedIntegrityService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SeedIntegrityService.name);

  /**
   * @see CHECK_TTL_MS. An instance field rather than a direct reference to the
   * constant so tests can shorten it without mocking timers, matching the
   * `connectRetryDelaysMs` precedent in `PrismaService`.
   */
  protected checkTtlMs: number = CHECK_TTL_MS;

  private cached: SeedIntegrityReport | null = null;
  private cachedAtMs = 0;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Say it once, at boot, in the log an operator reads right after deploying.
   *
   * `OnApplicationBootstrap` rather than `OnModuleInit` so this runs after
   * `PrismaService` has finished its own bounded connect retry; otherwise a
   * database that is merely slow to accept connections — routine here, since
   * PostgreSQL is an external container Compose cannot order the API behind —
   * would be reported as an unreadable permissions table on every cold start.
   *
   * Never throws: see the class comment.
   */
  async onApplicationBootstrap(): Promise<void> {
    const report = await this.check();

    if (!report.checked) {
      // Deliberately quiet. `PrismaService` has already logged the database
      // being unreachable at `error` level, and readiness reports it every
      // time it is probed. A second alarming line about the same fact, from a
      // service whose subject is something else, sends an operator looking for
      // a second problem that does not exist.
      this.logger.warn(
        `Could not verify the permission set at boot: ${report.error}. ` +
          'It will be checked again on the next /api/health request.',
      );
      return;
    }

    if (report.missing.length > 0) {
      this.logger.error(
        `Seed drift: ${report.missing.length} of ${report.expected} permissions ` +
          `are missing from the database — ${report.missing.join(', ')}. ` +
          'Every endpoint gated on them returns 403 to every user, admins ' +
          'included. Fix with `npm run prisma:seed` (idempotent). ' +
          'GET /api/health reports this as a failure until it is cleared.',
      );
    }

    if (report.unexpected.length > 0) {
      // `log`, not `warn`: this is inert (see the class comment) and its usual
      // cause is a permission retired from the code, which is not a problem.
      // It earns a line only because it is evidence when the drift runs the
      // other way — a database ahead of the image it is serving.
      this.logger.log(
        `The permissions table holds ${report.unexpected.length} name(s) this ` +
          `build does not use — ${report.unexpected.join(', ')}. Harmless: ` +
          'nothing checks them. Expected after a permission is retired, and ' +
          'worth a look if you did not retire one.',
      );
    }

    if (report.missing.length === 0) {
      this.logger.log(
        `Permission set verified: all ${report.expected} permissions present`,
      );
    }
  }

  /**
   * The current report, from cache when it is fresh.
   *
   * Only successful checks are cached. A failed one is not worth remembering
   * for a minute — the database it failed against may be back a second later,
   * and the caller (readiness, or the full health check) is asking precisely
   * because it wants to know about now.
   */
  async check(): Promise<SeedIntegrityReport> {
    if (
      this.cached !== null &&
      Date.now() - this.cachedAtMs < this.checkTtlMs
    ) {
      return this.cached;
    }

    const report = await this.run();

    if (report.checked) {
      this.cached = report;
      this.cachedAtMs = Date.now();
    }

    return report;
  }

  private async run(): Promise<SeedIntegrityReport> {
    let names: string[];

    try {
      // One column, one small table — the row count is bounded by
      // EXPECTED_PERMISSIONS plus whatever has been retired, so this is a
      // sequential scan of a few dozen rows, once a minute at most.
      const rows = await this.prisma.permission.findMany({
        select: { name: true },
      });
      names = rows.map((row) => row.name);
    } catch (error) {
      return {
        checked: false,
        checkedAt: new Date(),
        error: asMessage(error),
      };
    }

    const present = new Set(names);
    const expected = new Set(EXPECTED_PERMISSIONS);

    return {
      checked: true,
      checkedAt: new Date(),
      expected: EXPECTED_PERMISSIONS.length,
      missing: EXPECTED_PERMISSIONS.filter((name) => !present.has(name)),
      unexpected: [...present].filter((name) => !expected.has(name)).sort(),
    };
  }
}
