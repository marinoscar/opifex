import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { RUNNER_CAPABILITY_MODEL_TIERS } from '../contracts/generated';
import { PrismaService } from '../prisma/prisma.service';
import { meterQuotaPosition, type MeterWindow } from '../quota/quota-window';
import type { BlockedReason } from '../run-events/run-event.types';
import type {
  ModelTier,
  RunnerCapabilities,
  RunnerNeed,
} from '../runners/runner.types';
import {
  decideDispatch,
  type DispatchDecision,
  type RunnerPoolEntry,
  type RunnerQuotaPosition,
} from './dispatch-policy';

/**
 * Run statuses that occupy a slot on their runner.
 *
 * `blocked` is in here, and it is the debatable one. A rate-limited run is not
 * doing anything, so holding its slot for an hour costs real throughput — but
 * it WILL resume on that runner (#56), and freeing the slot now means
 * over-subscribing the moment it does. Over-subscription is the worse failure:
 * it breaks the one number a runner told us about itself.
 *
 * The bound on the cost is #66's auto-resume, which is what stops a blocked
 * run holding a slot indefinitely.
 */
const OCCUPYING_STATUSES = ['running', 'stalled', 'blocked'] as const;

/**
 * The block reasons that say something about QUOTA, as opposed to about one
 * run.
 *
 * Typed against the wire vocabulary rather than spelled freehand, so a reason
 * renamed in `run-event.schema.json` fails to compile here instead of silently
 * matching nothing. `awaiting-approval` and `upstream-unavailable` are facts
 * about one run and imply nothing about the runner's subscription;
 * `unknown` is deliberately excluded, because VISION §6's rule that unknown is
 * not zero cuts this way too — a block nobody could classify must not take a
 * runner out of service.
 */
const QUOTA_BLOCK_REASONS: readonly BlockedReason[] = [
  'rate-limit',
  'quota-exhausted',
];

/**
 * Dispatch decisions, made against real fleet state.
 *
 * The decision itself is a pure function (`dispatch-policy.ts`) — VISION §3.1
 * and §7 make dispatch code rather than model, and keeping the logic pure is
 * what makes "fully unit-tested; no model involvement" (#64) checkable rather
 * than asserted. This class does the I/O and nothing else: load the pool,
 * count what is live, hand both to the policy.
 */
@Injectable()
export class DispatchService {
  private readonly logger = new Logger(DispatchService.name);

  /** runnerKey → the disagreement this process has already reported. */
  private readonly reportedDisagreements = new Map<string, string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Which runner should take this work order, or why none can.
   *
   * Takes the NEEDS, not a work order — routing must not be able to see a
   * runner name even if one somehow appeared on the record (VISION §6).
   */
  async decide(
    needs: readonly RunnerNeed[],
    identity?: string,
    modelTier?: ModelTier,
  ): Promise<DispatchDecision> {
    // The one clock reading on this path. `decideDispatch` is pure and has no
    // now of its own (see `dispatch-policy.ts`), so every time comparison the
    // decision depends on happens here, against this instant, and the policy
    // receives already-settled facts.
    const now = new Date();

    const [pool, globalLiveRuns] = await Promise.all([
      this.loadPool(now),
      this.countLiveRuns(),
    ]);

    const decision = decideDispatch({ needs, identity, modelTier }, pool, {
      globalMaxConcurrent:
        this.config.get<number | null>('dispatch.maxConcurrent') ?? null,
      globalLiveRuns,
      allowPreviewWithoutGaFallback:
        this.config.get<boolean>('dispatch.allowPreviewRunner') === true,
    });

    // Logged at `log` for a dispatch and `warn` for a queue: a work order that
    // cannot be placed is not an error, but it is the thing an operator wants
    // to see in a scroll-back without grepping.
    const line = `${identity ?? 'work order'}: ${decision.reason}`;
    if (decision.outcome === 'dispatch') this.logger.log(line);
    else this.logger.warn(line);

    // Logged as its own line, with a fixed prefix, because this is the
    // countable event behind #105 (VISION §10's metric 2): one occurrence
    // means quota exhaustion moved work instead of parking it.
    //
    // The log line is no longer the record. #264 persists the event as an
    // `avoided_parks` row — but deliberately NOT here, because this method is
    // also called hypothetically by `cockpit/queue.service.ts` on every queue
    // poll, and writing from a read model would count dashboard traffic as
    // avoided parks. `run-executor.service.ts` writes it, where a dispatch has
    // actually happened. The line stays because a scroll-back is still the
    // fastest way to see routing working in the moment.
    if (decision.avoidedQuotaPark) {
      this.logger.log(
        `Quota-aware routing avoided a park for ${identity ?? 'a work order'}: ` +
          `dispatched to ${decision.runnerKey} while another capable runner is out of quota`,
      );
    }

    return decision;
  }

