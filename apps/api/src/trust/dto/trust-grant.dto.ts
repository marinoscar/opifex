import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { ACTION_CLASS_IDS } from '../../supervisor/action-classes';

/**
 * The HTTP shapes of the trust surface (#101, epic #22, VISION §8).
 *
 * The load-bearing file here is `createTrustGrantSchema`. Everything else
 * describes what the server sends; that one describes what the server will
 * ACCEPT, and it is the only place where VISION §8's "attached automatically"
 * can be broken by an addition that looks helpful.
 */

/** Every status a grant row can hold, as the filter accepts them. */
const grantStatuses = ['active', 'expired', 'revoked', 'suspended'] as const;

const endReasons = [
  'manual_revocation',
  'expired',
  'budget_exhausted',
  'failure_rate_exceeded',
  'cost_per_action_exceeded',
  'class_demoted',
  'superseded_by_renewal',
] as const;

export const listTrustGrantsQuerySchema = z.object({
  /** One repository's grants. Scope, half two (VISION §8). */
  repositoryId: z.string().min(1).optional(),
  /**
   * The enum comes from the ADR-0011 registry rather than being restated, for
   * the reason `listApprovalsQuerySchema` gives: a second copy of the taxonomy
   * is the drift that file exists to prevent, and a typo'd class would
   * otherwise answer 200 with an empty list — which reads as "nothing is
   * trusted here" rather than "you asked the wrong question".
   */
  actionClass: z
    .enum(ACTION_CLASS_IDS as unknown as [string, ...string[]])
    .optional(),
  /**
   * Narrow to exactly one status.
   *
   * Note that this OVERRIDES `includeEnded`: asking for `revoked` returns
   * revoked grants whether or not the flag is set, because a filter that
   * silently returned nothing when combined with the default would be a filter
   * that lies. `TrustGrantService.list` implements that precedence; it is
   * documented here so the contract is visible where the query is defined.
   */
  status: z.enum(grantStatuses).optional(),
  /**
   * Include revoked, expired and suspended grants. Defaults to FALSE.
   *
   * The common read is "what may run unattended right now", so ended grants
   * are off by default — but they are never deleted and always reachable,
   * which is #96's and #101's last acceptance criterion. A grant that vanished
   * when it died would take its evidence with it, and that evidence is what
   * VISION §8's digest ("what ran under trust, what it cost, what it changed")
   * and #99's ladder are made of.
   *
   * `z.coerce.boolean()` is deliberately NOT used: it maps every non-empty
   * string to true, so `includeEnded=false` would mean true. `z.stringbool()`
   * parses the words a query string actually carries.
   */
  includeEnded: z.stringbool().default(false),
});

export class ListTrustGrantsQueryDto extends createZodDto(
  listTrustGrantsQuerySchema,
) {}

/**
 * A grant as every read renders it — `TrustGrantView` in the HTTP layer.
 *
 * The four VISION §8 attributes are all here and all non-null, because the
 * schema makes them NOT NULL and `CreateTrustGrantInput` makes them required
 * arguments. A nullable ceiling in this DTO would advertise a grant with no
 * ceiling as a shape this API can produce, which is precisely the "blank
 * check" the whole mechanism exists to make unrepresentable.
 */
