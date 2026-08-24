import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';

import { toNumberOrNull } from '../../common/decimal';
import { PrismaService } from '../../prisma/prisma.service';
import { ACTION_CLASSES, isActionClass } from '../action-classes';
import type {
  ActionClassApprovalRate,
  InvocationDraft,
  ProposalDraft,
  ProposalReview,
} from './decision-log.types';

/**
 * The supervisor decision log (#90) — the entire deliverable of Phase 6.
 *
 * VISION §7's promotion ladder starts at rung 1: "the supervisor writes
 * proposals to a decision log and executes nothing." Without the log there is
 * no evidence, and without evidence promotion is a guess dressed as a process.
 *
 * ## What this class cannot do
 *
 * It writes two tables and reads them back. It holds no GitHub client, no
 * dispatcher, no runner registry — and `SupervisorModule` imports nothing that
 * could supply one. #90 requires execution be "structurally impossible, not
 * merely unimplemented", so the capability is absent from the module graph
 * rather than merely unused here. `supervisor-isolation.spec.ts` asserts that
 * as a property of the source, because a comment saying "do not add an
 * executor" is exactly the kind of instruction that loses to a convenient
 * afternoon.
 *
 * ## Every invocation writes a row
 *
 * Including one that proposed nothing, and including one that never ran at all
 * because the supervisor was disabled or quota was scarce. A log with gaps
 * cannot be reviewed: a missing entry is indistinguishable from an invocation
 * that silently failed, and the whole point of the observation window is
 * knowing which.
 */
