import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../prisma/prisma.service';
import type {
  ModelTier,
  RunnerCapabilities,
  RunnerNeed,
} from '../runners/runner.types';
import {
  decideDispatch,
  type DispatchDecision,
  type RunnerPoolEntry,
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
    const [pool, globalLiveRuns] = await Promise.all([
      this.loadPool(),
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

    return decision;
  }

  /**
   * Every registered runner, with its manifest and current load.
   *
   * One query and one group-by rather than a count per runner: this runs on
   * the dispatch path for every queued work order, and a query per runner is
   * how a tick that should be arithmetic becomes an N+1.
   */
  private async loadPool(): Promise<RunnerPoolEntry[]> {
    const [runners, loads] = await Promise.all([
      this.prisma.runner.findMany({
        include: { capability: true },
        orderBy: { key: 'asc' },
      }),
      this.prisma.run.groupBy({
        by: ['runnerKey'],
        where: { status: { in: OCCUPYING_STATUSES as unknown as never } },
        _count: { _all: true },
      }),
    ]);

    const liveByRunner = new Map(
      loads.map((row) => [row.runnerKey, row._count._all]),
    );

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
        }))
    );
  }

  private async countLiveRuns(): Promise<number> {
    return this.prisma.run.count({
      where: { status: { in: OCCUPYING_STATUSES as unknown as never } },
    });
  }
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
    manifest: (capability.manifest ?? {}) as Record<string, unknown>,
  };
}

export { OCCUPYING_STATUSES };
