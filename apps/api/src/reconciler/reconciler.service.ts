import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { GitHubRateLimitError } from '../github/github.errors';
import { INPUT_LABELS } from '../github/labels/factory-labels';
import { GitHubHttpService } from '../github/github-http.service';
import { RateLimitService } from '../github/rate-limit.service';
import { GitHubReadService } from '../github/read/github-read.service';
import { PrismaService } from '../prisma/prisma.service';
import { RepositoriesService } from '../repositories/repositories.service';
import type { ReconcileAction } from './diff/actions.types';
import { ReconcileLogService } from './log/reconcile-log.service';
import { computeActions } from './diff/diff-engine';
import { assertNoMirrorLabelsObserved, projectDesiredState } from './projection/desired-state';
import type {
  DesiredState,
  ObservedState,
  ObservedWorkOrder,
} from './projection/desired-state.types';
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
 * ## This service cannot write, and that is still true after #48
 *
 * It depends on the GitHub READ service and on nothing that can write. #48
 * added a mirror-label executor to the module, but not to this class:
 * `ReconcilerTask` calls this to COMPUTE an action list and then hands that
 * list to the executor separately. The component that decides what should
 * happen remains incapable of making it happen, which is the property VISION
 * §12's observation week actually rests on.
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
    private readonly log: ReconcileLogService,
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
    return this.record(await this.runTick());
  }

  /**
   * Persist the tick, then return it.
   *
   * Recording is separated from running so that a storage failure cannot
   * change the tick's own outcome — `ReconcileLogService.record` swallows its
   * errors for the same reason. A tick that reconciled correctly but failed to
   * write its log row is not a failed tick, and reporting it as one would put
   * a phantom reconciler bug in front of whoever reviews the week.
   */
  private async record(tick: TickRecord): Promise<TickRecord> {
    await this.log.record(tick);
    return tick;
  }

  private async runTick(): Promise<TickRecord> {
    const startedAt = new Date();

    if (!this.enabled) {
      return this.finish(startedAt, 'skipped-disabled', 0, [], true, [], []);
    }

    // Checked BEFORE taking the lease: a tick that cannot afford to read
    // should not also block the next one from trying.
    if (!this.http.canSpend()) {
      this.logger.warn(
        `Reconciler tick skipped: GitHub budget at or below the reserve of ${this.rateLimitFloor}`,
      );
      return this.finish(startedAt, 'skipped-rate-limited', 0, [], true, [], []);
    }

    const outcome = await this.lease.withLease(() => this.observeAll());

    if (!outcome.acquired) {
      return this.finish(startedAt, 'skipped-locked', 0, [], true, [], []);
    }

    const { observed, failures, allFromCache, projections, actions } = outcome.result;
    const status: TickOutcome = failures.length > 0 ? 'partial' : 'completed';
    return this.finish(startedAt, status, observed, failures, allFromCache, projections, actions);
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
    projections: DesiredState[];
    actions: ReconcileAction[];
  }> {
    const repositories = await this.repositories.listObserved();
    const failures: TickFailure[] = [];
    const projections: DesiredState[] = [];
    const actions: ReconcileAction[] = [];
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

        // Belt and braces on VISION §3.3: the read adapter already strips
        // mirror labels, and this makes a regression there a loud failure here
        // rather than a quiet feedback loop where Opifex reads its own output.
        assertNoMirrorLabelsObserved(result.issues);

        const workOrders = await this.loadWorkOrders(repository.id);

        const state: ObservedState = {
          repository: {
            id: repository.id,
            owner: repository.owner,
            name: repository.name,
            observeEnabled: repository.observeEnabled,
            dispatchEnabled: repository.dispatchEnabled,
            budgetCeilingUsd: repository.budgetCeilingUsd
              ? Number(repository.budgetCeilingUsd)
              : null,
          },
          issues: result.issues,
          workOrders,
          humanClearedQuarantine: await this.resolveHumanQuarantineClears(
            { owner: repository.owner, name: repository.name },
            result.issues,
            workOrders,
          ),
        };

        const projection = projectDesiredState(state);
        projections.push(projection);

        // Computed, NOT executed. VISION §12: the reconciler runs read-only
        // for a week and the action list with its reasons is what gets
        // reviewed at the end of it. #48 adds the executor, behind its own
        // flag; nothing here can act on these.
        actions.push(...computeActions(state, projection));

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

    return { observed, failures, allFromCache, projections, actions };
  }

  /**
   * Which issues a HUMAN has released from quarantine.
   *
   * ## Why this is a separate read, and why it is narrow
   *
   * VISION §8 puts clearing quarantine on the never-trustable list: "it cannot
   * clear its own quarantine." An agent that can apply
   * `factory:clear-quarantine` to release itself has the appearance of a
   * guardrail and none of the substance — so the load-bearing fact is not that
   * the label is PRESENT but that a human PUT IT THERE.
   *
   * Only the issue timeline carries the applier, and the plain label list does
   * not, which is why this cannot be folded into the issue read. A timeline
   * call per issue would be ruinous against the rate-limit budget (#40), so it
   * is asked only where the answer could possibly matter: an issue that both
   * carries the label AND has a quarantined work order. In a healthy
   * repository that set is empty and this costs nothing.
   *
   * A timeline read that FAILS is treated as "not cleared". Failing closed is
   * the only safe direction here: the cost of being wrong is either a
   * quarantine that stays until the next tick, or one released without a human
   * — and VISION §8 is unambiguous about which of those is unacceptable.
   */
  private async resolveHumanQuarantineClears(
    repo: { owner: string; name: string },
    issues: { number: number; inputLabels: string[] }[],
    workOrders: ObservedWorkOrder[],
  ): Promise<Set<number>> {
    const quarantined = new Set(
      workOrders.filter((w) => w.status === 'quarantined').map((w) => w.issueNumber),
    );

    const candidates = issues.filter(
      (issue) =>
        quarantined.has(issue.number) &&
        issue.inputLabels.includes(INPUT_LABELS.CLEAR_QUARANTINE),
    );

    const cleared = new Set<number>();
    for (const issue of candidates) {
      try {
        const byHuman = await this.github.wasLabelAppliedByHuman(
          repo,
          issue.number,
          INPUT_LABELS.CLEAR_QUARANTINE,
        );
        if (byHuman) {
          cleared.add(issue.number);
        } else {
          this.logger.warn(
            `Refusing to clear quarantine on ${repo.owner}/${repo.name}#${issue.number}: ` +
              `${INPUT_LABELS.CLEAR_QUARANTINE} is present but was not applied by a human ` +
              `(VISION §8 — a run cannot clear its own quarantine)`,
          );
        }
      } catch (error) {
        // Fail closed, loudly.
        this.logger.warn(
          `Could not verify who applied ${INPUT_LABELS.CLEAR_QUARANTINE} on ` +
            `${repo.owner}/${repo.name}#${issue.number}; leaving it quarantined: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return cleared;
  }

  /**
   * This repository's work orders, reduced to what the projection reads.
   *
   * Selected rather than loaded whole: the projection is a pure function over
   * plain data, and handing it Prisma models would couple it to the client and
   * make an offline fixture impossible to build.
   */
  private async loadWorkOrders(repositoryId: string): Promise<ObservedWorkOrder[]> {
    const workOrders = await this.prisma.workOrder.findMany({
      where: { repositoryId },
      select: {
        id: true,
        identity: true,
        issueNumber: true,
        attempt: true,
        status: true,
        runs: {
          // The newest run is the live one; earlier runs on the same work
          // order are history the projection does not act on.
          orderBy: { startedAt: 'desc' },
          take: 1,
          select: { id: true, status: true, costUsd: true, pullRequestUrl: true },
        },
      },
    });

    return workOrders.map((workOrder) => ({
      id: workOrder.id,
      identity: workOrder.identity,
      issueNumber: workOrder.issueNumber,
      attempt: workOrder.attempt,
      status: workOrder.status,
      run: workOrder.runs[0]
        ? {
            id: workOrder.runs[0].id,
            status: workOrder.runs[0].status,
            costUsd: workOrder.runs[0].costUsd ? Number(workOrder.runs[0].costUsd) : null,
            pullRequestUrl: workOrder.runs[0].pullRequestUrl,
          }
        : null,
    }));
  }

  private finish(
    startedAt: Date,
    outcome: TickOutcome,
    repositoriesObserved: number,
    failures: TickFailure[],
    allFromCache: boolean,
    projections: DesiredState[],
    actions: ReconcileAction[],
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
      projections,
      actions,
    };

    this.lastTick = record;

    if (outcome === 'completed') {
      this.logger.log(
        `Tick completed in ${record.durationMs}ms: ${repositoriesObserved} repositories, ` +
          `${actions.length} actions computed (none executed)` +
          (allFromCache && repositoriesObserved > 0 ? ', all from cache' : ''),
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