  /**
   * Every registered runner, with its manifest and current load.
   *
   * One query and one group-by rather than a count per runner: this runs on
   * the dispatch path for every queued work order, and a query per runner is
   * how a tick that should be arithmetic becomes an N+1.
   */
  private async loadPool(now: Date): Promise<RunnerPoolEntry[]> {
    const [runners, loads, blocked, meter] = await Promise.all([
      this.prisma.runner.findMany({
        include: { capability: true },
        orderBy: { key: 'asc' },
      }),
      this.prisma.run.groupBy({
        by: ['runnerKey'],
        where: { status: { in: OCCUPYING_STATUSES as unknown as never } },
        _count: { _all: true },
      }),
      this.loadQuotaBlocks(),
      this.loadQuotaMeter(now),
    ]);

    const liveByRunner = new Map(
      loads.map((row) => [row.runnerKey, row._count._all]),
    );
    const derivedByRunner = quotaPositions(blocked, now);
    const meterByRunner = meterPositions(meter, now);

    return (
      runners
        // A runner with no capability manifest cannot be matched against needs
        // at all — there is nothing to match. Dropped rather than defaulted:
        // guessing a manifest would route real work on invented facts.
        .filter((runner) => {
          if (runner.capability) return true;
          this.logger.warn(
            `Runner ${runner.key} has registered no capability manifest and cannot be routed to`,
          );
          return false;
        })
        .map((runner) => ({
          enabled: runner.enabled,
          liveRuns: liveByRunner.get(runner.key) ?? 0,
          capabilities: toCapabilities(runner, runner.capability!, this.logger),
          // Undefined for a runner NEITHER signal has anything to say about,
          // which the policy reads as UNKNOWN and routes to freely.
          quota: this.resolveQuota(
            runner.key,
            derivedByRunner.get(runner.key),
            meterByRunner.get(runner.key),
          ),
        }))
    );
  }

  /**
   * Every currently-blocked run, with the block its runner last reported.
   *
   * ## Why this is the quota signal
   *
   * There is no quota meter to query — #231 is open and unbuilt, and standing
   * up a second one here would guarantee the two disagree. What already exists
   * is an OBSERVED position: runs sitting `blocked` because the runner said it
   * was rate-limited, carrying the reset time it supplied. That is a dated,
   * first-hand fact about the subscription, and it is the same signal #56's
   * parking machinery already runs on.
   *
   * One query for the whole fleet, on the same shape the watchdog uses to load
   * blocked runs. Blocked runs are a handful by construction: they are bounded
   * by fleet concurrency, since `blocked` occupies a slot.
   */
  private async loadQuotaBlocks(): Promise<BlockedRunRow[]> {
    return this.prisma.run.findMany({
      where: { status: 'blocked' },
      select: {
        runnerKey: true,
        resumesAt: true,
        events: {
          where: { type: 'run_blocked' },
          orderBy: { occurredAt: 'desc' },
          take: 1,
          select: { blockedReason: true, blockedUntil: true },
        },
      },
    });
  }

