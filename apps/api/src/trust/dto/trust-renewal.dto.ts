import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * The renewal surface's request and response shapes (#115, epic #22).
 *
 * Deliberately scoped to renewal and nothing else. #101 owns the general trust
 * controller and will bring its own grant DTOs; keeping this file narrow means
 * the merge is a small, obvious conflict in two files rather than a large one
 * across a module.
 */

/**
 * The four end reasons plus the three lifecycle ones, restated as a zod enum.
 *
 * Restated rather than derived from the Prisma enum for the reason
 * `listApprovalsQuerySchema` restates its statuses: this is a RESPONSE
 * contract, and a client reading the document should see the closed set it
 * will actually receive. A schema addition that widened this silently would be
 * a breaking change nobody noticed.
 */
const trustGrantStatus = z.enum(['active', 'expired', 'revoked', 'suspended']);

const trustGrantEndReason = z.enum([
  'manual_revocation',
  'expired',
  'budget_exhausted',
  'failure_rate_exceeded',
  'cost_per_action_exceeded',
  'class_demoted',
  'superseded_by_renewal',
]);

/** A grant, as `TrustGrantView` renders it. */
export const trustGrantSchema = z.object({
  id: z.uuid(),

  // Scope. VISION §8: an action class in a repository, never "the agent".
  actionClass: z.string(),
  repositoryId: z.string(),

  expiresAt: z.iso.datetime(),

  budgetCeilingUsd: z.number(),
  spentUsd: z.number(),
  actionsAuthorized: z.number().int(),
  actionsFailed: z.number().int(),

  maxFailureRate: z.number(),
  maxCostPerActionUsd: z.number(),
  minActionsBeforeAutoRevoke: z.number().int(),

  status: trustGrantStatus,
  endedAt: z.iso.datetime().nullable(),
  endReason: trustGrantEndReason.nullable(),
  endDetail: z.string().nullable(),
  revokedById: z.uuid().nullable(),

  note: z.string().nullable(),
  grantedById: z.uuid(),
  grantedFromProposalId: z.uuid().nullable(),
  /** The grant this one renewed. The chain #115 makes walkable. */
  renewedFromId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),

  remainingBudgetUsd: z.number(),
  budgetHeadroomFraction: z.number(),
  /**
   * NEGATIVE once lapsed, deliberately not clamped: "expired 3 hours ago" and
   * "expires in 0ms" are different facts.
   */
  msUntilExpiry: z.number(),
  /** NULL, never 0, when nothing was authorized: 0/0 is no evidence. */
  failureRate: z.number().nullable(),
  nearExpiry: z.boolean(),
  nearBudget: z.boolean(),
});

export class TrustGrantDto extends createZodDto(trustGrantSchema) {}

/**
 * The renewal request body: a note, and nothing else.
 *
 * No attributes, for exactly the reason "Always approve this class" takes
 * none. The four attributes VISION §8 requires are attached automatically —
 * fresh from the defaults, narrowed by the old grant's own — and an endpoint
 * that accepted a `budgetCeilingUsd` would be a widening path with "renew" on
 * the button, which is the one thing #115 says must not exist. An operator who
 * genuinely wants different terms creates a grant explicitly, where the
 * numbers are recorded as their choice.
 *
 * No `expiresAt` either, and no `days`. The same argument: the point of an
 * expiry nobody can extend in place is that a longer grant is a NEW decision
 * with a name on it.
 */
export const renewTrustGrantSchema = z.object({
  /**
   * Free text: why this is still worth trusting. Optional — a one-tap renewal
   * with no prose is still a decision, and requiring a justification is
   * exactly the friction VISION §8 says produces blanket trust instead.
   */
  note: z.string().max(2000).optional(),
});

export class RenewTrustGrantDto extends createZodDto(renewTrustGrantSchema) {}

/**
 * Both rows: the successor and the grant it replaced.
 *
 * The old grant is returned so the caller can SHOW THE CHAIN. A response
 * carrying only the new grant would be indistinguishable from "a second grant
 * was created alongside the first" — two live grants for one scope, with two
 * independent budget ceilings — which is a materially worse state and one an
 * operator would have no way to notice from this screen.
 */
export const renewTrustGrantResultSchema = z.object({
  /** The new grant. Its `renewedFromId` points at `ended.id`. */
  renewed: trustGrantSchema,
  /** The old grant, now ended with `endReason: 'superseded_by_renewal'`. */
  ended: trustGrantSchema,
});

export class RenewTrustGrantResultDto extends createZodDto(
  renewTrustGrantResultSchema,
) {}