export const trustGrantSchema = z.object({
  id: z.uuid(),

  // -- Attribute 1: scope. Action class x repository, never "the agent". ----
  actionClass: z.string(),
  repositoryId: z.string(),

  // -- Attribute 2: expiry. -------------------------------------------------
  expiresAt: z.iso.datetime(),

  // -- Attribute 3: budget ceiling, and the spend measured against it. ------
  budgetCeilingUsd: z.number(),
  spentUsd: z.number(),
  actionsAuthorized: z.number().int(),
  actionsFailed: z.number().int(),

  // -- Attribute 4: auto-revoke thresholds. ---------------------------------
  maxFailureRate: z.number(),
  maxCostPerActionUsd: z.number(),
  /**
   * Sample-size floor below which neither RATE rule may fire. Read it together
   * with `failureRate`: a grant at 100% failure over one action has NOT
   * tripped anything, and a UI that showed the rate without this number would
   * make the mechanism look broken.
   */
  minActionsBeforeAutoRevoke: z.number().int(),

  // -- Lifecycle ------------------------------------------------------------
  status: z.enum(grantStatuses),
  endedAt: z.iso.datetime().nullable(),
  /**
   * WHY it ended, as a category. Never inferred from `status`: `expired` and
   * `suspended` are statuses, but "suspended because the failure rate crossed
   * 34%" and "suspended because the class was demoted off the ladder" are
   * completely different facts about the factory and only this field separates
   * them.
   */
  endReason: z.enum(endReasons).nullable(),
  /** The sentence naming the numbers that ended it. SHOW IT. */
  endDetail: z.string().nullable(),
  /**
   * Who revoked it, when a human did. Null for every other end.
   *
   * A separate column rather than prose inside `endDetail`, because a
   * provenance edge that exists only in a sentence is the hole VISION §5 says
   * is undetectable after the fact.
   */
  revokedById: z.uuid().nullable(),

  // -- Provenance -----------------------------------------------------------
  note: z.string().nullable(),
  grantedById: z.uuid(),
  /** The approved proposal this grant came out of, when there was one. */
  grantedFromProposalId: z.uuid().nullable(),
  /** The grant this one renews. The renewal chain's backward edge. */
  renewedFromId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),

  // -- Derived, relative to the moment of the read --------------------------
  //
  // Computed once in `TrustGrantView` rather than in each client. Two
  // independently written versions of `remaining / ceiling` is exactly how a
  // renewal banner and a budget bar end up disagreeing on the same screen.

  /** `budgetCeilingUsd - spentUsd`, floored at zero. */
  remainingBudgetUsd: z.number(),
  /**
   * Headroom as a fraction in [0, 1]. The fraction, not the dollars, is what
   * makes a $25 grant and a $250 grant comparable in one list.
   */
  budgetHeadroomFraction: z.number(),
  /**
   * Milliseconds until expiry, NEGATIVE once it has lapsed and deliberately
   * not clamped. "Expired 3 hours ago" and "expires in 0ms" are different
   * facts, and a renewal prompt has to tell them apart.
   */
  msUntilExpiry: z.number(),
  /**
   * `actionsFailed / actionsAuthorized`, or NULL when nothing has been
   * authorized yet. Null rather than 0: 0/0 is "no evidence", and a 0%
   * failure rate says the opposite of what the data supports.
   */
  failureRate: z.number().nullable(),
  /** Inside the renewal-prompt window (48h). */
  nearExpiry: z.boolean(),
  /** Headroom below the warning fraction (20%). */
  nearBudget: z.boolean(),
});

export class TrustGrantDto extends createZodDto(trustGrantSchema) {}

/**
 * One row of the LIST: a grant plus the one class fact a list needs.
 *
 * Split from `trustGrantSchema` for the reason `ApprovalListItemDto` is split
 * from `approvalSchema` — the detail response must not be widened with a field
 * it does not return, and a client that read `actionClassTitle` off a detail
 * body would get `undefined` with no way to tell that from a null title.
 */
export const trustGrantListItemSchema = trustGrantSchema.extend({
  /**
   * The ADR-0011 registry `title` for `actionClass`, or NULL when the registry
   * does not know the id.
   *
   * NEVER a fallback to the raw id. A title that silently equals its id is
   * indistinguishable from a class that happens to be named that way, so the
   * fallback would make registry drift invisible — and drift is a real case
   * here, since a grant outlives edits to the taxonomy. The cockpit renders
   * `actionClassTitle ?? actionClass`, so the id still shows; the difference
   * is that the null travels.
   */
  actionClassTitle: z.string().nullable(),
});

export class TrustGrantListItemDto extends createZodDto(
  trustGrantListItemSchema,
) {}

/**
 * The ADR-0011 registry entry for the class a grant covers.
 *
 * Joined onto the detail response rather than stored on the row, exactly as
 * the approvals detail screen does it: these facts describe the CLASS, and a
 * copy in the database is the drift ADR-0011 put the taxonomy in one file to
 * prevent.
 */
export const grantActionClassEntrySchema = z.object({
  id: z.string(),
  title: z.string(),
  /**
   * What an action of this class actually does — a sentence, not a category
   * label. An operator deciding whether to revoke needs to know what they are
   * switching off, and `re-dispatch` is a label rather than an explanation.
   */
  definition: z.string(),
  effect: z.string(),
  reversibility: z.enum([
    'reversible',
    'reversible-with-effort',
    'irreversible',
  ]),
  /**
   * Whether this class may EVER hold a grant.
   *
   * Always true for a grant that exists — `TrustGrantService.create` refuses an
   * ineligible class. It is reported anyway because it can become false AFTER
   * the fact, when the registry is edited, and a live grant for a
   * now-ineligible class is a thing an operator needs to see rather than a
   * thing that cannot happen.
   */
  autonomyEligible: z.boolean(),
  hasProposer: z.boolean(),
  spendsMoney: z.boolean(),
});

