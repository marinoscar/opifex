import { createHash } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

import { INPUT_LABELS } from '../github/labels/factory-labels';
import type { NormalizedIssue } from '../github/read/github-read.types';
import { PrismaService } from '../prisma/prisma.service';
import { projectIssue, type SkipReason } from './issue-projection';
import type { GeneratedWorkOrder } from './work-order-generator';
import type { CriteriaProblem } from './acceptance-criteria';

/**
 * Turns projected work orders into rows.
 *
 * The projection itself (`issue-projection.ts`) is pure. This is the half that
 * touches the database, kept separate for the reason #46 separates compute
 * from apply: a projection that could write cannot be run during the
 * observation week to find out what it *would* have produced.
 */

/** The columns this needs from a work order that already exists. */
export interface ExistingWorkOrder {
  id: string;
  issueNumber: number;
  status: string;
}

export interface ProjectionInput {
  repository: {
    id: string;
    owner: string;
    name: string;
    budgetCeilingUsd: number | null;
    wallClockTimeoutMinutes?: number | null;
  };
  issues: NormalizedIssue[];
  /**
   * Work orders this repository already has, passed in by the caller.
   *
   * The tick has loaded them already for the desired-state projection, and
   * asking again would be a second query per repository for an answer it is
   * holding. Structurally typed so this service still does not depend on the
   * reconciler.
   */
  existingWorkOrders: ExistingWorkOrder[];
  /**
   * The repository's current HEAD, resolved once by the caller.
   *
   * Once per repository rather than once per issue, and pinned onto every work
   * order this pass creates: #62 requires the base commit be fixed at
   * generation, and resolving it per issue would mean two issues projected in
   * the same tick could disagree about what "now" was.
   */
  baseCommit: string;
}

export interface RejectedIssue {
  issueNumber: number;
  problems: CriteriaProblem[];
  message: string;
  /**
   * SHA-256 of the body the rejection was computed from.
   *
   * Carried so the caller can tell "I have already said this" from "they
   * edited it and it is still wrong" without re-reading the issue.
   */
  bodyDigest: string;
}

export interface ProjectionResult {
  /** Work orders written by this pass. */
  created: GeneratedWorkOrder[];
  /** Written with status `held` rather than `queued`. A subset of `created`. */
  heldOnCreate: number;
  /** Eligible, and already stored — the ordinary case on a repeat tick. */
  alreadyPresent: number;
  /** Existing rows whose hold was applied or lifted between ticks. */
  holdsApplied: number;
  holdsLifted: number;
  /** Candidates whose spec was not good enough. Destined for a comment. */
  rejected: RejectedIssue[];
  /** Issues that were never candidates, by why. */
  skipped: Record<SkipReason, number>;
}

/**
 * Statuses this pass is allowed to move between.
 *
 * Nothing else is touched. A `dispatched` work order has a run against it and
 * an authorization record posted for it; flipping that to `held` because a
 * label appeared would make the record describe something that is no longer
 * true, which is the one thing #63 exists to prevent. Stopping a run in flight
 * is a cancel (#66), not a status edit.
 */
const HOLDABLE_STATUSES = new Set(['queued', 'held']);

