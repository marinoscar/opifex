import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { ACTION_CLASS_IDS } from '../action-classes';

export const PROPOSALS_DEFAULT_PAGE_SIZE = 25;
export const PROPOSALS_MAX_PAGE_SIZE = 100;
export const APPROVAL_RATE_MAX_DAYS = 180;

const reviewStates = ['pending', 'would_approve', 'would_reject'] as const;

export const proposalsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(PROPOSALS_MAX_PAGE_SIZE)
    .default(PROPOSALS_DEFAULT_PAGE_SIZE),
  /**
   * Filter by action class.
   *
   * The enum comes from the registry rather than being restated here. ADR-0011
   * put the taxonomy in one file precisely so a second copy could not drift
   * from it, and an API that accepted a class the log cannot store would be
   * that drift.
   */
  actionClass: z
    .enum(ACTION_CLASS_IDS as unknown as [string, ...string[]])
    .optional(),
  review: z.enum(reviewStates).optional(),
  outcome: z.enum(['proposed', 'declined']).optional(),
});

export class ProposalsQueryDto extends createZodDto(proposalsQuerySchema) {}

export const reviewProposalSchema = z.object({
  /**
   * The verdict. `pending` is not accepted: it is the ABSENCE of a verdict,
   * and an endpoint that let a reviewer set it would be an un-review, which
   * silently removes evidence the promotion ladder already counted.
   */
  verdict: z.enum(['would_approve', 'would_reject']),
  note: z.string().max(2000).optional(),
});

export class ReviewProposalDto extends createZodDto(reviewProposalSchema) {}

export const approvalRatesQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(APPROVAL_RATE_MAX_DAYS).optional(),
});

export class ApprovalRatesQueryDto extends createZodDto(
  approvalRatesQuerySchema,
) {}

/** One proposal, as the review screen reads it. */
export const proposalSchema = z.object({
  id: z.string().uuid(),
  invocationId: z.string().uuid(),
  actionClass: z.string(),
  /** `declined` is a real row: the supervisor looked and had nothing to say. */
  outcome: z.enum(['proposed', 'declined']),
  summary: z.string(),
  reasoning: z.string(),
  targetKind: z.string().nullable(),
  targetRef: z.string().nullable(),
  details: z.unknown().nullable(),
  review: z.enum(reviewStates),
  reviewedAt: z.string().datetime().nullable(),
  reviewNote: z.string().nullable(),
  createdAt: z.string().datetime(),
  /**
   * Whether the snapshot behind this proposal dropped rows.
   *
   * Surfaced on the proposal itself rather than only on the invocation,
   * because it changes how a verdict should be read: a proposal made from a
   * partial view of the factory may be wrong for a reason that is not the
   * supervisor's fault, and a reviewer who cannot see that will bin the
   * evidence incorrectly.
   */
  snapshotTruncated: z.boolean(),
});

export class ProposalDto extends createZodDto(proposalSchema) {}

/** One invocation, with the exact text the model was given. */
export const invocationSchema = z.object({
  id: z.string().uuid(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
  durationMs: z.number().int(),
  outcome: z.enum([
    'completed',
    'partial',
    'failed',
    'skipped_disabled',
    'skipped_quota',
    // The supervisor's own spend ceiling refused the tick, or no ceiling was
    // configured for it to check against (ADR-0017). Separate from
    // `skipped_quota`, which is about parked workers rather than dollars.
    'skipped_budget',
  ]),
  model: z.string(),
  snapshotText: z.string(),
  snapshotHash: z.string(),
  snapshotGeneratedAt: z.string().datetime().nullable(),
  snapshotTruncated: z.boolean(),
  snapshotCharacters: z.number().int(),
  /** Null when the adapter reports no cost. Not zero — VISION §6. */
  costUsd: z.number().nullable(),
  /**
   * How many of this invocation's model calls priced at null (#282).
   *
   * Read WITH `costUsd`, never instead of it: above zero, the dollar figure
   * is a floor, because the unpriced calls cost something no table could
   * convert. Zero on rows written before the count existed.
   */
  unpricedCalls: z.number().int(),
  tokensInput: z.number().int().nullable(),
  tokensOutput: z.number().int().nullable(),
  failureReason: z.string().nullable(),
});

export class InvocationDto extends createZodDto(invocationSchema) {}

/** Per class, what fraction of judged proposals a human would have approved. */
export const approvalRateSchema = z.object({
  actionClass: z.string(),
  proposed: z.number().int(),
  declined: z.number().int(),
  wouldApprove: z.number().int(),
  wouldReject: z.number().int(),
  pendingReview: z.number().int(),
  /**
   * Null when nothing has been reviewed, NEVER 0.
   *
   * The same rule `metrics.dto.ts` states for the six success metrics: a class
   * with no reviewed proposals has no evidence, and 0% says the opposite of
   * that — a class that always proposes badly.
   */
  approvalRate: z.number().nullable(),
  /**
   * Whether Phase 6 ships anything that produces this class, from the
   * registry. Without it a class at zero samples is ambiguous between "not
   * measured yet" and "nothing proposes it" — the bias #90 names directly.
   */
  hasProposer: z.boolean(),
  /** Whether the class may ever be promoted at all (ADR-0011). */
  autonomyEligible: z.boolean(),
});

export class ApprovalRateDto extends createZodDto(approvalRateSchema) {}
