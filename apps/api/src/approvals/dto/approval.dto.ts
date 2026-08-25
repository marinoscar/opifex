import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { ACTION_CLASS_IDS } from '../../supervisor/action-classes';

/** How far back `GET /approvals/rates` may look. */
export const APPROVAL_RATES_MAX_DAYS = 180;
export const APPROVAL_RATES_DEFAULT_DAYS = 30;

/**
 * The two statuses that mean "a human has not answered this yet".
 *
 * `parked` is not a resolution — it is `pending` with no timer — so the queue
 * shows both. Restated as a zod enum rather than reusing the Prisma
 * `ApprovalStatus`: this filter must NEVER be able to widen the queue to a
 * decided row, and a closed two-member enum makes that a parse error at the
 * boundary rather than a `where` clause somebody has to read carefully.
 */
const openStatuses = ['pending', 'parked'] as const;

export const listApprovalsQuerySchema = z.object({
  /** One repository's queue. */
  repositoryId: z.string().min(1).optional(),
  /**
   * The enum comes from the ADR-0011 registry rather than being restated.
   *
   * A second copy is the drift that file exists to prevent — and an API that
   * accepted a class the gate cannot raise would answer 200 with an empty list
   * for a typo, which reads as "nothing is waiting" rather than "you asked the
   * wrong question".
   */
  actionClass: z
    .enum(ACTION_CLASS_IDS as unknown as [string, ...string[]])
    .optional(),
  /** Narrow to one of the two open statuses. Cannot widen past them. */
  status: z.enum(openStatuses).optional(),
});

export class ListApprovalsQueryDto extends createZodDto(
  listApprovalsQuerySchema,
) {}

/**
 * One declared effect, as frozen on the row at raise time (ADR-0013).
 *
 * Kept open (`catchall`) rather than restated as the `AutonomyEffect` union.
 * The column is a FROZEN RECORD of what a historical action declared it would
 * do, and a row whose shape predates a widening of that union is still the
 * truth about that action — a closed schema here would make the API unable to
 * render its own history. `kind` is required because every consumer branches
 * on it.
 */
const effectSchema = z.object({ kind: z.string() }).catchall(z.unknown());