/** A renewal edge, forward: a grant that was created to replace this one. */
export const renewalLinkSchema = z.object({
  id: z.uuid(),
  status: z.enum(grantStatuses),
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
});

export const trustGrantDetailSchema = trustGrantSchema.extend({
  actionClassEntry: grantActionClassEntrySchema.nullable(),
  /**
   * Grants created as renewals OF this one, newest first.
   *
   * The forward half of the chain `renewedFromId` records backwards. Both
   * halves are needed on one screen: an expired grant with a renewal is a
   * grant that was kept alive, and an expired grant WITHOUT one is VISION §8's
   * "silence revokes" having actually happened. Those look identical if you
   * can only see the backward edge.
   */
  renewedBy: z.array(renewalLinkSchema),
});

export class TrustGrantDetailDto extends createZodDto(trustGrantDetailSchema) {}

/**
 * What `POST /trust/grants` accepts. THREE FIELDS, and the omissions are the
 * design.
 *
 * VISION §8's move is not that grants CAN be scoped and capped — it is that
 * they ALWAYS are, without anyone choosing:
 *
 * > Every approval offers Approve / Deny / Always approve this class. The
 * > third option silently attaches all four. Safe by construction, one tap.
 *
 * So expiry, budget ceiling and the two auto-revoke thresholds are NOT
 * accepted here, and this schema is `.strict()` so sending them is a 400
 * rather than a silent no-op. Both halves matter:
 *
 *  - Accepting them would put the safety numbers under caller control, and a
 *    caller who can set `expiresAt` can set it to 3650 days. The mechanism
 *    would still exist, in the sense that every row would still carry an
 *    expiry, and it would enforce nothing. `defaults.ts` argues at length that
 *    these must not even be CONFIGURABLE — changing them should be a pull
 *    request — and an API field is configuration with no review at all.
 *  - Ignoring them silently would be worse than refusing them. A client that
 *    sent `budgetCeilingUsd: 500` and got back a grant would have to inspect
 *    the response to discover its ceiling is $25, and nobody inspects a 201.
 *    The operator would believe they hold a grant they do not — the same
 *    failure the approvals controller refuses whole rather than half-applying.
 *
 * The wider grant is not unreachable: `TrustGrantService.create` takes all
 * four explicitly and records the chosen numbers on the row as somebody's
 * choice. What no HTTP caller can do is make the WIDE grant the one the fast
 * path hands out.
 */
export const createTrustGrantSchema = z
  .object({
    /**
     * Scope, half one. Validated against the registry, and additionally
     * refused by the service when the class is not autonomy-eligible — two
     * gates, because a safety property that lives in exactly one place is one
     * refactor away from living in none.
     */
    actionClass: z.enum(ACTION_CLASS_IDS as unknown as [string, ...string[]]),
    /**
     * Scope, half two. Required, and there is no "all repositories" value:
     * VISION §8's "Never 'trust the agent.'" A 404 naming the repository comes
     * back if it does not exist.
     */
    repositoryId: z.string().min(1),
    /** Free text from the granting human: why this scope, why now. */
    note: z.string().max(2000).optional(),
  })
  // `.strict()`, so an unknown key is a 400 naming it. This is the line that
  // makes the paragraph above enforceable rather than aspirational: without
  // it, zod strips unknown keys and `budgetCeilingUsd: 3650` would be accepted
  // with a 201 and no effect.
  .strict();

export class CreateTrustGrantDto extends createZodDto(createTrustGrantSchema) {}

/**
 * What `DELETE /trust/grants/:id` accepts.
 *
 * `.default({})` rather than a bare object, because a DELETE frequently
 * arrives with no body at all — from `fetch` without a `Content-Type`, from
 * curl, from an intermediary that strips it — and the global
 * `ZodValidationPipe` parses whatever `@Body()` yields, which is `undefined`
 * in that case. Without the default, revoking a grant without explaining
 * yourself would be a 400, and revocation must never be harder than granting:
 * the safe direction is the one that has to stay one tap.
 */
export const revokeTrustGrantSchema = z
  .object({
    /**
     * Why. Optional, and worth writing: it is appended to `endDetail`, which
     * is the sentence the next operator reads when they find the grant dead
     * and wonder whether to re-issue it.
     */
    note: z.string().max(2000).optional(),
  })
  .strict()
  .default({});

export class RevokeTrustGrantDto extends createZodDto(revokeTrustGrantSchema) {}