  /**
   * Every window the fleet's runners have observed that has not yet rolled.
   *
   * ## Deliberately not `QuotaService.readings()`
   *
   * That method keeps the NEWEST live window per runner, which is right for a
   * panel showing "the current window" and wrong here — a `weekly` row almost
   * always has a later reset than a `five_hour` one, so keeping the newest
   * would hide an exhausted five-hour window behind a healthy weekly one. Any
   * live window can bind, so routing loads them all and
   * {@link meterQuotaPosition} collapses them. It also does no consumption
   * aggregation at all: `readings()` runs three aggregate queries per runner
   * to sum spend through a window, which is a read model's budget and not the
   * dispatch path's.
   *
   * Read straight from Prisma, alongside `loadQuotaBlocks`, so the whole pool
   * still loads in one `Promise.all` and dispatch gains no injected dependency
   * for a single indexed `findMany`.
   */
  private async loadQuotaMeter(now: Date): Promise<MeterWindowRow[]> {
    return this.prisma.quotaWindow.findMany({
      where: { resetsAt: { gt: now } },
      select: {
        runnerKey: true,
        kind: true,
        resetsAt: true,
        pressure: true,
        lastObservedAt: true,
      },
    });
  }

  /**
   * The single position for one runner, and the record when the two disagree.
   *
   * The resolution itself is {@link resolveQuotaPosition}, which is pure. This
   * wrapper exists for the log line, and for one thing the pure function
   * cannot do: say it only once. `decide()` is called hypothetically by
   * `cockpit/queue.service.ts` on every queue poll, so warning per resolution
   * would print the same sentence twice a minute for as long as a five-hour
   * window lasts. Keyed on the resolved basis per runner, in memory, on the
   * same principle as `RunPollerService.deadlineEnforced` — it is a fact about
   * what THIS process has already said, not about the runner — and bounded by
   * the fleet size rather than by time.
   */
  private resolveQuota(
    runnerKey: string,
    derived: RunnerQuotaPosition | undefined,
    meter: RunnerQuotaPosition | undefined,
  ): RunnerQuotaPosition | undefined {
    const resolved = resolveQuotaPosition(derived, meter);

    if (derived && meter && derived.exhausted !== meter.exhausted) {
      if (this.reportedDisagreements.get(runnerKey) !== resolved?.basis) {
        this.reportedDisagreements.set(runnerKey, resolved?.basis ?? '');
        this.logger.warn(
          `Quota signals disagree for ${runnerKey}; taking the exhausted reading: ${resolved?.basis}`,
        );
      }
    } else {
      this.reportedDisagreements.delete(runnerKey);
    }

    return resolved;
  }

  private async countLiveRuns(): Promise<number> {
    return this.prisma.run.count({
      where: { status: { in: OCCUPYING_STATUSES as unknown as never } },
    });
  }
}

interface BlockedRunRow {
  runnerKey: string;
  resumesAt: Date | null;
  events: { blockedReason: string | null; blockedUntil: Date | null }[];
}

/** A `quota_windows` row as this file reads it. `pressure` arrives as its enum. */
type MeterWindowRow = MeterWindow & { runnerKey: string };

/**
 * Turn blocked runs into one quota position per runner, resolved against now.
 *
 * ## Only a DATED block counts
 *
 * A quota block the runner could not date produces no position at all. It is
 * true that such a runner may well be out of quota — but nothing can say when
 * it stops being, and marking it exhausted would keep it out of routing until
 * a human intervened, converting one undated block into an open-ended refusal
 * to use the runner. That case already has an owner: #56 escalates an undated
 * block after `UNDATED_BLOCK_PATIENCE_MS`, because a human is what it needs.
 * Here it stays UNKNOWN, and unknown is usable.
 *
 * ## The later of the two dates wins
 *
 * `blockedUntil` is when the vendor said the window rolls; `resumesAt` is when
 * the watchdog will actually retry, which is that time plus jitter (#56). The
 * later is used, so routing never treats a runner as refilled while the run
 * that discovered the block is still waiting out its own jitter — erring
 * towards patience, since the cost of being early is another blocked run.
 */
