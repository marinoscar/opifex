import { Injectable, Logger } from '@nestjs/common';

import { GitHubRateLimitError } from '../github/github.errors';
import { INPUT_LABELS } from '../github/labels/factory-labels';
import { GitHubHttpService } from '../github/github-http.service';
import { RateLimitService } from '../github/rate-limit.service';
import { GitHubReadService } from '../github/read/github-read.service';
import type { RepositoryRef } from '../github/read/github-read.service';
import { PrismaService } from '../prisma/prisma.service';
import { RepositoriesService } from '../repositories/repositories.service';
import { OperatorSettingsService } from '../settings/operator-settings/operator-settings.service';
import type { ReconcileAction } from './diff/actions.types';
import { ReconcileLogService } from './log/reconcile-log.service';
import { computeActions } from './diff/diff-engine';
import {
  assertNoMirrorLabelsObserved,
  projectDesiredState,
} from './projection/desired-state';
import type {
  CheckVerdict,
  DesiredState,
  ObservedState,
  ObservedWorkOrder,
} from './projection/desired-state.types';
import type {
  TickFailure,
  TickRecord,
  TickOutcome,
  TickRejection,
  TickSettings,
} from './reconciler.types';
import { summarizeChecks } from './projection/check-verdict';
import { TickLeaseService } from './tick-lease.service';
import { WorkOrderProjectionService } from '../work-orders/work-order-projection.service';

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
 *
 * "Cannot write" means **cannot write to GitHub**, which is the boundary that
 * matters: it is the one an observation week is observing. This service does
 * write to its own database — `lastObservedAt`, and since #155 the work orders
 * it projects — because those are the tick's own bookkeeping. A queued work
 * order is inert without `DISPATCH_ENABLED`, and seeing what the factory WOULD
 * work on is precisely the artifact VISION §12 asks the week to produce. The
 * rejection comments those projections imply are the outward half, and they
 * leave on the tick record for `ReconcilerTask` to post.
 */
@Injectable()
export class ReconcilerService {
  private readonly logger = new Logger(ReconcilerService.name);

  /** The most recent tick, for the health endpoint and for #50 to persist. */
  private lastTick: TickRecord | null = null;

  constructor(
    private readonly settings: OperatorSettingsService,
    private readonly lease: TickLeaseService,
    private readonly repositories: RepositoriesService,
    private readonly github: GitHubReadService,
    private readonly http: GitHubHttpService,
    private readonly rateLimit: RateLimitService,
    private readonly prisma: PrismaService,
    private readonly log: ReconcileLogService,
    private readonly workOrders: WorkOrderProjectionService,
  ) {}

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
    const id = await this.log.record(tick);