/** An approval request, as the queue and the detail screen read it. */
export const approvalSchema = z.object({
  id: z.uuid(),
  actionClass: z.string(),
  repositoryId: z.string(),
  proposalId: z.uuid().nullable(),
  targetKind: z.string().nullable(),
  targetRef: z.string().nullable(),

  /** WHAT is being asked, one line (VISION §8). */
  summary: z.string(),
  /** WHY, in enough detail that a reviewer can judge the argument. */
  reasoning: z.string(),
  /** BLAST RADIUS: what else is affected. */
  blastRadius: z.string(),
  /** Everything this action would do, frozen at raise time. */
  effects: z.array(effectSchema),
  /**
   * NULL MEANS UNKNOWN, NOT ZERO (VISION §6).
   *
   * A `spendsMoney` action whose cost could not be estimated is not a free
   * action; it is one the gate could not price. Rendering null as `$0.00`
   * would tell the operator the opposite of what the data says.
   */
  estimatedCostUsd: z.number().nullable(),

  /**
   * What happens if nobody answers — the RECORDED policy, never a recomputed
   * one (ADR-0014).
   *
   * This is the promise the operator was given when the request was raised,
   * and the sweeper keeps exactly this promise even if the registry has since
   * been edited.
   */
  timeoutPolicy: z.enum(['auto_approve', 'deny', 'park_and_escalate']),
  /**
   * Null EXACTLY when `timeoutPolicy` is `park_and_escalate`, and that null is
   * the never-auto-approve guarantee expressed as data rather than as a
   * branch. A UI must not render a countdown for it: there is no timer, and
   * an operator who believes a deadline exists will let it lapse expecting
   * something to happen.
   */
  timeoutAt: z.iso.datetime().nullable(),

  status: z.enum([
    'pending',
    'parked',
    'approved',
    'denied',
    'auto_approved',
    'auto_denied',
    'superseded',
  ]),
  decidedAt: z.iso.datetime().nullable(),
  decidedById: z.uuid().nullable(),
  /**
   * Who or what decided. `human` is evidence; `grant` and `timeout` are not.
   *
   * The axis that keeps machine action out of #99's promotion numerator.
   * `status` deliberately does not encode it a second time.
   */
  decidedVia: z.enum(['human', 'timeout', 'grant']).nullable(),
  decisionNote: z.string().nullable(),

  /** The grant that AUTHORIZED this. */
  grantId: z.uuid().nullable(),
  /** The grant BORN from the decision on this. A different edge entirely. */
  createdGrantId: z.uuid().nullable(),
  /** Set only for a parked approval, which raises one (VISION §8). */
  escalationId: z.uuid().nullable(),
  /**
   * A parked request with no escalation record (#237).
   *
   * Derived from `status` and `escalationId`, exposed because the operator
   * needs a way to SEE this rather than only find it in a log. It means the
   * escalation — and with it the delivery receipt and #136's redelivery — was
   * never created; the approval itself was still pushed when it was raised.
   */
  escalationMissing: z.boolean(),

  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export class ApprovalDto extends createZodDto(approvalSchema) {}

/**
 * One row of the QUEUE: an approval plus the one class fact triage needs.
 *
 * `GET /approvals` used to return the bare `actionClass` id, which left the
 * queue naming classes `re-dispatch` and `spec-quality-feedback` while the
 * detail screen — which joins the whole registry entry — named the same class
 * "Re-dispatch after transient failure". The join belongs HERE and not in the
 * client: a second copy of the taxonomy in a browser is exactly the drift
 * ADR-0011 put it in one file to prevent.
 *
 * The title, and DELIBERATELY NOTHING ELSE from the registry. `definition`,
 * `reversibility` and `autonomyEligible` are decision context — they answer
 * "should this happen?", which is the detail screen's question — and a triage
 * row exists only to answer "which of these do I open first?". Widening this
 * to the whole entry would make the list the decision surface by accident.
 */
export const approvalListItemSchema = approvalSchema.extend({
  /**
   * The registry `title` for `actionClass`, or NULL when the registry does not
   * know the id.
   *
   * Null rather than a fallback to the raw id, and that is the point: a client
   * that receives the id dressed up as a title cannot tell registry drift from
   * a class that genuinely happens to be titled that way, so a silent fallback
   * here would make an unknown class — which is a REAL case, since ADR-0014
   * parks one — indistinguishable from a healthy one. The cockpit renders
   * `actionClassTitle ?? actionClass`, so the id still shows; the difference
   * is that the null travels, and anything reading the API can see it.
   */
  actionClassTitle: z.string().nullable(),
});

export class ApprovalListItemDto extends createZodDto(approvalListItemSchema) {}

/**
 * The ADR-0011 registry entry for the class under question.
 *
 * Joined onto the detail response rather than stored on the row, exactly as
 * `GET /supervisor/approval-rates` does: these facts describe the CLASS, not
 * this instance, and a copy in the database is the drift ADR-0011 put the
 * taxonomy in one file to prevent.
 *
 * Null for a class the registry does not recognise. That is a real case, not a
 * defensive one — ADR-0014 resolves an unknown id to `park_and_escalate`, so a
 * parked approval with a null entry here is the single most likely parked
 * approval in production today, and it means "the proposer and the registry
 * have drifted" rather than "an irreversible action awaits judgment".
 */
export const actionClassEntrySchema = z.object({
  id: z.string(),
  /** Short human label. What the notification title says. */
  title: z.string(),
  /**
   * What a proposal of this class actually asks for — a sentence, not a
   * category label (#91).
   *
   * Part of VISION §8's "enough context to decide" from a phone: an operator
   * who has to know what `re-dispatch` means before they can judge this
   * request does not have enough context, they have a label.
   */
  definition: z.string(),
  /** What changes outside the control plane if a human approves. */
  effect: z.string(),
  reversibility: z.enum([
    'reversible',
    'reversible-with-effort',
    'irreversible',
  ]),
  /**
   * Whether this class may EVER be promoted to auto-execution.
   *
   * The UI needs it to know whether "Always approve this class" can do
   * anything at all: the flag on an ineligible class approves the single
   * action and mints no grant, and an operator who is not told that comes to
   * believe they hold a grant they do not.
   */
  autonomyEligible: z.boolean(),
  hasProposer: z.boolean(),
  /** Whether the APPROVED EFFECT spends money, per ADR-0014 rule 2. */
  spendsMoney: z.boolean(),
});

export const approvalDetailSchema = approvalSchema.extend({
  actionClassEntry: actionClassEntrySchema.nullable(),
});

export class ApprovalDetailDto extends createZodDto(approvalDetailSchema) {}

export const decideApprovalSchema = z.object({
  decision: z.enum(['approve', 'deny']),
  /** Free text. Optional: a fast verdict with no prose is still a verdict. */
  note: z.string().max(2000).optional(),
  /**
   * VISION §8's third option, "Always approve this class".
   *
   * Requires `trust:grant` IN ADDITION to `approvals:decide`, and the
   * controller — not the service — is where that composition is enforced. A
   * caller without it gets 403 and the single decision is NOT applied: the
   * operator tapped one button meaning "approve this AND stop asking me", and
   * doing half of it silently is how somebody comes to believe they hold a
   * grant that does not exist.
   *
   * Even with the permission, the grant is only minted for an
   * autonomy-eligible class, and the four attributes (scope, expiry, budget
   * ceiling, auto-revoke) are attached automatically — there is no widening
   * path from this flag. When no grant is minted, `grantSkippedReason` says
   * why, in a sentence.
   */
  alwaysApproveThisClass: z.boolean().optional(),
});

export class DecideApprovalDto extends createZodDto(decideApprovalSchema) {}

export const decideResultSchema = z.object({
  approval: approvalSchema,
  /** The grant minted from "Always approve this class", if one was. */
  createdGrantId: z.uuid().nullable(),
  /**
   * Why no grant was minted, when the flag was set and none was.
   *
   * Null when the flag was not set, or when a grant WAS minted. A sentence
   * rather than a boolean: "the flag was ignored" is not something a human can
   * act on. SHOW IT — a flag that quietly does nothing is the failure this
   * field exists to prevent.
   */
  grantSkippedReason: z.string().nullable(),
  /**
   * True when this verdict landed after `timeoutAt` had passed but before the
   * sweeper reached the row.
   *
   * The decision COUNTED — the recorded state is the authority, and the row
   * was still open — but the window had lapsed, and the operator is told so
   * rather than left to wonder which of the two won.
   */
  decidedAfterTimeout: z.boolean(),
});

export class DecideResultDto extends createZodDto(decideResultSchema) {}

export const approvalRatesQuerySchema = z.object({
  days: z.coerce
    .number()
    .int()
    .min(1)
    .max(APPROVAL_RATES_MAX_DAYS)
    .default(APPROVAL_RATES_DEFAULT_DAYS),
});

export class ApprovalRatesQueryDto extends createZodDto(
  approvalRatesQuerySchema,
) {}

/**
 * Per-class approval evidence (#99's ladder, #101's surface).
 *
 * The buckets are separate and are NEVER summed, because a timeout is silence
 * and silence is neither agreement nor disagreement. Folding `autoApproved`
 * into `approved` would let a class promote itself by being ignored: nobody is
 * ever asked, everything times out reversible, and the ladder reads a perfect
 * approval rate over a population of zero human opinions.
 */
export const classApprovalRatesSchema = z.object({
  actionClass: z.string(),

  // -- Human evidence. The numerator and denominator, and nothing else. -----
  /** `approved` by a human. */
  approved: z.number().int(),
  /** `denied` by a human. */
  denied: z.number().int(),
  /** `approved + denied`. The denominator. */
  humanDecisions: z.number().int(),
  /**
   * `approved / humanDecisions`, or NULL when no human has decided one.
   *
   * Null rather than 0: 0/0 is "no evidence", and a 0% approval rate says the
   * opposite — that humans always reject this class.
   */
  approvalRate: z.number().nullable(),

  // -- Everything else, counted separately and never folded in. -------------
  /** Resolved by the clock under an `auto_approve` policy. Not agreement. */
  autoApproved: z.number().int(),
  /** Resolved by the clock under a `deny` policy. Not disapproval. */
  autoDenied: z.number().int(),
  /** Ran under a standing grant. Machine action on earlier human evidence. */
  grantAuthorized: z.number().int(),
  /** Still waiting on a human or the clock. */
  pending: z.number().int(),
  /** Parked; waits indefinitely for a person. No timer. */
  parked: z.number().int(),
  /** The world moved on before anyone had to answer. */
  superseded: z.number().int(),
});

export class ClassApprovalRatesDto extends createZodDto(
  classApprovalRatesSchema,
) {}