function quotaPositions(
  blocked: readonly BlockedRunRow[],
  now: Date,
): Map<string, RunnerQuotaPosition> {
  const latest = new Map<
    string,
    { until: Date; reasons: Set<string>; runs: number }
  >();

  for (const run of blocked) {
    const event = run.events[0];
    const reason = event?.blockedReason ?? null;
    if (!reason || !QUOTA_BLOCK_REASONS.includes(reason as BlockedReason)) {
      continue;
    }

    const dates = [event?.blockedUntil, run.resumesAt].filter(
      (date): date is Date => date instanceof Date,
    );
    if (dates.length === 0) continue;

    const until = dates.reduce((a, b) => (a > b ? a : b));
    if (until <= now) continue;

    const seen = latest.get(run.runnerKey);
    if (!seen) {
      latest.set(run.runnerKey, {
        until,
        reasons: new Set([reason]),
        runs: 1,
      });
      continue;
    }
    seen.reasons.add(reason);
    seen.runs += 1;
    if (until > seen.until) seen.until = until;
  }

  return new Map(
    [...latest].map(([runnerKey, seen]) => [
      runnerKey,
      {
        exhausted: true,
        resumesAt: seen.until.toISOString(),
        basis:
          `${seen.runs} run(s) on this runner are blocked on ` +
          `'${[...seen.reasons].sort().join("', '")}' with a reset time`,
      },
    ]),
  );
}

/**
 * The meter's windows, collapsed to one position per runner.
 *
 * The per-runner resolution — every live window binds, the latest exhausted
 * one dates the refill, a stale reading asserts no health — lives in
 * `quota/quota-window.ts` with the rest of the quota arithmetic. This is only
 * the grouping.
 */
function meterPositions(
  windows: readonly MeterWindowRow[],
  now: Date,
): Map<string, RunnerQuotaPosition> {
  const byRunner = new Map<string, MeterWindowRow[]>();
  for (const window of windows) {
    const seen = byRunner.get(window.runnerKey);
    if (seen) seen.push(window);
    else byRunner.set(window.runnerKey, [window]);
  }

  const positions = new Map<string, RunnerQuotaPosition>();
  for (const [runnerKey, runnerWindows] of byRunner) {
    const position = meterQuotaPosition(runnerWindows, now);
    if (position) positions.set(runnerKey, position);
  }

  return positions;
}

