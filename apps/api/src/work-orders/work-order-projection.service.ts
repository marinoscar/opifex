import { Injectable, Logger } from '@nestjs/common';

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
}

export interface ProjectionResult {
  /** Work orders written by this pass. */
  created: GeneratedWorkOrder[];
  /** Eligible, and already stored — the ordinary case on a repeat tick. */
  alreadyPresent: number;
  /** Candidates whose spec was not good enough. Destined for a comment. */
  rejected: RejectedIssue[];
  /** Issues that were never candidates, by why. */
  skipped: Record<SkipReason, number>;
}

@Injectable()
export class WorkOrderProjectionService {
  private readonly logger = new Logger(WorkOrderProjectionService.name);

  constructor(private readonly prisma: PrismaService) {}

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
      alreadyPresent: 0,
      rejected: [],
      skipped: emptySkipCounts(),
    };

    for (const issue of input.issues) {
      try {
        await this.projectOne(input, issue, result);
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
          `${result.created.length} work order(s) created, ${result.alreadyPresent} already ` +
          `present, ${result.rejected.length} rejected`,
      );
    }

    return result;
  }

  private async projectOne(
    input: ProjectionInput,
    issue: NormalizedIssue,
    result: ProjectionResult,
  ): Promise<void> {
    const projected = projectIssue({
      issue,
      repository: { owner: input.repository.owner, name: input.repository.name },
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
        });
      } else {
        result.skipped[projected.reason] += 1;
      }
      return;
    }

    const written = await this.persist(input.repository.id, projected.workOrder);
    if (written) result.created.push(projected.workOrder);
    else result.alreadyPresent += 1;
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
  private async persist(repositoryId: string, workOrder: GeneratedWorkOrder): Promise<boolean> {
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
          // Eligible and unheld — `projectIssue` already refused a held issue,
          // so reaching here means nothing is withholding it.
          status: 'queued',
          queuedAt: new Date(),
          taskSpec: workOrder.taskSpec,
          acceptanceCriteria: workOrder.acceptanceCriteria,
          pathConstraints: workOrder.pathConstraints,
          decisionRefs: workOrder.decisionRefs,
          needs: workOrder.needs,
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
        this.logger.debug(`${workOrder.identity} was created concurrently; keeping the winner`);
        return false;
      }
      throw error;
    }
  }
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
    held: 0,
    'no-body': 0,
    'missing-task-spec': 0,
    'missing-acceptance-criteria': 0,
  };
}
