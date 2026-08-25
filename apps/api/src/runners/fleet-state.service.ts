import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { isAvailable } from '../dispatch/dispatch-policy';
import { toCapabilities } from '../dispatch/dispatch.service';
import { EscalationsService } from '../escalations/escalations.service';
import { PrismaService } from '../prisma/prisma.service';
import { REGISTRATION_INTERVAL_MS } from './runner-registration.service';

/**
 * How many consecutive registration ticks may see an empty fleet before a
 * human is told. Five, and since the tick is {@link REGISTRATION_INTERVAL_MS}
 * that is five minutes.
 *
 * ## The lower bound is convergence, not zero
 *
 * Registration retries every 60s (#162), so a transient failure clears on the
 * FIRST tick after its cause does. Both observed causes are short: a database
 * that was briefly away — PostgreSQL is an external container Compose cannot
 * order the API behind, so `compose up` races it routinely — and a
 * `capabilities()` probe that lost a race on a busy machine. One to two ticks
 * covers them.
 *
 * So 2 is wrong for a mechanical reason rather than a cautious one: it fires
 * during an ordinary `docker compose up`, which would make the first thing a
 * new deployment does be page its operator about a fleet that registered
 * thirty seconds later. Five leaves three to four ticks of margin on top of
 * the one or two convergence actually takes.
 *
 * ## The upper bound is dead time, which is the thing being paid for
 *
 * VISION §1 opens with four hours dead. Thirty ticks is half an hour of a
 * factory structurally unable to do any work, which is that failure with a
 * smaller number on it — and half an hour is long enough that an operator who
 * kicked off a deploy has moved on to something else before being told it
 * failed.
 *
 * ## Why err short rather than long
 *
 * The costs are asymmetric. Escalating early costs exactly ONE notification —
 * the raise is deduplicated, and it resolves itself the moment the fleet
 * converges — about a condition that was real when it was observed. Escalating
 * late costs unbounded dead time, and dead time is what this system exists to
 * remove. When the two bounds are that lopsided the number belongs near the
 * short end of the acceptable range.
 *
 * ## Why not ten, to match TRANSIENT_REPEAT_EVERY
 *
 * That constant governs how often the same line is repeated to somebody who is
 * ALREADY READING THE LOG. This one governs how long before somebody who is
 * not reading it is told at all. Landing at tick five — between registration's
 * first error at tick one and its first repeat at tick ten — is deliberate:
 * the escalation should be the first loud signal about an empty fleet, not a
 * confirmation of one the log has already given up on.
 */
export const EMPTY_FLEET_TICKS_BEFORE_ESCALATION = 5;

/**
 * How many ticks past the threshold pass before the log says it again, on the
 * one path where the log is the only channel there is.
 *
 * Ten, matching `TRANSIENT_REPEAT_EVERY` in `runner-registration.service.ts`
 * and for its reasons: never repeating is #162 itself — one line, scrolled
 * past, and a fleet that is empty and silent about it forever — while
 * repeating every tick teaches an operator that this log is noise.
 *
 * It applies ONLY when `DISPATCH_ENABLED` is off. With dispatch on there is an
 * escalation carrying the fact, and `raiseSystemOnce` already deduplicates it,
 * so nothing needs to repeat here at all.
 */
const EMPTY_FLEET_REPEAT_EVERY = 10;

/**
 * The escalation's summary line, which is ALSO its deduplication key.
 *
 * Fixed text, with every varying fact kept in the detail body, because
 * `EscalationsService.raiseSystemOnce` dedupes on this string: a summary that
 * carried a tick count would be a different string every tick and would
 * deduplicate against nothing, which is #57's twelve-pages-per-stall failure.
 */
export const EMPTY_FLEET_SUMMARY =
  'No runner is registered: the factory cannot dispatch anything';

