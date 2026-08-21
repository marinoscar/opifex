import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { GitHubRateLimitError } from '../github/github.errors';
import { GitHubHttpService } from '../github/github-http.service';
import { RateLimitService } from '../github/rate-limit.service';
import { GitHubReadService } from '../github/read/github-read.service';
import { PrismaService } from '../prisma/prisma.service';
import { RepositoriesService } from '../repositories/repositories.service';
import type { TickFailure, TickRecord, TickOutcome } from './reconciler.types';
import { TickLeaseService } from './tick-lease.service';

/**
 * The control loop.
 *
 * VISION §4: the orchestrator is a **reconciler, not a job queue**, at its
 * GitHub edge. Each tick it observes GitHub and its own run state, computes
 * what should be true, acts, and records.
 *
 * The practical consequence, and the reason for the shape: **you can always
 * fix the factory by editing GitHub.** A pure queue drifts the moment a human
 * intervenes and never recovers; a reconciler recomputes from scratch every
 * tick, so manual intervention is a first-class input rather than a
 * perturbation it has to be told about.
 *
 * ## Read-only, by construction
 *
 * VISION §12 requires this to run read-only for a week before it is allowed to
 * write. This service therefore imports `GitHubReadModule` and NOT the write
 * module — the guarantee is in the module graph, not in a flag anyone can
 * flip by accident. #48 adds the mirror-label writer, behind its own flag.
 */
@Injectable()
export class ReconcilerService {
  private readonly logger = new Logger(ReconcilerService.name);

  private readonly rateLimitFloor: number;

  /** The most recent tick, for the health endpoint and for #50 to persist. */
  private lastTick: TickRecord | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly lease: TickLeaseService,
    private readonly repositories: RepositoriesService,
    private readonly github: GitHubReadService,
    private readonly http: GitHubHttpService,
    private readonly rateLimit: RateLimitService,
    private readonly prisma: PrismaService,
  ) {
    this.rateLimitFloor = this.config.get<number>('github.rateLimitReserve') ?? 100;
  }

  get lastTickRecord(): TickRecord | null {
    return this.lastTick;
  }

  /**
   * One tick, under the lease.
   *
   * Never throws. A tick that propagated an exception would take down the
   * scheduler's handler and — depending on the runtime — stop the loop
   * entirely, turning one bad repository into a dead factory. Failures are
   * recorded in the returned record instead, which is also what makes them
   * reviewable during the observation week.
   */
  async tick(): Promise<TickRecord> {
    const startedAt = new Date();

    if (!this.enabled) {
      return this.finish(startedAt, 'skipped-disabled', 0, [], true);
    }

    // Checked BEFORE taking the lease: a tick that cannot afford to read
    // should not also block the next one from trying.
    if (!this.http.canSpend()) {
      this.logger.warn(
        `Reconciler tick skipped: GitHub budget at or below the reserve of ${this.rateLimitFloor}`,
      );
      return this.finish(startedAt, 'skipped-rate-limited', 0, [], true);
    }

    const outcome = await this.lease.withLease(() => this.observeAll());

    if (!outcome.acquired) {
      return this.finish(startedAt, 'skipped-locked', 0, [], true);
    }

    const { observed, failures, allFromCache } = outcome.result;
    const status: TickOutcome = failures.length > 0 ? 'partial' : 'completed';
    return this.finish(startedAt, status, observed, failures, allFromCache);
  }

  /**
   * Observe every watched repository.
   *
   * Sequential, not parallel. Parallelism here would multiply the burst rate
   * against a shared rate-limit budget (VISION §11) for no wall-clock benefit
   * a reconciler cares about — a tick that takes four seconds instead of one
   * is fine, and one that trips a secondary rate limit is not.
   */
  private async observeAll(): Promise<{
    observed: number;
    failures: TickFailure[];
    allFromCache: boolean;
  }> {
    const repositories = await this.repositories.listObserved();
    const failures: TickFailure[] = [];
    let observed = 0;
    let allFromCache = true;

    for (const repository of repositories) {
      const name = `${repository.owner}/${repository.name}`;

      // Re-checked per repository, not once per tick: a long sweep can exhaust
      // the budget partway, and continuing would spend the reserve that keeps
      // the operator's own interactive use working.
      if (!this.http.canSpend()) {
        failures.push({ repository: name, reason: 'rate-limit reserve reached; not observed' });
        continue;
      }

      try {
        const result = await this.github.listIssues(
          { owner: repository.owner, name: repository.name },
          { state: 'open' },
        );
        allFromCache = allFromCache && result.allFromCache;
        observed += 1;

        // Recorded so the next tick starts with the repository that has waited
        // longest — `listObserved` orders on this column.
        await this.prisma.repository.update({
          where: { id: repository.id },
          data: { lastObservedAt: new Date() },
        });
      } catch (error) {
        if (error instanceof GitHubRateLimitError) {
          // Not a repository fault. Stop the sweep rather than grinding
          // through the remaining repositories collecting identical errors.
          failures.push({
            repository: name,
            reason: `rate limit exhausted; resets at ${error.resetAt.toISOString()}`,
          });
          break;
        }
        failures.push({
          repository: name,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { observed, failures, allFromCache };
  }

  private finish(
    startedAt: Date,
    outcome: TickOutcome,
    repositoriesObserved: number,
    failures: TickFailure[],
    allFromCache: boolean,
  ): TickRecord {
    const finishedAt = new Date();
    const record: TickRecord = {
      startedAt,
      finishedAt,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      outcome,
      repositoriesObserved,
      failures,
      allFromCache,
      rateLimitRemaining: this.rateLimit.snapshot()?.remaining ?? null,
    };

    this.lastTick = record;

    if (outcome === 'completed') {
      this.logger.log(
        `Tick completed in ${record.durationMs}ms: ${repositoriesObserved} repositories` +
          (allFromCache && repositoriesObserved > 0 ? ' (all from cache, no quota spent)' : ''),
      );
    } else if (outcome === 'partial' || outcome === 'failed') {
      this.logger.warn(
        `Tick ${outcome} in ${record.durationMs}ms: ${repositoriesObserved} observed, ` +
          `${failures.length} failed — ${failures.map((f) => `${f.repository}: ${f.reason}`).join('; ')}`,
      );
    } else {
      this.logger.debug(`Tick ${outcome}`);
    }

    return record;
  }

  private get enabled(): boolean {
    return this.config.get<boolean>('reconciler.enabled') ?? false;
  }
}