/**
 * The ONE quota position, resolved from the two signals that can produce one.
 *
 * ## Two producers, one field (#285)
 *
 * - **Blocked runs** (#105), `quotaPositions` above: runs sitting `blocked` on
 *   a dated rate-limit reason. Lagging and one-directional — it speaks only
 *   after a run has already hit the wall, and it can never assert health,
 *   because the absence of a park is silence rather than evidence. Every
 *   position it produces is `exhausted: true`; that is the only claim it can
 *   make.
 * - **The runner's meter** (#231), `quota/quota-window.ts`: vendor rate-limit
 *   lines observed while the runner was still serving. It arrives EARLIER —
 *   before anything has parked — and it is the only signal that can say
 *   `allowed` positively. It is also only as fresh as the last poll of a live
 *   run, which is why health expires and exhaustion does not — see
 *   `QUOTA_METER_HEALTH_HORIZON_MS`, which has already been applied by the
 *   time a position reaches this function.
 *
 * `decideDispatch` must never learn there are two. It is pure and clock-free
 * by construction, every time comparison the decision rests on already happens
 * in this file, and a second source reconciled inside the policy would be the
 * same reconciliation in the one place that cannot own a clock to do it with.
 *
 * ## The rule: exhaustion wins, from either source. Health needs agreement.
 *
 * Stated as three cases, in order:
 *
 *  1. **Either source says exhausted → exhausted.** When BOTH do, `resumesAt`
 *     is the later of the two dates, for the reason `quotaPositions` above
 *     already takes the later of its own two. When only one does, it is that
 *     source's date and not the later one — the other's `resumesAt` dates a
 *     window that is not binding, and a healthy weekly window resetting on
 *     Sunday must not postpone a five-hour refill due in an hour.
 *  2. **Neither says exhausted, and the meter is fresh → healthy**, with the
 *     meter's basis. The derived signal has no vote here: it does not have one
 *     to cast.
 *  3. **Nothing left → undefined**, which routing reads as UNKNOWN and routes
 *     to freely. VISION §6: unknown is not zero. A runner that has never
 *     parked and never emitted a rate-limit line is fully usable, and a runner
 *     whose only reading has gone stale is back to being exactly that.
 *
 * ## Why exhaustion wins, rather than the fresher reading
 *
 * The costs are asymmetric. Believing a false `exhausted` delays work by the
 * length of the false claim. Believing a false `healthy` dispatches into a
 * wall: it spends a slot, spends an attempt, and produces the park anyway —
 * later, and after paying for it. That park is the exact dead time #105 exists
 * to remove, so the signal that predicts it is the one to trust when they
 * conflict.
 *
 * What makes that safe rather than merely timid is that the false-exhausted
 * case is BOUNDED, and bounded by the sources themselves. Both self-expire
 * against a date rather than against a restatement: `quotaPositions` drops a
 * block whose dates have passed, and `quotaPositionFrom` drops a window that
 * has rolled. Neither can hold a runner out of service indefinitely, and no
 * human has to notice. The worst case is the narrow one — the meter has seen a
 * new window open while a blocked run is still waiting out #56's jitter — and
 * that tail is capped at `MAX_JITTER_MS`, ten minutes.
 *
 * That narrow case is also the one where preferring exhaustion is not just
 * cheap but RIGHT, which is what carries `quotaPositions`'s own "later of the
 * two dates wins ... erring towards patience" across to a second signal. The
 * jitter exists (#56) to stop every run parked by one window resuming into the
 * same instant and re-exhausting it. A fresh meter reading releasing the
 * runner early would put NEW work into precisely the instant that jitter was
 * holding open, which is the thundering herd arriving through the front door.
 *
 * ## The disagreement worth naming is only one of the two
 *
 * Meter-exhausted with the blocked signal silent is not a disagreement at all:
 * silence is not a health claim, so the meter simply speaks, and that case is
 * the whole point of wiring it — a park avoided before the first run hits the
 * wall. The real disagreement is the other one: a blocked run says exhausted
 * while a fresh meter reading says allowed. It need not be staleness — VISION
 * §11's interactive co-tenant can empty the window between the vendor's line
 * and the block, in which case both readings were true when taken.
 *
 * So it is RECORDED rather than resolved away. `basis` names both sources and
 * says they disagreed, because that string is printed into the routing reason
 * and persisted with an avoided park (#264), and #64 requires a decision be
 * reconstructible from that line alone. No new table: the disagreement is an
 * annotation on a decision, not a fact with a life of its own.
 *
 * Pure and clock-free, like the policy it feeds. Everything time-dependent —
 * has the block lifted, has the window rolled, is the reading fresh — has
 * already been settled by the two callers above against the one `now`.
 */
export function resolveQuotaPosition(
  derived: RunnerQuotaPosition | undefined,
  meter: RunnerQuotaPosition | undefined,
): RunnerQuotaPosition | undefined {
  // Every basis is prefixed with the source that produced it, including the
  // single-source cases. #285 requires `basis` to NAME the source, and a
  // string that names it only when there was a second one to distinguish it
  // from is a record that reads differently depending on facts it does not
  // contain.
  if (!derived) return meter ? sourced('meter', meter) : undefined;
  if (!meter) return sourced('blocked runs', derived);

  if (derived.exhausted && meter.exhausted) {
    return {
      exhausted: true,
      resumesAt: laterOf(derived.resumesAt, meter.resumesAt),
      basis:
        `blocked runs and the runner's own meter agree — ` +
        `blocked runs: ${derived.basis}; meter: ${meter.basis}`,
    };
  }

  if (derived.exhausted !== meter.exhausted) {
    const exhausted = derived.exhausted ? derived : meter;
    return {
      exhausted: true,
      resumesAt: exhausted.resumesAt,
      basis:
        `blocked runs and the runner's own meter DISAGREE, and the exhausted ` +
        `reading is taken — blocked runs: ${derived.basis}; meter: ${meter.basis}`,
    };
  }

  // Both say healthy. Only the meter can say it, so only the meter's sentence
  // is worth printing; the derived signal being absent of a block is the
  // silence it always is.
  return sourced('meter', meter);
}

/** The same position, with its producer named in the basis. */
function sourced(
  source: 'meter' | 'blocked runs',
  position: RunnerQuotaPosition,
): RunnerQuotaPosition {
  return { ...position, basis: `${source}: ${position.basis}` };
}

