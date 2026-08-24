import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * The HTTP shapes of the promotion ladder (#101, epic #22, VISION §7).
 *
 * Note what is NOT in this file: a schema for promoting a class. There is no
 * promote endpoint and no body that could ask for one — see
 * `PromotionController`.
 */

const rungs = ['observe', 'measure', 'promoted'] as const;

const changeReasons = [
  'promoted_on_evidence',
  'demoted_on_regression',
  'demoted_ineligible',
  'demoted_manually',
  'paused_globally',
] as const;

/**
 * The counts a rung decision is made from — `ClassEvidence` over the wire.
 *
 * Appears TWICE in a state, as `evidence` (frozen at the last rung change) and
 * `currentEvidence` (as things stand now). Same shape, different claims, and a
 * client must not swap them: the first explains a decision, the second
 * describes the factory.
 */
export const classEvidenceSchema = z.object({
  actionClass: z.string(),

  /** Human approvals over the lifetime window, from both evidence sources. */
  approved: z.number().int(),
  rejected: z.number().int(),
  /** `approved + rejected`. The promotion denominator — the sample size. */
  sample: z.number().int(),
  /**
   * `approved / sample`, or NULL when `sample` is 0. The approval rate.
   *
   * Null, never 0. 0/0 is NO EVIDENCE, and a 0% approval rate says the
   * opposite — that humans reject this class every time they see it. Every
   * read model in this API makes the same choice; a client that coalesced it
   * to 0 would undo it at the last step.
   */
  rate: z.number().nullable(),

  /** The same counts restricted to the regression window (14 days). */
  recentApproved: z.number().int(),
  recentRejected: z.number().int(),
  recentSample: z.number().int(),
  recentRate: z.number().nullable(),

  /**
   * How the sample splits across its two sources: the supervisor review queue
   * and human decisions on the approval gate.
   *
   * Worth showing. A class promoted entirely on review-queue judgements has
   * never actually been asked for in production, and that is a different
   * quality of evidence from twenty live approvals — the rate alone hides it.
   */
  fromProposals: z.number().int(),
  fromApprovals: z.number().int(),
});

export const promotionThresholdsSchema = z.object({
  minSample: z.number().int(),
  promotionRate: z.number(),
  demotionRate: z.number(),
  demotionMinSample: z.number().int(),
  regressionWindowDays: z.number().int(),
});

/** Where one class stands, and what it is waiting on. */
export const promotionStateSchema = z.object({
  actionClass: z.string(),
  /** ADR-0011 registry title, or NULL — never the raw id. */
  actionClassTitle: z.string().nullable(),

  /**
   * The rung. `observe` = no human has judged this even once; `measure` =
   * evidence is accruing; `promoted` = eligible for a trust grant.
   *
   * `promoted` does NOT mean anything is running unattended. The ladder never
   * mints grants — it cannot, since it measures per class across all
   * repositories and knows one of VISION §8's four attributes. A promoted
   * class with no grant runs nothing.
   */
  rung: z.enum(rungs),
  /**
   * Whether the registry allows this class to be promoted AT ALL.
   *
   * False is permanent, not a state to be waited out: an ineligible class can
   * never stand on the promoted rung whatever its record.
   */
  eligible: z.boolean(),

  changedAt: z.iso.datetime(),
  /** Why it last changed rung. Null on a class that has never changed. */
  changeReason: z.enum(changeReasons).nullable(),
  /** The sentence naming the numbers behind that change. */
  changeDetail: z.string().nullable(),

  /**
   * The evidence FROZEN at the last rung change, exactly as it stood then.
   *
   * Never refreshed. #99 requires a promotion or demotion to state its
   * evidence, and evidence that moves afterwards cannot be checked against the
   * decision — which is the only thing stating it was for. Null when the class
   * has never changed rung.
   */
  evidence: classEvidenceSchema.nullable(),
  /** The same counts as they stand NOW. What `requirement` is computed from. */
  currentEvidence: classEvidenceSchema,

  /**
   * What would be needed to promote — the policy layer's own sentence.
   *
   * Rendered verbatim, never parsed and never recomputed. It names the missing
   * samples, the shortfall in approvals, or (for a promoted class) what is
   * keeping it there. A client deriving "2 more needed" from its own copy of
   * the thresholds would be a second implementation of the rule that actually
   * decides, and the day a threshold is tuned the screen would state a
   * requirement that no longer applies.
   */
  requirement: z.string(),
  /**
   * What the NEXT evaluation would do over this evidence: `promote`, `demote`,
   * or null for no change.
   *
   * A FORECAST. When `enabled` is false nothing will act on it — a class can
   * sit at `wouldChange: 'promote'` indefinitely while the ladder is switched
   * off, and that combination is the single most important thing this endpoint
   * can tell an operator.
   */
  wouldChange: z.enum(['promote', 'demote']).nullable(),

  promotedAt: z.iso.datetime().nullable(),
  demotedAt: z.iso.datetime().nullable(),
  /**
   * How many times this class has EVER been demoted.
   *
   * Counts demotions, not rung changes. A class that oscillates is evidence
   * about the THRESHOLDS rather than about the class, and without this counter
   * that evidence is visible only to whoever read the notifications.
   */
  demotionCount: z.number().int(),
});

export class PromotionStateDto extends createZodDto(promotionStateSchema) {}

/**
 * The whole ladder: every class, plus the switch that says whether any of it
 * is live.
 *
 * `enabled` sits at the top rather than on each state because it is one flag,
 * and it is present at all because a screen full of rungs with no mention that
 * the ladder is off would be actively misleading — every rung would read as a
 * live conclusion when in fact nothing has moved or will.
 */
export const promotionLadderSchema = z.object({
  /**
   * `PROMOTION_LADDER_ENABLED`. DEFAULTS OFF, and stays off until somebody
   * decides otherwise — the same rule every outward-acting switch in this API
   * follows, because turning it on is what eventually causes things to run
   * unattended.
   *
   * While false: no rung changes, no promotions, no demotions, no
   * notifications. Existing trust grants are UNAFFECTED and keep authorizing
   * work — #99 requires the ladder be pausable "without dismantling the
   * grants", and a pause that revoked everything would be a pause nobody used
   * twice. Grants keep enforcing their own expiry, ceiling and auto-revoke
   * regardless.
   */
  enabled: z.boolean(),
  /** When this snapshot was taken. `currentEvidence` is relative to it. */
  readAt: z.iso.datetime(),
  /**
   * The numbers the `requirement` sentences refer to, so a progress bar can be
   * drawn without parsing prose.
   */
  thresholds: promotionThresholdsSchema,
  states: z.array(promotionStateSchema),
});

export class PromotionLadderDto extends createZodDto(promotionLadderSchema) {}

/**
 * One class, in the same envelope as the list.
 *
 * `enabled` and `thresholds` are repeated here rather than left to the list
 * response, because a cockpit that deep-links straight to one class must not
 * have to fetch the whole ladder to discover that the ladder is switched off.
 * A rung shown without that flag reads as a live conclusion.
 */
export const promotionStateDetailSchema = z.object({
  enabled: z.boolean(),
  readAt: z.iso.datetime(),
  thresholds: promotionThresholdsSchema,
  state: promotionStateSchema,
});

export class PromotionStateDetailDto extends createZodDto(
  promotionStateDetailSchema,
) {}

export const demoteClassSchema = z
  .object({
    /**
     * Why. Optional, and worth writing: it is appended to `changeDetail`,
     * which is the only record that this demotion was a human's and not the
     * ladder's — `promotion_states` has no actor column.
     */
    note: z.string().max(2000).optional(),
  })
  .strict()
  .default({});

export class DemoteClassDto extends createZodDto(demoteClassSchema) {}

export const manualDemotionResultSchema = z.object({
  state: promotionStateSchema,
  /**
   * Active trust grants for the class that were suspended. THE DURABLE EFFECT.
   *
   * Nothing re-creates a suspended grant — only a human tapping "always
   * approve this class" can — so this is the number that says what actually
   * stopped running.
   */
  grantsSuspended: z.number().int(),
  /** Whether any transport accepted the notification. False is a real result. */
  notified: z.boolean(),
  /**
   * Whether the next evaluation would put this class straight back on the
   * promoted rung.
   *
   * TRUE is the COMMON case, not an edge one: a class demoted by hand while
   * its lifetime record still clears the bar is re-promoted by the next hourly
   * evaluation, with `changeReason: promoted_on_evidence`, because there is no
   * column recording a human hold-down. The suspended grants stay suspended
   * either way, so nothing resumes running — but the rung will read `promoted`
   * again, and an operator not told this would reasonably conclude their
   * demotion had been undone. SHOW IT.
   */
  rungMayBeRestoredByLadder: z.boolean(),
});

export class ManualDemotionResultDto extends createZodDto(
  manualDemotionResultSchema,
) {}
