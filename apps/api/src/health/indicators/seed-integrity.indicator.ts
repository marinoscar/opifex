import { Injectable } from '@nestjs/common';
import {
  HealthCheckError,
  HealthIndicator,
  HealthIndicatorResult,
} from '@nestjs/terminus';

import {
  hasSeedDrift,
  SeedIntegrityService,
  type SeedIntegrityReport,
} from '../seed-integrity.service';

/**
 * Puts the permission-set check (#173) on the health endpoints — twice, with
 * two different strictnesses, on purpose.
 *
 * ## Why seed drift does not make the API unready
 *
 * `/api/health/ready` is the probe orchestration consumes. Failing it does not
 * fix a partially-seeded database; it takes the API out of service — under
 * `prod.compose.yml`'s `restart: unless-stopped` it produces a crash-loop, and
 * behind nginx it produces bare 502s in which nothing, including this
 * diagnosis, can be read. The condition itself is far narrower than that
 * response: an API with a missing permission serves login, the whole
 * ungated surface, and the health endpoints correctly. It answers 403 on the
 * endpoints gated by what is missing.
 *
 * Worse, the remedy runs inside the container that would have been taken down:
 * `docker compose exec api npm run prisma:seed`. A readiness failure would
 * make the fix harder while making nothing safer.
 *
 * So readiness REPORTS it and stays up — `report()` below. That is not the
 * status quo, where readiness said `ok` and the payload said nothing at all:
 * the drift is now in the body of every probe, named, for anything that cares
 * to look.
 *
 * ## Why the full check does fail
 *
 * A warning nothing can act on is how #173 happened. `GET /api/health` is the
 * comprehensive check — not wired to any orchestrator in this repo, consulted
 * by operators and monitors — and there a structural mismatch between the
 * running code and its database is an error: `isHealthy()` throws, the
 * endpoint answers 503, and `curl -sf .../api/health` exits non-zero. That
 * gives the redeploy runbook a verify step that FAILS instead of one that has
 * to be read.
 *
 * One fact, two audiences: the probe that decides whether to route traffic is
 * told the API can serve, and the check that decides whether the deployment is
 * correct is told that it is not.
 */
@Injectable()
export class SeedIntegrityIndicator extends HealthIndicator {
  constructor(private readonly seedIntegrity: SeedIntegrityService) {
    super();
  }

  /**
   * Readiness flavour: never fails, always carries the finding.
   */
  async report(key: string): Promise<HealthIndicatorResult> {
    const report = await this.seedIntegrity.check();

    return this.getStatus(key, true, describe(report));
  }

  /**
   * Full-check flavour: fails when a permission this build enforces has no row
   * behind it.
   *
   * An unreadable table is NOT failed here. The database indicator running
   * beside this one has already failed the same check for the same reason, and
   * two red entries for one outage make the second look like a second problem.
   */
  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const report = await this.seedIntegrity.check();
    const data = describe(report);

    if (hasSeedDrift(report)) {
      throw new HealthCheckError(
        'Seed check failed',
        this.getStatus(key, false, data),
      );
    }

    return this.getStatus(key, true, data);
  }
}

/**
 * The finding, as the health payload states it.
 *
 * Missing names are listed in full rather than counted: the list is bounded by
 * `PERMISSIONS` at compile time, and a count would send the reader to a
 * database shell to learn the one thing they need in order to act. The names
 * are not a disclosure — they are already published in the `x-rbac` extension
 * of the OpenAPI document.
 */
function describe(report: SeedIntegrityReport): Record<string, unknown> {
  if (!report.checked) {
    return {
      checked: false,
      message: `Could not read the permissions table: ${report.error}`,
    };
  }

  const data: Record<string, unknown> = {
    checked: true,
    expected: report.expected,
    missing: report.missing.length,
    checkedAt: report.checkedAt.toISOString(),
  };

  if (report.missing.length > 0) {
    data.missingPermissions = report.missing;
    data.message =
      `${report.missing.length} of ${report.expected} permissions are missing ` +
      'from the database, so every endpoint gated on them returns 403 to ' +
      'every user. Run `npm run prisma:seed` (idempotent).';
  }

  if (report.unexpected.length > 0) {
    // Surfaced, never failed on — see SeedIntegrityService's class comment.
    data.unexpected = report.unexpected.length;
    data.unexpectedPermissions = report.unexpected;
  }

  return data;
}