/** One runner, as both routing and an operator need to see it. */
export interface FleetRunnerState {
  key: string;
  displayName: string;
  version: string;
  /**
   * False for a runner an operator switched off.
   *
   * Its row still exists, which is the whole point: `enabled: false` is a
   * decision somebody made and is reported, never escalated.
   */
  enabled: boolean;
  /** False when the runner itself reported it cannot take work now (#253). */
  available: boolean;
  unavailableReason: string | null;
  maxConcurrency: number;
}

/**
 * What the database says about the fleet, as of `checkedAt`.
 *
 * `checked: false` is a third state and deliberately not folded into "the
 * fleet is empty", for the reason `SeedIntegrityReport` gives for the same
 * shape: a database that cannot be queried is the database indicator's story,
 * and reporting an empty fleet on top of it would invent a second failure out
 * of one fact.
 *
 * That is not merely tidy here, it is load-bearing. #162's failure IS a
 * database that is away, so an unreadable database and an empty fleet are
 * usually the same outage seen twice — and the escalation could not be written
 * anyway, since writing it needs the database that is down.
 */
export type FleetReport =
  | {
      checked: true;
      checkedAt: Date;
      /** Rows in `runners`, in whatever state. */
      registered: number;
      /**
       * Of those, the ones routing can actually see.
       *
       * A runner row whose capability manifest never got written is dropped by
       * `DispatchService.loadPool` with a warning, so it is registered and
       * invisible at the same time. THIS is the number the alarm reads: an
       * empty pool is an empty pool whichever way it got that way.
       */
      routable: number;
      /** Of the routable ones, switched on. */
      enabled: number;
      /** Of the enabled ones, reporting they can take work right now. */
      dispatchable: number;
      /** Keys registered with no capability manifest. */
      unroutable: string[];
      runners: FleetRunnerState[];
    }
  | {
      checked: false;
      checkedAt: Date;
      error: string;
    };

/**
 * Whether routing has nothing at all to route to.
 *
 * Deliberately NOT "every runner is disabled". Those two states share one
 * `QueueReason` today (`no-runners-registered`, separated only by the prose of
 * the reason sentence), and collapsing them here would escalate an operator's
 * own decision back at them — which is how an alarm gets ignored. Reading
 * cardinality straight off the fleet keeps them apart structurally, with no
 * sentence to parse: a disabled runner has a row, so the fleet is not empty,
 * so nothing fires.
 */