/**
 * The later of two ISO instants, either of which may be missing.
 *
 * Compared as strings, which is exact rather than approximate here: both are
 * `Date.prototype.toISOString()` output, so both are fixed-width UTC and
 * lexicographic order IS chronological order. Kept that way so the one place
 * that holds a date as a string for the policy's sake does not quietly rebuild
 * a `Date` to compare it.
 */
function laterOf(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a > b ? a : b;
}

type RunnerRow = Awaited<
  ReturnType<PrismaService['runner']['findUniqueOrThrow']>
>;
type CapabilityRow = Awaited<
  ReturnType<PrismaService['runnerCapability']['findUniqueOrThrow']>
>;

/**
 * The database row as the seam's type.
 *
 * A translation rather than a cast: the policy is written against
 * `RunnerCapabilities` from `runner.types.ts`, which restates its enums so it
 * stays a pure contract with no Prisma import. A spec pins the two together.
 *
 * ## Two routing inputs come out of the verbatim manifest, not out of columns
 *
 * `modelTiers` (#205) and `available` (#253) have no column between them, and
 * the manifest JSON is kept verbatim for exactly this: *"a field this schema
 * does not model yet is not silently discarded."* Reading them here is what
 * makes the round trip complete — a fact the runner declares, the registration
 * writes down and routing never sees is the same as a fact nobody recorded,
 * and both of these decide whether work is routed at all.
 *
 * Skipping the `modelTiers` read is precisely how `servesTier` came to be
 * unreachable in production (#265): every runner arrived with the field
 * undefined, the "serves any tier" default fired every time, and a refusal
 * branch that existed and was tested could not run.
 *
 * Read defensively in both cases, because the manifest is JSON the database
 * will hand back as whatever was put in, and a parse slip on the dispatch path
 * must not ground the fleet. `ContractValidator` already refused a malformed
 * manifest at registration, so this is the second line rather than the first.
 *
 * ## Whether either deserves a column
 *
 * A fair question, and deliberately not answered here. Both are consulted on
 * every dispatch, and reading a routing input out of JSON on the hot path is
 * the kind of thing that is fine until it isn't — the point it stops being
 * fine is when routing wants to FILTER on it (`where: { modelTiers: { has:
 * ... } }` needs a column and an index; `loadPool` reading every row does
 * not). Today the pool is every registered runner, a handful of rows loaded
 * whole, so the JSON read costs nothing a column would save. Adding one now
 * would also mean a migration and a second place for the same fact to live,
 * which is how a column and a manifest start to disagree. Recorded as a
 * question for when the fleet is big enough to make it a real one.
 *
 * Exported for its spec, and on purpose: this is the one step between the
 * database and a policy that is pure precisely so it can be tested, and #265
 * is the bill for having tested both ends and not the join.
 */
function toCapabilities(
  runner: RunnerRow,
  capability: CapabilityRow,
  logger: Pick<Logger, 'warn'>,
): RunnerCapabilities {
  return {
    key: runner.key,
    displayName: runner.displayName,
    version: runner.version,
    schemaVersion: capability.schemaVersion,
    invocationModel:
      capability.invocationModel as RunnerCapabilities['invocationModel'],
    executionLocus:
      capability.executionLocus as RunnerCapabilities['executionLocus'],
    streamingFidelity:
      capability.streamingFidelity as RunnerCapabilities['streamingFidelity'],
    rateLimitSignal:
      capability.rateLimitSignal as RunnerCapabilities['rateLimitSignal'],
    stabilityTier:
      capability.stabilityTier as RunnerCapabilities['stabilityTier'],
    reportsCost: capability.reportsCost,
    resumable: capability.resumable,
    maxConcurrency: capability.maxConcurrency,
    branchPatterns: capability.branchPatterns,
    ...modelTiersOf(capability.manifest, runner.key, logger),
    ...availabilityOf(capability.manifest),
    manifest: (capability.manifest ?? {}) as Record<string, unknown>,
  };
}

/**
 * The tier vocabulary, taken from the generated contract rather than respelled.
 *
 * The annotation is the point: `ModelTier` in `runner.types.ts` restates the
 * schema's enum by hand so the seam stays free of generated imports, and this
 * assignment fails to compile the day the schema grows a fourth tier that the
 * hand-written union has not been told about. A parser that quietly rejected
 * the new tier as unknown would ignore the declaration of every runner that
 * adopted it.
 */