@Injectable()
export class DecisionLogService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Record one invocation and everything it proposed or declined to propose.
   *
   * Written in a TRANSACTION. A proposal whose invocation row is missing has
   * no snapshot, and #88 makes the snapshot the answer to "what did it
   * actually know?" — a half-written log entry is worse than no entry, because
   * it looks like evidence.
   */
  async record(
    invocation: InvocationDraft,
    proposals: readonly ProposalDraft[] = [],
  ): Promise<{ invocationId: string; proposalIds: string[] }> {
    for (const proposal of proposals) {
      // Validated at the boundary, per ADR-0011. An unknown class silently
      // opens a new measurement bin with one sample in it, and nothing fails
      // until promotion depends on the number.
      if (!isActionClass(proposal.actionClass)) {
        throw new BadRequestException(
          `Unknown action class "${proposal.actionClass}". The taxonomy is ` +
            'apps/api/src/supervisor/action-classes.ts (ADR-0011).',
        );
      }
    }

    const durationMs = Math.max(
      0,
      invocation.finishedAt.getTime() - invocation.startedAt.getTime(),
    );

    return this.prisma.$transaction(async (tx) => {
      const created = await tx.supervisorInvocation.create({
        data: {
          startedAt: invocation.startedAt,
          finishedAt: invocation.finishedAt,
          durationMs,
          outcome: invocation.outcome,
          model: invocation.model,
          snapshotText: invocation.snapshotText,
          snapshotHash: hashSnapshot(invocation.snapshotText),
          snapshotGeneratedAt: invocation.snapshotGeneratedAt ?? null,
          snapshotTruncated: invocation.snapshotTruncated ?? false,
          snapshotCharacters:
            invocation.snapshotCharacters ?? invocation.snapshotText.length,
          costUsd: invocation.costUsd ?? null,
          tokensInput: invocation.tokensInput ?? null,
          tokensOutput: invocation.tokensOutput ?? null,
          failureReason: invocation.failureReason ?? null,
        },
        select: { id: true },
      });

      const proposalIds: string[] = [];
      for (const proposal of proposals) {
        const row = await tx.supervisorProposal.create({
          data: {
            invocationId: created.id,
            actionClass: proposal.actionClass,
            outcome: proposal.outcome,
            summary: proposal.summary,
            reasoning: proposal.reasoning,
            targetKind: proposal.targetKind ?? null,
            targetRef: proposal.targetRef ?? null,
            details:
              proposal.details === undefined
                ? undefined
                : (proposal.details as never),
          },
          select: { id: true },
        });
        proposalIds.push(row.id);
      }

      return { invocationId: created.id, proposalIds };
    });
  }

  /**
   * Record whether a proposal would have been approved.
   *
   * The Phase 6 measurement, and the only mutation a human makes to the log. A
   * verdict can be CHANGED — a reviewer who marks the wrong row should not
   * have to live with it — but the row itself is never rewritten: `summary`,
   * `reasoning` and the snapshot behind them are what was proposed, and
   * editing those would make the approval rate a measurement of hindsight.
   */
  async review(
    id: string,
    verdict: Exclude<ProposalReview, 'pending'>,
    reviewedById: string | null,
    note?: string,
  ): Promise<void> {
    const updated = await this.prisma.supervisorProposal.updateMany({
      where: { id },
      data: {
        review: verdict,
        reviewedAt: new Date(),
        reviewedById,
        reviewNote: note ?? null,
      },
    });

    if (updated.count === 0) {
      throw new NotFoundException(`No supervisor proposal with id ${id}`);
    }
  }

  /**
   * Per action class, the fraction of proposals a human would have approved.
   *
   * VISION §7 rung 2, and the input to promotion. Three counts are kept apart
   * on purpose — proposed, declined, and unreviewed — because collapsing any
   * two of them produces a number that reads as evidence and is not:
   *
   *  - Folding `declined` into the denominator would punish a proposer for
   *    correctly having nothing to say.
   *  - Folding `pending` into `wouldReject` would make an unreviewed backlog
   *    look like a failing class.
   *  - Reporting 0% for a class nobody has reviewed says the opposite of what
   *    the data supports, so `approvalRate` is null there instead.
   */
  async approvalRates(since?: Date): Promise<ActionClassApprovalRate[]> {
    const rows = await this.prisma.supervisorProposal.groupBy({
      by: ['actionClass', 'outcome', 'review'],
      where: since ? { createdAt: { gte: since } } : undefined,
      _count: { _all: true },
    });

    // Seeded with EVERY registered class, so a class nothing proposed appears
    // with zeros rather than being absent. #90's bias in one line: a class
    // missing from this list is indistinguishable from a class that has never
    // been asked for, and the promotion ladder must be able to tell.
    const byClass = new Map<string, ActionClassApprovalRate>(
      ACTION_CLASSES.map((entry) => [
        entry.id,
        {
          actionClass: entry.id,
          proposed: 0,
          declined: 0,
          wouldApprove: 0,
          wouldReject: 0,
          pendingReview: 0,
          approvalRate: null,
        },
      ]),
    );

    for (const row of rows) {
      const entry = byClass.get(row.actionClass) ?? {
        actionClass: row.actionClass,
        proposed: 0,
        declined: 0,
        wouldApprove: 0,
        wouldReject: 0,
        pendingReview: 0,
        approvalRate: null,
      };

      const count = row._count._all;
      if (row.outcome === 'proposed') entry.proposed += count;
      else entry.declined += count;

      if (row.review === 'would_approve') entry.wouldApprove += count;
      else if (row.review === 'would_reject') entry.wouldReject += count;
      else entry.pendingReview += count;

      byClass.set(row.actionClass, entry);
    }

    const result = [...byClass.values()];
    for (const entry of result) {
      const judged = entry.wouldApprove + entry.wouldReject;
      entry.approvalRate = judged === 0 ? null : entry.wouldApprove / judged;
    }

    // A total order, so two classes with identical counts do not swap places
    // between reads of the same data.
    return result.sort((a, b) => a.actionClass.localeCompare(b.actionClass));
  }

  /**
   * The review queue, and the log as a whole.
   *
   * Ordered newest first with an `id` tie-break, so paging cannot show the
   * same row twice or skip one when two proposals share a millisecond.
   */
  async listProposals(query: {
    page: number;
    pageSize: number;
    actionClass?: string;
    review?: ProposalReview;
    outcome?: 'proposed' | 'declined';
  }): Promise<{
    items: ProposalView[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const where = {
      ...(query.actionClass ? { actionClass: query.actionClass } : {}),
      ...(query.review ? { review: query.review } : {}),
      ...(query.outcome ? { outcome: query.outcome } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.supervisorProposal.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: { invocation: { select: { snapshotTruncated: true } } },
      }),
      this.prisma.supervisorProposal.count({ where }),
    ]);

    return {
      items: rows.map(toProposalView),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /**
   * The newest proposal of one class about one subject.
   *
   * Exists because the `[targetKind, targetRef]` index does, and because the
   * caller that wants it — the run summary asking for a diagnosis (#92) — is
   * asking about a single run. Paging the whole log and filtering in memory
   * would work today and stop working the first busy week.
   *
   * `proposed` only. A declined row means the supervisor looked and had
   * nothing to say, and surfacing that on a pull request would be noise.
   */
  async latestProposalFor(
    targetKind: string,
    targetRef: string,
    actionClass: string,
  ): Promise<ProposalView | null> {
    const row = await this.prisma.supervisorProposal.findFirst({
      where: { targetKind, targetRef, actionClass, outcome: 'proposed' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: { invocation: { select: { snapshotTruncated: true } } },
    });

    return row ? toProposalView(row) : null;
  }

  /**
   * One invocation, INCLUDING the snapshot text.
   *
   * The heavy field is on this endpoint and not on the proposal list on
   * purpose: a review screen paging 25 proposals does not want 25 copies of a
   * 6-8 KB document, and the reviewer who actually needs to answer "what did
   * it know?" is looking at one proposal when they ask.
   */
  async getInvocation(id: string): Promise<InvocationView> {
    const row = await this.prisma.supervisorInvocation.findUnique({
      where: { id },
    });

    if (!row) {
      throw new NotFoundException(`No supervisor invocation with id ${id}`);
    }

    return {
      id: row.id,
      startedAt: row.startedAt.toISOString(),
      finishedAt: row.finishedAt.toISOString(),
      durationMs: row.durationMs,
      outcome: row.outcome,
      model: row.model,
      snapshotText: row.snapshotText,
      snapshotHash: row.snapshotHash,
      snapshotGeneratedAt: row.snapshotGeneratedAt?.toISOString() ?? null,
      snapshotTruncated: row.snapshotTruncated,
      snapshotCharacters: row.snapshotCharacters,
      costUsd: toNumberOrNull(row.costUsd),
      tokensInput: row.tokensInput,
      tokensOutput: row.tokensOutput,
      failureReason: row.failureReason,
    };
  }
}

/** A proposal as the API renders it. Dates are ISO strings by this point. */
export interface ProposalView {
  id: string;
  invocationId: string;
  actionClass: string;
  outcome: 'proposed' | 'declined';
  summary: string;
  reasoning: string;
  targetKind: string | null;
  targetRef: string | null;
  details: unknown;
  review: ProposalReview;
  reviewedAt: string | null;
  reviewNote: string | null;
  createdAt: string;
  snapshotTruncated: boolean;
}

/** An invocation as the API renders it. */
export interface InvocationView {
  id: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  outcome: string;
  model: string;
  snapshotText: string;
  snapshotHash: string;
  snapshotGeneratedAt: string | null;
  snapshotTruncated: boolean;
  snapshotCharacters: number;
  costUsd: number | null;
  tokensInput: number | null;
  tokensOutput: number | null;
  failureReason: string | null;
}

function toProposalView(row: {
  id: string;
  invocationId: string;
  actionClass: string;
  outcome: string;
  summary: string;
  reasoning: string;
  targetKind: string | null;
  targetRef: string | null;
  details: unknown;
  review: string;
  reviewedAt: Date | null;
  reviewNote: string | null;
  createdAt: Date;
  invocation: { snapshotTruncated: boolean };
}): ProposalView {
  return {
    id: row.id,
    invocationId: row.invocationId,
    actionClass: row.actionClass,
    outcome: row.outcome as 'proposed' | 'declined',
    summary: row.summary,
    reasoning: row.reasoning,
    targetKind: row.targetKind,
    targetRef: row.targetRef,
    details: row.details ?? null,
    review: row.review as ProposalReview,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    reviewNote: row.reviewNote,
    createdAt: row.createdAt.toISOString(),
    // Carried onto the proposal because it changes how a verdict should be
    // read: a proposal made from a partial view of the factory may be wrong
    // for a reason that is not the supervisor's fault.
    snapshotTruncated: row.invocation.snapshotTruncated,
  };
}

/**
 * SHA-256 of the rendered snapshot.
 *
 * Lets two invocations be compared for "did anything change" without loading
 * both 6-8 KB bodies. It is an identity check, not a security boundary.
 */
export function hashSnapshot(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