export function hasEmptyFleet(report: FleetReport): boolean {
  return report.checked && report.routable === 0;
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Answers "is there a fleet at all", to an operator and to an escalation
 * (#277).
 *
 * ## The condition this exists to catch
 *
 * An empty fleet with dispatch enabled is a factory that cannot work, and its
 * only symptom today is work orders queueing — which is visually identical to
 * an idle factory with nothing to do. #162 made registration converge, so the
 * failure is no longer permanent; what is left is that while it lasts it is
 * invisible, and the causes that do NOT converge on their own (a manifest that
 * cannot validate, a `capabilities()` probe that keeps throwing) still produce
 * an empty-looking idle factory with no alarm at all.
 *
 * ## Two surfaces, two questions, deliberately different triggers
 *
 * The REPORT is unconditional. `/api/health/ready` and `/api/health` carry it
 * whatever the configuration says, because "how many runners are registered"
 * is a question an operator should be able to answer with `curl` rather than a
 * database client, and that is true on a deployment that has never turned
 * dispatch on.
 *
 * The ESCALATION requires `DISPATCH_ENABLED`. It asks a narrower question — is
 * work being lost right now — and with dispatch off nothing was going to be
 * dispatched anyway, so paging about it would be paging about a factory nobody
 * asked to run. That is VISION §12's observation-week posture: report the
 * fact, act only where acting is what was asked for.
 *
 * ## Why it counts ticks instead of firing on the first sight
 *
 * The first sight of an empty fleet is the ordinary state of a process whose
 * database was a few seconds late. See
 * {@link EMPTY_FLEET_TICKS_BEFORE_ESCALATION} for why the number is five.
 */
@Injectable()
export class FleetStateService {
  private readonly logger = new Logger(FleetStateService.name);

  /**
   * Consecutive ticks that have observed an empty, readable fleet.
   *
   * In memory rather than in the database, like
   * `RunnerRegistrationService.reportState`: it is a property of this
   * process's observations, and a fresh boot starting the count again is
   * correct — a restart is exactly when the fleet gets another honest chance
   * to converge. The escalation it eventually produces IS durable, and is
   * deduplicated across processes by the escalation record itself.
   */
  private emptyTicks = 0;

  /**
   * Whether this process has yet seen the fleet non-empty.
   *
   * Exists so a stale escalation left behind by a PREVIOUS process is cleared
   * once, on the first healthy observation. Without it, an escalation raised
   * before a restart would stay unresolved forever and — because dedupe keys
   * on exactly that — would silently suppress every future empty-fleet
   * escalation. A one-shot `updateMany` at boot is a much smaller price than
   * an alarm that can only ever fire once per database.
   */
  private observedConverged = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly escalations: EscalationsService,
  ) {}

  /**
   * The fleet as routing sees it, read fresh.
   *
   * ## Not cached, unlike the seed check
   *
   * `SeedIntegrityService` caches for a minute on the grounds that the
   * permissions table "changes on exactly two occasions — a seed run and a
   * migration". That argument does not transfer and its absence is the point:
   * fleet state changes on every registration tick, and this is precisely the
   * number an operator watches converge after fixing something. Handing them a
   * minute-old answer would show them the fleet from before their fix, which
   * is the one moment the check is being read at all.
   *
   * The cost it buys back is small and bounded: two small tables in a
   * one-to-one join, one row per runner in the build — one, today.
   *
   * ## The whole read is inside the try, not just the query
   *
   * Wider than `SeedIntegrityService`, which wraps only its `findMany`, and
   * deliberately so: the projection below reads a runner's manifest, which is
   * JSON the database returns as whatever went in. This runs on `/api/health`
   * and `/api/health/ready`, both `@Public()`, so a throw escaping here does
   * not degrade a report — it 500s the endpoints an operator is using to find
   * out what is wrong, which is the one failure a health check may not have.
   */
  async check(): Promise<FleetReport> {
    try {
      const rows: RunnerWithCapability[] = await this.prisma.runner.findMany({
        include: { capability: true },
        orderBy: { key: 'asc' },
      });

      const unroutable: string[] = [];
      const runners: FleetRunnerState[] = [];

      for (const row of rows) {
        if (!row.capability) {
          unroutable.push(row.key);
          continue;
        }

        // The SAME projection `DispatchService.loadPool` routes on, rather
        // than a second reading of the same columns. #265 was the bill for
        // having two ends tested and not the join between them, and a fleet
        // report that could disagree with routing would be worse than no
        // report: it would answer the operator's question wrongly and
        // confidently.
        const capabilities = toCapabilities(row, row.capability, this.logger);

        runners.push({
          key: capabilities.key,
          displayName: capabilities.displayName,
          version: capabilities.version,
          enabled: row.enabled,
          available: isAvailable(capabilities),
          unavailableReason: capabilities.unavailableReason ?? null,
          maxConcurrency: capabilities.maxConcurrency,
        });
      }

      const enabled = runners.filter((runner) => runner.enabled);

      return {
        checked: true,
        checkedAt: new Date(),
        registered: rows.length,
        routable: runners.length,
        enabled: enabled.length,
        dispatchable: enabled.filter((runner) => runner.available).length,
        unroutable,
        runners,
      };
    } catch (error) {
      return { checked: false, checkedAt: new Date(), error: asMessage(error) };
    }
  }

  /**
   * One tick's worth of judgement about the fleet.
   *
   * Called by `RunnerRegistrationTask` AFTER the pass that would have fixed
   * things, so what it observes is the state registration actually converged
   * to rather than the state it started from.
   *
   * Never throws. It runs on a `setInterval` callback with no caller to
   * propagate to, and an unhandled rejection there takes the process down
   * under Node's default policy — a dead process being a rather poor way to
   * report a dead fleet. The task catches too; this is the inner belt.
   */
  async observe(): Promise<FleetObservation> {
    const report = await this.check();

    if (!report.checked) {
      // Not counted as an empty tick and not counted as a converged one. See
      // `FleetReport` for why: an unreadable database is the same outage as
      // the empty fleet it causes, it is already reported by the database
      // indicator, and the escalation is a write to the database that is down.
      this.logger.debug(
        `Could not read the fleet this tick, so nothing is concluded about it: ${report.error}`,
      );
      return {
        state: 'unknown',
        emptyTicks: this.emptyTicks,
        escalated: false,
      };
    }

    if (!hasEmptyFleet(report)) {
      const recovered = this.emptyTicks;
      this.emptyTicks = 0;

      // Only when something might be outstanding: on the transition out of a
      // run of empty ticks, or once per process to clear an escalation an
      // earlier process left behind. Otherwise this would be a write on every
      // tick forever to resolve nothing.
      if (recovered > 0 || !this.observedConverged) {
        await this.resolve(recovered);
      }
      this.observedConverged = true;

      return { state: 'converged', emptyTicks: 0, escalated: false };
    }

    this.emptyTicks += 1;

    if (this.emptyTicks < EMPTY_FLEET_TICKS_BEFORE_ESCALATION) {
      this.logger.warn(
        `The fleet is empty (${describeEmptiness(report)}) — ` +
          `${this.emptyTicks} of ${EMPTY_FLEET_TICKS_BEFORE_ESCALATION} tick(s) before this is escalated`,
      );
      return {
        state: 'empty',
        emptyTicks: this.emptyTicks,
        escalated: false,
      };
    }

    if (!this.dispatchEnabled) {
      // The log is the ONLY channel on this path, so it repeats — on the tick
      // that crosses the threshold and every tenth after it. See
      // EMPTY_FLEET_REPEAT_EVERY.
      const sinceThreshold =
        this.emptyTicks - EMPTY_FLEET_TICKS_BEFORE_ESCALATION;
      if (sinceThreshold % EMPTY_FLEET_REPEAT_EVERY === 0) {
        this.logger.warn(
          `The fleet has been empty for ${this.emptyTicks} tick(s) (${describeEmptiness(report)}). ` +
            'Not escalated because DISPATCH_ENABLED is off, so no work is being ' +
            'lost — but nothing would run if it were turned on.',
        );
      } else {
        this.logger.debug(
          `The fleet is still empty after ${this.emptyTicks} tick(s), and dispatch is off`,
        );
      }

      return {
        state: 'empty',
        emptyTicks: this.emptyTicks,
        escalated: false,
      };
    }

    // `>=` rather than `===`, so the escalation still fires on the tick after
    // dispatch is switched on, having already been empty for longer than the
    // threshold. Repeating past the threshold is free: `raiseSystemOnce`
    // dedupes, which is #57's rule that one condition produces one escalation
    // rather than one per tick.
    const outcome = await this.escalate(report);

    return {
      state: 'empty',
      emptyTicks: this.emptyTicks,
      escalated: outcome === 'raised',
    };
  }

  // -------------------------------------------------------------------------

  private async escalate(
    report: Extract<FleetReport, { checked: true }>,
  ): Promise<'raised' | 'deduplicated' | 'failed'> {
    const minutes = Math.round(
      (this.emptyTicks * REGISTRATION_INTERVAL_MS) / 60_000,
    );

    try {
      const { deduplicated } = await this.escalations.raiseSystemOnce({
        summary: EMPTY_FLEET_SUMMARY,
        // Everything an operator needs to act without opening a laptop first:
        // how long, what is actually in the table, and the two commands that
        // distinguish the causes.
        detail:
          `Dispatch is enabled and no runner is routable, so every work order ` +
          `will queue behind "No runners are registered." This has been true ` +
          `for ${this.emptyTicks} consecutive registration tick(s) — about ` +
          `${minutes} minute(s) — which is longer than a database blip at boot ` +
          `takes to converge. ${describeEmptiness(report)}. ` +
          'Check the API log for RunnerRegistrationService: it names the ' +
          'runner it could not register and why, and distinguishes a manifest ' +
          'that fails the capability schema (which will never converge on its ' +
          'own) from a database write that keeps failing (which will).',
      });

      if (!deduplicated) {
        this.logger.error(
          `Escalated an empty fleet after ${this.emptyTicks} tick(s): ${describeEmptiness(report)}`,
        );
      }

      return deduplicated ? 'deduplicated' : 'raised';
    } catch (error) {
      // Swallowed on the same reasoning `ApprovalGateService.escalateParked`
      // gives: the observation stands whether or not the write lands, and the
      // next tick tries again in a minute. Throwing would take out the loop
      // that is the only thing still watching.
      this.logger.error(
        `The fleet is empty and the escalation could not be written; it will be ` +
          `retried on the next tick: ${asMessage(error)}`,
      );
      return 'failed';
    }
  }

  /**
   * Clear an outstanding empty-fleet escalation once the fleet is back.
   *
   * Not optional, and for two reasons. The dedupe key IS the outstanding
   * escalation, so leaving it unresolved means the alarm can never fire again.
   * And `RunnerRegistrationService.report` already argues the general case:
   * *"an error that is silently retried until it works is worse than either an
   * error that repeats or one that never appears, because an operator who read
   * the failure has no way to learn it is over."*
   *
   * `resolveStale` cannot do this — it resolves by run id, and a fleet
   * escalation has no run.
   */
  private async resolve(recoveredAfterTicks: number): Promise<void> {
    try {
      const resolved =
        await this.escalations.resolveSystem(EMPTY_FLEET_SUMMARY);
      if (resolved > 0) {
        this.logger.log(
          `The fleet is registered again after ${recoveredAfterTicks} empty tick(s); ` +
            `resolved ${resolved} empty-fleet escalation(s)`,
        );
      }
    } catch (error) {
      // The fleet is healthy; this failing costs a stale row, not an outage.
      this.logger.warn(
        `Could not resolve the empty-fleet escalation now that the fleet is back: ${asMessage(error)}`,
      );
    }
  }

  private get dispatchEnabled(): boolean {
    return this.config.get<boolean>('dispatch.enabled') === true;
  }
}

/** What one tick concluded. Returned for the task's log and for tests. */
export interface FleetObservation {
  state: 'converged' | 'empty' | 'unknown';
  emptyTicks: number;
  /** True only on the tick that actually wrote an escalation. */
  escalated: boolean;
}

/**
 * Which flavour of empty, in one clause.
 *
 * Two causes, two different things to go and look at: nothing registered at
 * all points at registration failing, while rows present without a manifest
 * points at the capability upsert half of the transaction — so collapsing them
 * into "the fleet is empty" would send an operator to the wrong half.
 */
function describeEmptiness(
  report: Extract<FleetReport, { checked: true }>,
): string {
  if (report.registered === 0) return 'the runners table has no rows at all';

  return (
    `${report.registered} runner row(s) exist but none carries a capability ` +
    `manifest, so routing cannot see any of them: ${report.unroutable.join(', ')}`
  );
}

type RunnerWithCapability = Awaited<
  ReturnType<PrismaService['runner']['findUniqueOrThrow']>
> & {
  capability: Awaited<
    ReturnType<PrismaService['runnerCapability']['findUniqueOrThrow']>
  > | null;
};
