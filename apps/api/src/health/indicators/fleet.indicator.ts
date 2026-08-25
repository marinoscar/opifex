import { Injectable } from '@nestjs/common';
import {
  HealthCheckError,
  HealthIndicator,
  HealthIndicatorResult,
} from '@nestjs/terminus';

import {
  FleetStateService,
  hasEmptyFleet,
  type FleetReport,
} from '../../runners/fleet-state.service';

/**
 * Puts fleet state on the health endpoints (#277) — twice, with two
 * strictnesses, following `SeedIntegrityIndicator` (#173) rather than
 * inventing a second shape.
 *
 * ## Why an empty fleet does not make the API unready
 *
 * The reasoning transfers from #173 unchanged, and the transfer is the reason
 * this is not a new pattern. `/api/health/ready` is the probe orchestration
 * consumes; failing it does not register a runner, it takes the API out of
 * service. Under `prod.compose.yml`'s `restart: unless-stopped` that is a
 * crash-loop, and behind nginx it is bare 502s in which nothing — including
 * this diagnosis — can be read.
 *
 * The condition is far narrower than that response. An API with an empty fleet
 * serves login, the cockpit, the whole ungated surface and the health
 * endpoints correctly; what it cannot do is dispatch. And the container that
 * would be taken down is the one running the registration loop that is trying
 * to fix it, and the one an operator reads `RunnerRegistrationService`'s log
 * from. A readiness failure would remove the diagnosis and the remedy at once.
 *
 * So readiness REPORTS and stays up. That is already a change from the status
 * quo, where `/api/health/ready` answered `{"status":"ok"}` while dispatch was
 * structurally incapable of routing anything, and "how many runners are
 * registered" could only be answered with a database client.
 *
 * ## Why the full check does fail
 *
 * `GET /api/health` is the comprehensive check — not wired to any orchestrator
 * in this repo, consulted by operators and monitors — and an empty fleet there
 * is an error rather than a note. Registration is UNCONDITIONAL (see
 * `RunnersModule`): every build ships a runner and registers it whatever the
 * enable flags say, so a deployment with no routable runner is a deployment
 * whose code and database disagree, exactly like seed drift. `curl -sf
 * .../api/health` exiting non-zero gives a redeploy a verify step that fails
 * rather than one that has to be read.
 *
 * Note this is NOT gated on `DISPATCH_ENABLED`, and the escalation in
 * `FleetStateService` is. The two ask different questions: the escalation asks
 * whether work is being lost right now, which needs dispatch on; this asks
 * whether the deployment is correct, which does not.
 *
 * ## A disabled runner is healthy here, and that is deliberate
 *
 * `enabled: false` is an operator's own decision and its row is present, so
 * the fleet is not empty and nothing goes red. Failing a health check because
 * somebody switched a runner off would be reporting a human's choice back at
 * them as a fault — the fastest way to teach them the check is noise. The
 * count is in the payload either way, which is where a deliberate choice
 * belongs: visible, not alarming.
 */
@Injectable()
export class FleetIndicator extends HealthIndicator {
  constructor(private readonly fleet: FleetStateService) {
    super();
  }

  /** Readiness flavour: never fails, always carries the finding. */
  async report(key: string): Promise<HealthIndicatorResult> {
    return this.getStatus(key, true, describe(await this.fleet.check()));
  }

  /**
   * Full-check flavour: fails when routing has nothing to route to.
   *
   * An unreadable fleet table is NOT failed here, for the reason
   * `SeedIntegrityIndicator` gives: the database indicator running beside this
   * one has already failed the same check for the same outage, and two red
   * entries for one fault make the second look like a second problem.
   */
  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const report = await this.fleet.check();
    const data = describe(report);

    if (hasEmptyFleet(report)) {
      throw new HealthCheckError(
        'Fleet check failed',
        this.getStatus(key, false, data),
      );
    }

    return this.getStatus(key, true, data);
  }
}

/**
 * The finding, as the health payload states it.
 *
 * Every runner is named rather than counted. The list is bounded by the fleet
 * this build ships — one, today — and the four facts that decide whether a
 * runner can take work (registered, enabled, available, routable) are exactly
 * the four an operator would otherwise open a database client to read. They
 * are not a disclosure: the same manifest is already published to every
 * authenticated caller through dispatch's recorded reasons.
 */
function describe(report: FleetReport): Record<string, unknown> {
  if (!report.checked) {
    return {
      checked: false,
      message: `Could not read the fleet: ${report.error}`,
    };
  }

  const data: Record<string, unknown> = {
    checked: true,
    registered: report.registered,
    routable: report.routable,
    enabled: report.enabled,
    dispatchable: report.dispatchable,
    checkedAt: report.checkedAt.toISOString(),
    runners: report.runners.map((runner) => ({
      key: runner.key,
      version: runner.version,
      enabled: runner.enabled,
      available: runner.available,
      // Only when there is one to give. A null next to every healthy runner is
      // noise in the one payload that is read while something is wrong.
      ...(runner.unavailableReason
        ? { unavailableReason: runner.unavailableReason }
        : {}),
      maxConcurrency: runner.maxConcurrency,
    })),
  };

  if (report.unroutable.length > 0) {
    // Registered and invisible to routing at the same time — the confusing
    // failure `DispatchService.loadPool` drops with a warning nobody reads.
    data.unroutable = report.unroutable;
  }

  if (hasEmptyFleet(report)) {
    data.message =
      report.registered === 0
        ? 'No runner is registered, so every work order queues behind "No ' +
          'runners are registered." Check the API log for ' +
          'RunnerRegistrationService, which names the runner it could not ' +
          'register and why.'
        : `${report.registered} runner row(s) exist but none carries a ` +
          'capability manifest, so routing cannot see any of them. Check the ' +
          'API log for RunnerRegistrationService.';
  } else if (report.enabled === 0) {
    // Reported, never failed: this is somebody's decision, not a fault.
    data.message =
      `All ${report.routable} registered runner(s) are disabled. Nothing will ` +
      'be dispatched until one is switched on — this is a configuration ' +
      'choice, not a failure.';
  } else if (report.dispatchable === 0) {
    data.message =
      `All ${report.enabled} enabled runner(s) report they cannot take work ` +
      'right now. Each one gives its own reason above.';
  }

  return data;
}