@Injectable()
export class WorkOrderProjectionService {
  private readonly logger = new Logger(WorkOrderProjectionService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Is there an issue here that would need a base commit resolved for it?
   *
   * Resolving the repository's HEAD is a GitHub request, and VISION §11 holds
   * back a rate-limit reserve so the operator's own interactive use keeps
   * working. In a steady-state repository every ready issue already has a work
   * order, so the honest answer is almost always "no" and the request is never
   * spent — which is what makes running this on every 60-second tick
   * affordable at all.
   *
   * The eligibility half of the check is the same one `projectIssue` applies,
   * deliberately: a cheap pre-filter that disagreed with the real gate would
   * either skip work or spend the request anyway.
   */
  static needsBaseCommit(
    issues: NormalizedIssue[],
    existingWorkOrders: ExistingWorkOrder[],
  ): boolean {
    const known = new Set(
      existingWorkOrders.map((workOrder) => workOrder.issueNumber),
    );

    return issues.some(
      (issue) =>
        issue.state === 'open' &&
        issue.inputLabels.includes(INPUT_LABELS.READY) &&
        !known.has(issue.number),
    );
  }

  /**
   * Project one repository's issues, persisting what is eligible.
   *
   * Never throws for one bad issue. A repository with fifty issues and one
   * that trips a parser must still produce the other forty-nine — the
   * alternative is a single malformed body stopping the factory.
   */
  async project(input: ProjectionInput): Promise<ProjectionResult> {
    const result: ProjectionResult = {
      created: [],
      heldOnCreate: 0,
      alreadyPresent: 0,
      holdsApplied: 0,
      holdsLifted: 0,
      rejected: [],
      skipped: emptySkipCounts(),
    };

    const known = new Map(
      input.existingWorkOrders.map((workOrder) => [
        workOrder.issueNumber,
        workOrder,
      ]),
    );

    for (const issue of input.issues) {
      try {
        await this.projectOne(input, issue, known, result);
      } catch (error) {
        this.logger.error(
          `Could not project ${input.repository.owner}/${input.repository.name}#${issue.number}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (result.created.length > 0 || result.rejected.length > 0) {
      this.logger.log(
        `${input.repository.owner}/${input.repository.name}: ` +
          `${result.created.length} work order(s) created` +
          (result.heldOnCreate > 0 ? ` (${result.heldOnCreate} held)` : '') +
          `, ${result.alreadyPresent} already present, ${result.rejected.length} rejected`,
      );
    }
    if (result.holdsApplied > 0 || result.holdsLifted > 0) {
      this.logger.log(
        `${input.repository.owner}/${input.repository.name}: ` +
          `${result.holdsApplied} work order(s) held, ${result.holdsLifted} released`,
      );
    }

    return result;
  }

  private async projectOne(
    input: ProjectionInput,
    issue: NormalizedIssue,
    known: Map<number, ExistingWorkOrder>,
    result: ProjectionResult,
  ): Promise<void> {
    const existing = known.get(issue.number);

    // ## An issue with a work order is never projected again
    //
    // #155 left this open: *"whether that is desirable on every push to the
    // default branch is a policy question worth answering explicitly rather
    // than falling into."* Answering it: **no.**
    //
    // The identity is content-addressed over `(repo, issue, baseCommit,
    // attempt)`, so re-projecting at the current HEAD mints a NEW work order
    // every time the default branch moves. On a repository that merges twenty
    // times a day, every ready issue would accumulate twenty authorizations a
    // day and — once dispatch is on — twenty runs. That is not a queue filling
    // up, it is a bill.
    //
    // So the base commit pins when the issue is FIRST projected and one live
    // work order per issue is the invariant. Re-running deliberately is #66's
    // job: it bumps `attempt`, which is the other axis the identity carries,
    // and which a human or a retry policy chooses rather than a merge.
    //
    // This is strictly stronger than the acceptance criterion ("no second row
    // at the current base commit") and it is stronger on purpose — the weaker
    // rule is satisfied by exactly the behaviour that produces the bill.
    if (existing) {
      if (HOLDABLE_STATUSES.has(existing.status)) {
        await this.reconcileHold(existing, issue, result);
      }
      result.alreadyPresent += 1;
      return;
    }

    const projected = projectIssue({
      issue,
      repository: {
        owner: input.repository.owner,
        name: input.repository.name,
      },
      baseCommit: input.baseCommit,
      budgetCeilingUsd: input.repository.budgetCeilingUsd,
      wallClockTimeoutMinutes: input.repository.wallClockTimeoutMinutes ?? null,
    });

    if (!projected.eligible) {
      if (projected.reason === 'rejected') {
        result.rejected.push({
          issueNumber: issue.number,
          problems: projected.problems,
          message: projected.message,
          bodyDigest: digestOf(issue.body ?? ''),
        });
      } else {
        result.skipped[projected.reason] += 1;
      }
      return;
    }

    const written = await this.persist(
      input.repository.id,
      projected.workOrder,
      projected.held,
    );
    if (written) {
      result.created.push(projected.workOrder);
      if (projected.held) result.heldOnCreate += 1;
    } else {
      result.alreadyPresent += 1;
    }
  }

  /**
   * Move an untouched work order between `queued` and `held`.
   *
   * A hold applied after the work order exists has to reach the row, or the
   * label would be a suggestion. VISION §4's promise is that *you can always
   * fix the factory by editing GitHub* — a `factory:hold` that only worked if
   * you applied it before the tick that created the work order would make that
   * false in the one case where somebody is urgently trying to stop something.
   *
   * The reverse direction matters as much: a hold that could be applied and
   * never lifted is a trap, and the row would sit held forever while the label
   * said otherwise.
   *
   * Only `queued` and `held` move. See {@link HOLDABLE_STATUSES}.
   */
  private async reconcileHold(
    existing: ExistingWorkOrder,
    issue: NormalizedIssue,
    result: ProjectionResult,
  ): Promise<void> {
    const shouldHold = issue.inputLabels.includes(INPUT_LABELS.HOLD);
    const isHeld = existing.status === 'held';
    if (shouldHold === isHeld) return;

    await this.prisma.workOrder.update({
      where: { id: existing.id },
      data: shouldHold
        ? { status: 'held', queuedAt: null }
        : { status: 'queued', queuedAt: new Date() },
    });

    if (shouldHold) result.holdsApplied += 1;
    else result.holdsLifted += 1;
  }

  /**
   * Write the row, or leave the existing one exactly as it is.
   *
   * ## Why an existing row is never updated
   *
   * The identity is content-addressed over `(repo, issue, baseCommit, attempt)`
   * (#62), so the same identity is meant to be the same work. It is not
   * guaranteed to be: an author can edit an issue body without the base commit
   * moving, and the next tick would project different prose under the same
   * identity.
   *
   * Updating would be the wrong answer. #63 posted an authorization record for
   * the document as it was, and rewriting the row underneath it means the
   * record and the row diverge silently — which is precisely the thing #63
   * exists to make impossible. **The authorized thing is the stored thing.**
   * An author who wants different work gets a different work order, which is
   * what moving the base commit or bumping the attempt already produces.
   *
   * Returns true when a row was created, false when one was already there.
   */
  private async persist(
    repositoryId: string,
    workOrder: GeneratedWorkOrder,
    held: boolean,
  ): Promise<boolean> {
    const existing = await this.prisma.workOrder.findUnique({
      where: { identity: workOrder.identity },
      select: { id: true },
    });
    if (existing) return false;

    try {
      await this.prisma.workOrder.create({
        data: {
          identity: workOrder.identity,
          repositoryId,
          issueNumber: workOrder.issueNumber,
          issueUrl: workOrder.issueUrl,
          issueTitle: workOrder.issueTitle,
          baseCommit: workOrder.baseCommit,
          attempt: workOrder.attempt,
          branch: workOrder.branch,
          status: held ? 'held' : 'queued',
          // Null while held. `queuedAt` orders the dispatch queue, and a held
          // work order stamped with a queue time would take priority over work
          // that has actually been waiting once the hold lifts.
          queuedAt: held ? null : new Date(),
          taskSpec: workOrder.taskSpec,
          acceptanceCriteria: workOrder.acceptanceCriteria,
          pathConstraints: workOrder.pathConstraints,
          decisionRefs: workOrder.decisionRefs,
          needs: workOrder.needs,
          // `?? null` rather than omitted: absent and null mean the same thing
          // here (the runner's own default), and writing it explicitly keeps
          // the column's meaning identical to the wire contract's.
          modelTier: workOrder.modelTier ?? null,
          budgetCeilingUsd: workOrder.budgetCeilingUsd,
          wallClockTimeoutMinutes: workOrder.wallClockTimeoutMinutes,
        },
      });
      return true;
    } catch (error) {
      // Two ticks racing on the same identity. The unique constraint is the
      // real guard — the read above is only an optimisation — so losing the
      // race is the correct outcome rather than an error.
      if (isUniqueViolation(error)) {
        this.logger.debug(
          `${workOrder.identity} was created concurrently; keeping the winner`,
        );
        return false;
      }
      throw error;
    }
  }
}

/** What the author's body was, reduced to something comparable. */
export function digestOf(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === 'P2002'
  );
}

function emptySkipCounts(): Record<SkipReason, number> {
  return {
    'not-open': 0,
    'not-marked-ready': 0,
    'no-body': 0,
    'missing-task-spec': 0,
    'missing-acceptance-criteria': 0,
  };
}