const KNOWN_MODEL_TIERS: readonly ModelTier[] = RUNNER_CAPABILITY_MODEL_TIERS;

/**
 * The model tiers this runner declared, recovered from the stored manifest.
 *
 * Returns nothing at all for a runner that never mentioned tiers, so the field
 * stays ABSENT rather than becoming an explicit list of everything — the seam
 * type says undefined means ANY, and that default is what keeps a runner
 * written before tiers existed eligible for the work it had been taking.
 *
 * ## A value it cannot read is treated as absent, and said out loud
 *
 * Dropped WHOLE, never repaired. Filtering `['small', 'huge']` down to
 * `['small']` would invent a restriction the runner never declared and refuse
 * work it can do, while keeping the unknown string would let a value nothing
 * understands take part in a routing decision. Falling back to the documented
 * default is the only reading that changes nothing: the runner is routed the
 * way every runner was routed before it said anything.
 *
 * Logged because that fallback is not free — a runner whose declaration was
 * discarded is now being sent work it may have been trying to refuse, and the
 * only symptom otherwise is a dispatch that looks entirely ordinary.
 */
function modelTiersOf(
  manifest: CapabilityRow['manifest'],
  runnerKey: string,
  logger: Pick<Logger, 'warn'>,
): Pick<RunnerCapabilities, 'modelTiers'> {
  const declared = declaredIn(manifest)?.modelTiers;
  if (declared === undefined) return {};

  // Empty counts as malformed rather than as "serves nothing": the schema sets
  // `minItems: 1`, and the policy already reads an empty list as ANY, so the
  // two agree on the outcome and this way it is also reported.
  const known =
    Array.isArray(declared) &&
    declared.length > 0 &&
    declared.every(isKnownTier);

  if (!known) {
    logger.warn(
      `Runner ${runnerKey} declares modelTiers ${JSON.stringify(declared)}, which is not a ` +
        `non-empty list of ${KNOWN_MODEL_TIERS.join(', ')}; ignoring the declaration and ` +
        `treating the runner as serving any tier`,
    );
    return {};
  }

  // Copied rather than aliased, so the routing input cannot be reached through
  // the verbatim `manifest` this same projection also hands out.
  return { modelTiers: [...(declared as ModelTier[])] };
}

function isKnownTier(value: unknown): value is ModelTier {
  return (
    typeof value === 'string' && KNOWN_MODEL_TIERS.includes(value as ModelTier)
  );
}

/**
 * The two availability fields, recovered from the stored manifest.
 *
 * Returns nothing at all for a runner that never mentioned its health, so the
 * fields stay ABSENT rather than becoming an explicit `true` — the seam type
 * says undefined means available, and writing the default in would make a
 * manifest that said nothing indistinguishable from one that asserted it was
 * fine. Anything that is not literally `false` leaves the runner available,
 * which is the same absent-means-available default the schema states and
 * `isAvailable` enforces.
 */
function availabilityOf(
  manifest: CapabilityRow['manifest'],
): Pick<RunnerCapabilities, 'available' | 'unavailableReason'> {
  const declared = declaredIn(manifest);
  if (!declared || declared.available !== false) return {};

  return {
    available: false,
    unavailableReason:
      typeof declared.unavailableReason === 'string'
        ? declared.unavailableReason
        : undefined,
  };
}

/**
 * The manifest as a plain object, or null for anything that is not one.
 *
 * Shared by both manifest reads above because both face the same fact: this is
 * JSON the database returns as whatever went in, and `typeof null === 'object'`
 * with `Array.isArray` on top is the guard that keeps a defensive read from
 * becoming a throw on the dispatch path.
 */
function declaredIn(
  manifest: CapabilityRow['manifest'],
): Record<string, unknown> | null {
  if (
    typeof manifest !== 'object' ||
    manifest === null ||
    Array.isArray(manifest)
  ) {
    return null;
  }

  return manifest as Record<string, unknown>;
}

export { OCCUPYING_STATUSES, QUOTA_BLOCK_REASONS, toCapabilities };
