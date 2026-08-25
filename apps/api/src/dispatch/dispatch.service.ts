import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../prisma/prisma.service';
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
    // means quota exhaustion moved work instead of parking it. The arithmetic
    // that turns these into dead time per day belongs to #232 and is not
    // built — this records the event, and claims nothing more.
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
    const [runners, loads, blocked] = await Promise.all([
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
    ]);

    const liveByRunner = new Map(
      loads.map((row) => [row.runnerKey, row._count._all]),
    );
    const quotaByRunner = quotaPositions(blocked, now);

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
          capabilities: toCapabilities(runner, runner.capability!),
          // Undefined for a runner with no observed block, which the policy
          // reads as UNKNOWN and routes to freely.
          quota: quotaByRunner.get(runner.key),
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
 * ## Availability comes out of the verbatim manifest, not a column
 *
 * `available` (#253) has no column, and the manifest JSON is kept verbatim for
 * exactly this: *"a field this schema does not model yet is not silently
 * discarded."* Reading it here is what makes the round trip complete — a fact
 * the runner declares, the registration writes down and routing never sees is
 * the same as a fact nobody recorded, and this one decides whether work is
 * routed at all.
 *
 * Read defensively, because the manifest is JSON the database will hand back
 * as whatever was put in: anything that is not literally `false` leaves the
 * runner available, which is the same absent-means-available default the
 * schema states and `isAvailable` enforces. A parse slip must not ground the
 * fleet.
 */
function toCapabilities(
  runner: RunnerRow,
  capability: CapabilityRow,
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
    ...availabilityOf(capability.manifest),
    manifest: (capability.manifest ?? {}) as Record<string, unknown>,
  };
}

/**
 * The two availability fields, recovered from the stored manifest.
 *
 * Returns nothing at all for a runner that never mentioned its health, so the
 * fields stay ABSENT rather than becoming an explicit `true` — the seam type
 * says undefined means available, and writing the default in would make a
 * manifest that said nothing indistinguishable from one that asserted it was
 * fine.
 */
function availabilityOf(
  manifest: CapabilityRow['manifest'],
): Pick<RunnerCapabilities, 'available' | 'unavailableReason'> {
  if (
    typeof manifest !== 'object' ||
    manifest === null ||
    Array.isArray(manifest)
  ) {
    return {};
  }

  const declared = manifest as Record<string, unknown>;
  if (declared.available !== false) return {};

  return {
    available: false,
    unavailableReason:
      typeof declared.unavailableReason === 'string'
        ? declared.unavailableReason
        : undefined,
  };
}

export { OCCUPYING_STATUSES, QUOTA_BLOCK_REASONS };