    // The row's id travels back out on the record so that `ReconcilerTask`
    // can return to it and record what the tick actually EXECUTED (#317).
    // That number cannot be produced here and must not be: this service has
    // no write capability, which is the property the observation week rests
    // on. It ends up on the record without ever passing through the component
    // that computed it.
    return id === null ? tick : { ...tick, id };
  }

  private async runTick(): Promise<TickRecord> {
    const startedAt = new Date();

    // The one settings reading on this path, and the reason it is here rather
    // than in the constructor: see `TickSettings`. Every decision this tick
    // makes is taken against this snapshot, so the projection — which is pure
    // and takes these as inputs — receives already-settled facts, exactly as
    // `DispatchService.decide` hands `decideDispatch` a single `now`.
    //
    // Read BEFORE the enablement check, so that even a tick which does nothing
    // records the configuration it declined under.
    const settings = this.snapshotSettings();

    if (!this.enabled) {
      return this.finish(
        startedAt,
        'skipped-disabled',
        nothingObserved(),
        settings,
      );
    }

    // Checked BEFORE taking the lease: a tick that cannot afford to read
    // should not also block the next one from trying.
    if (!this.http.canSpend()) {
      this.logger.warn(
        `Reconciler tick skipped: GitHub budget at or below the reserve of ` +
          `${settings.rateLimitReserve}`,
      );
      return this.finish(
        startedAt,
        'skipped-rate-limited',
        nothingObserved(),
        settings,
      );
    }

    const outcome = await this.lease.withLease(() => this.observeAll(settings));

    if (!outcome.acquired) {
      return this.finish(
        startedAt,
        'skipped-locked',
        nothingObserved(),
        settings,
      );
    }

    const status: TickOutcome =
      outcome.result.failures.length > 0 ? 'partial' : 'completed';
    return this.finish(startedAt, status, outcome.result, settings);
  }

  /**
   * Every managed setting this tick's computation depends on, in one read.
   *
   * Taken once per tick and threaded onward as a value, rather than re-read
   * where each is used. Re-reading would reintroduce the exact fault the old
   * constructor-scoped fields were defending against — two identical
   * observations producing different desired states because the ceiling moved
   * between the projection and the diff — while the per-tick boundary keeps
   * that defence and still lets the next tick see an operator's edit, with no
   * restart. `TickSettings` carries the full argument.
   */
  private snapshotSettings(): TickSettings {
    return {
      retryCeiling: this.settings.get('dispatch.retryCeiling'),
      rateLimitReserve: this.settings.get('github.rateLimitReserve'),
      writesEnabled: this.settings.get('github.writesEnabled'),
    };
  }

  /**
   * Observe every watched repository.
   *
   * Sequential, not parallel. Parallelism here would multiply the burst rate
   * against a shared rate-limit budget (VISION §11) for no wall-clock benefit
   * a reconciler cares about — a tick that takes four seconds instead of one
   * is fine, and one that trips a secondary rate limit is not.
   *
   * Takes the tick's settings rather than reading them: every repository in
   * one sweep must be projected against the same ceiling, or a `PATCH` landing
   * mid-sweep would quarantine the repositories at the end of the list under
   * rules the ones at the front never saw.
   */
  private async observeAll(settings: TickSettings): Promise<SweepResult> {
    const repositories = await this.repositories.listObserved();
    const failures: TickFailure[] = [];
    const projections: DesiredState[] = [];
    const actions: ReconcileAction[] = [];
    const rejections: TickRejection[] = [];
    let observed = 0;
    let allFromCache = true;
    let workOrdersCreated = 0;

    for (const repository of repositories) {
      const name = `${repository.owner}/${repository.name}`;

      // Re-checked per repository, not once per tick: a long sweep can exhaust
      // the budget partway, and continuing would spend the reserve that keeps
      // the operator's own interactive use working.
      if (!this.http.canSpend()) {
        failures.push({
          repository: name,
          reason: 'rate-limit reserve reached; not observed',
        });
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

        const workOrders = await this.loadWorkOrders(repository.id, {
          owner: repository.owner,
          name: repository.name,
        });

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
          retryCeiling: settings.retryCeiling,
        };

        const projection = projectDesiredState(state);
        projections.push(projection);

        // Computed, NOT executed. VISION §12: the reconciler runs read-only
        // for a week and the action list with its reasons is what gets
        // reviewed at the end of it. #48 adds the executor, behind its own
        // flag; nothing here can act on these.
        actions.push(...computeActions(state, projection));

        // Turn eligible issues into work orders. AFTER the desired-state
        // projection above, deliberately: that projection reads the work
        // orders as they were at the start of the tick, and a row created
        // mid-tick would make its conclusions describe a state that did not
        // exist when it observed. The new work order is picked up by the next
        // tick, which is what a reconciler recomputing from scratch means.
        const projected = await this.projectWorkOrders(
          repository,
          state.issues,
          workOrders,
        );
        workOrdersCreated += projected.created;
        rejections.push(...projected.rejections);

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

    return {
      observed,
      failures,
      allFromCache,
      projections,
      actions,
      workOrdersCreated,
      rejections,
    };
  }

  /**
   * Turn this repository's eligible issues into work order rows.
   *
   * ## Why the base commit is resolved here and not per issue
   *
   * #62 requires the base commit be pinned at generation and never resolved
   * later. Resolving it once per repository — rather than once per issue —
   * additionally means two issues projected in the same tick cannot disagree
   * about what "now" was, which would otherwise be a race that only shows up
   * on a repository someone is actively merging into.
   *
   * ## Why it is often not resolved at all
   *
   * It costs a GitHub request, and VISION §11 holds a rate-limit reserve back
   * for the operator's own interactive use. In the steady state every ready
   * issue already has a work order, so `needsBaseCommit` is false and this
   * whole pass costs nothing — which is what makes running it on a 60-second
   * tick affordable rather than a slow leak of the reserve.
   *
   * ## Never throws
   *
   * A repository whose HEAD cannot be resolved still observed fine, and
   * failing the tick over it would take down the reconciliation of every
   * repository behind it in the sweep. The reason is logged and the next tick
   * tries again — there is nothing to lose by waiting 60 seconds.
   */
  private async projectWorkOrders(
    repository: {
      id: string;
      owner: string;
      name: string;
      defaultBranch: string;
      budgetCeilingUsd: unknown;
      wallClockTimeoutMinutes: number | null;
      specFeedbackEnabled: boolean;
    },
    issues: ObservedState['issues'],
    existingWorkOrders: ObservedWorkOrder[],
  ): Promise<{ created: number; rejections: TickRejection[] }> {
    const nothing = { created: 0, rejections: [] as TickRejection[] };

    if (!WorkOrderProjectionService.needsBaseCommit(issues, existingWorkOrders))
      return nothing;

    try {
      const baseCommit = await this.resolveHead(repository);
      if (!baseCommit) return nothing;

      const result = await this.workOrders.project({
        repository: {
          id: repository.id,
          owner: repository.owner,
          name: repository.name,
          budgetCeilingUsd: repository.budgetCeilingUsd
            ? Number(repository.budgetCeilingUsd)
            : null,
          wallClockTimeoutMinutes: repository.wallClockTimeoutMinutes,
        },
        issues,
        existingWorkOrders,
        baseCommit,
      });

      return {
        created: result.created.length,
        rejections: result.rejected.map((rejected) => ({
          ...rejected,
          repository: {
            id: repository.id,
            owner: repository.owner,
            name: repository.name,
          },
          feedbackEnabled: repository.specFeedbackEnabled,
        })),
      };
    } catch (error) {
      this.logger.error(
        `Could not project work orders for ${repository.owner}/${repository.name}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return nothing;
    }
  }

  /**
   * The tip of the default branch.
   *
   * Null rather than a throw when the branch comes back empty: a repository
   * with no commits at all is a real thing (one just created), and it is not
   * an error — there is simply nothing to base work on yet.
   */
  private async resolveHead(repository: {
    owner: string;
    name: string;
    defaultBranch: string;
  }): Promise<string | null> {
    const commits = await this.github.listCommits(
      { owner: repository.owner, name: repository.name },
      { branch: repository.defaultBranch, maxPages: 1 },
    );

    const head = commits[0]?.sha;
    if (!head) {
      this.logger.warn(
        `${repository.owner}/${repository.name} has no commits on ${repository.defaultBranch}; ` +
          `nothing to pin a work order to`,
      );
      return null;
    }
    return head;
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
      workOrders
        .filter((w) => w.status === 'quarantined')
        .map((w) => w.issueNumber),
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
  private async loadWorkOrders(
    repositoryId: string,
    repo: RepositoryRef,
  ): Promise<ObservedWorkOrder[]> {
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
          select: {
            id: true,
            status: true,
            costUsd: true,
            pullRequestUrl: true,
            // The commit CI reported on. Without it there is nothing to ask
            // GitHub about, so a run missing it stays `pending` (#107).
            headCommit: true,
          },
        },
      },
    });

    return Promise.all(
      workOrders.map(async (workOrder) => {
        const run = workOrder.runs[0];
        return {
          id: workOrder.id,
          identity: workOrder.identity,
          issueNumber: workOrder.issueNumber,
          attempt: workOrder.attempt,
          status: workOrder.status,
          run: run
            ? {
                id: run.id,
                status: run.status,
                costUsd: run.costUsd ? Number(run.costUsd) : null,
                pullRequestUrl: run.pullRequestUrl,
                checks: await this.resolveChecks(repo, run),
              }
            : null,
        };
      }),
    );
  }

  /**
   * CI's verdict on a run's pull request (#107).
   *
   * Asked here rather than in the projection because it is a GitHub read, and
   * the projection performs no I/O — the same reason `humanClearedQuarantine`
   * is resolved during observation.
   *
   * Only for runs that actually produced a pull request. Everything else has
   * nothing to gate: `null` means "not applicable", and the projection treats
   * it the same as `pending` at the one place it matters.
   */
  private async resolveChecks(
    repo: RepositoryRef,
    run: {
      status: string;
      pullRequestUrl: string | null;
      headCommit: string | null;
    },
  ): Promise<CheckVerdict | null> {
    if (run.status !== 'succeeded' || !run.pullRequestUrl) return null;

    // No head commit means nothing to ask about. Pending rather than passing:
    // the gate's failure mode has to be "hold", never "surface anyway".
    if (!run.headCommit) return 'pending';

    try {
      return summarizeChecks(
        await this.github.listChecks(repo, run.headCommit),
      );
    } catch (error) {
      // A failed read is not a green light. #107 makes green CI a HARD gate,
      // and a gate that opens when it cannot see is not one.
      this.logger.warn(
        `Could not read checks for ${run.pullRequestUrl}; holding it back from ` +
          `review until the next tick can: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 'pending';
    }
  }

  private finish(
    startedAt: Date,
    outcome: TickOutcome,
    sweep: SweepResult,
    settings: TickSettings,
  ): TickRecord {
    const {
      observed: repositoriesObserved,
      failures,
      allFromCache,
      projections,
      actions,
      workOrdersCreated,
      rejections,
    } = sweep;
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
      settings,
      projections,
      workOrdersCreated,
      rejections,
      actions,
    };

    this.lastTick = record;

    if (outcome === 'completed') {
      this.logger.log(
        `Tick completed in ${record.durationMs}ms: ${repositoriesObserved} repositories, ` +
          `${actions.length} actions computed (none executed)` +
          (workOrdersCreated > 0
            ? `, ${workOrdersCreated} work order(s) created`
            : '') +
          (rejections.length > 0
            ? `, ${rejections.length} spec rejection(s)`
            : '') +
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
    return this.settings.get('reconciler.enabled');
  }
}

/** What one sweep of every observed repository produced. */
interface SweepResult {
  observed: number;
  failures: TickFailure[];
  allFromCache: boolean;
  projections: DesiredState[];
  actions: ReconcileAction[];
  workOrdersCreated: number;
  rejections: TickRejection[];
}

/**
 * A sweep that never ran.
 *
 * `allFromCache: true` because a tick that read nothing spent nothing, which
 * is what that flag measures (#40). Reporting false would make a disabled or
 * locked-out reconciler look like it was burning rate-limit budget.
 */
function nothingObserved(): SweepResult {
  return {
    observed: 0,
    failures: [],
    allFromCache: true,
    projections: [],
    actions: [],
    workOrdersCreated: 0,
    rejections: [],
  };
}
