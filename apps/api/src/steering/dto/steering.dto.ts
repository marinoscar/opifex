import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  INPUT_LABELS,
  type InputLabel,
} from '../../github/labels/factory-labels';
import { MAX_EPIC_DEPTH } from '../../github/read/epic-children.types';

/**
 * The steering contract: an instruction in, a PROPOSED label diff out (#425).
 *
 * ## What is deliberately not here
 *
 * There is no scope object, no priority, no ordering, and no identifier for a
 * stored proposal. Epic #419's architectural commitment is that the chat is a
 * translator and not a controller: the diff lands as GitHub labels and Opifex
 * stores no scope of its own. A `scope` table the dispatcher consulted would
 * make labels and that table two expressions of the same intent, leaving the
 * reconciler to arbitrate between them — the two-sources-of-truth bug epic
 * #332 spent twenty-one issues removing, rebuilt somewhere new.
 *
 * The proposal is therefore returned to the CLIENT and handed back on apply.
 * That is why `SteeringApplyDto` carries the operations rather than a row id:
 * there is no row.
 */

/** How long a proposal may be held before it must be asked for again. */
export const PROPOSAL_TTL_MINUTES = 30;

/**
 * The two labels steering may write, and the one it may not.
 *
 * `factory:clear-quarantine` is absent, and its absence IS the enforcement —
 * the same argument `queue.controller.ts` makes for having no clear-quarantine
 * endpoint. #49 requires a human apply that label on GitHub, where the
 * applier's identity is native and verifiable from the issue timeline;
 * accepting it here would launder the actor through the Opifex token and make
 * VISION §8's rule that an agent cannot clear its own quarantine
 * unenforceable. A validated enum rather than a comment, so an apply request
 * naming it is rejected by the pipe before any service sees it.
 */
export const STEERABLE_LABELS = [
  INPUT_LABELS.READY,
  INPUT_LABELS.HOLD,
] as const;

export const steerableLabelSchema = z.enum(STEERABLE_LABELS);

export type SteerableLabel = (typeof STEERABLE_LABELS)[number];

/** `owner/name`, as an operator and a work-order identity both write it. */
export const repositorySlugSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
    'Expected a repository as `owner/name`',
  );

// ---------------------------------------------------------------------------
// Propose
// ---------------------------------------------------------------------------

export const proposeSteeringSchema = z.object({
  /**
   * What the operator said, verbatim.
   *
   * Bounded at 2000 characters because it is echoed into the proposal, into
   * the audit row and — when one is eventually asked — into a model prompt.
   * An unbounded instruction is an unbounded audit row.
   */
  instruction: z.string().trim().min(1).max(2000),
  /**
   * Which repository a bare `#12` means, and the only one swept for
   * "everything else".
   *
   * Optional. Omitted, a bare number resolves against the single registered
   * repository when there is exactly one, and is reported as
   * `ambiguous-repository` when there is more than one — guessing would write
   * labels to an issue in a repository the operator was not thinking about.
   */
  repository: repositorySlugSchema.optional(),
  /**
   * How many levels of an epic to walk. Defaults to 1 in `EpicChildrenService`.
   *
   * That default is argued there and is not restated: "everything under this"
   * and "the issues directly listed here" are different instructions, and a
   * transitive walk that silently pulled in a nested epic's children would
   * widen a destructive action beyond what was asked for.
   */
  maxDepth: z.coerce.number().int().min(1).max(MAX_EPIC_DEPTH).optional(),
});

export class ProposeSteeringDto extends createZodDto(proposeSteeringSchema) {}

/**
 * Why a reference in the instruction produced no operation.
 *
 * An outcome, never an error — the same shape `issue-projection.ts` gives a
 * rejected issue, and for the same reason: an operator who names an issue that
 * was closed yesterday has not made an error worth a 400, they have made an
 * observation worth reading. Distinct values because they call for completely
 * different responses.
 */
export const unresolvedReasonSchema = z.enum([
  /** No such issue, or the token cannot see it. GitHub does not distinguish. */
  'issue-not-found',
  /** It exists and is closed. Steering a closed issue does nothing. */
  'issue-closed',
  /** GitHub returned a pull request. There is no work order behind one. */
  'is-pull-request',
  /** The repository is not registered with Opifex, so it is not observed. */
  'repository-not-registered',
  /** A bare `#12` with more than one registered repository to mean. */
  'ambiguous-repository',
  /** The epic resolved, but this child could not be read. */
  'unreadable',
  /** The parser did not understand, and no model was asked. See `interpretation`. */
  'needs-interpretation',
]);

export const unresolvedReferenceSchema = z.object({
  /** As the operator wrote it, or the resolved `owner/name#12`. */
  reference: z.string(),
  reason: unresolvedReasonSchema,
  /** One sentence an operator can act on. */
  detail: z.string(),
});

export const steeringOperationSchema = z.object({
  /** `owner/name#123`. Stable across repositories, unlike a bare number. */
  ref: z.string(),
  owner: z.string(),
  name: z.string(),
  number: z.number().int(),
  title: z.string().nullable(),
  /** Labels to apply. Never `factory:clear-quarantine` — see `STEERABLE_LABELS`. */
  add: z.array(steerableLabelSchema),
  /**
   * Labels to REMOVE, carried beside `add` and never folded into it.
   *
   * #425 requires removals be as prominent as additions, because they are the
   * destructive half: un-readying an issue discards intent an operator may
   * have set deliberately weeks ago, and a diff that showed only what it was
   * about to add would hide exactly the part worth confirming.
   */
  remove: z.array(steerableLabelSchema),
  /**
   * The recognised `factory:` input labels on the issue AT PROPOSE TIME.
   *
   * This is the baseline apply re-checks against. Carried on the wire rather
   * than stored, because storing it would be the second source of truth this
   * whole design refuses to create.
   */
  observedInputLabels: z.array(z.string()),
  /** Why this issue is in the diff, in one line. */
  reason: z.string(),
  /**
   * True when the operator NAMED this issue; false when it is collateral.
   *
   * The 17 issues an "only" clause un-readies are not what the operator was
   * thinking about, and a UI that rendered them identically to the three they
   * typed would bury the blast radius inside the list that states it.
   */
  named: z.boolean(),
});

export const steeringBlastRadiusSchema = z.object({
  issuesAffected: z.number().int(),
  /** Issues the operator named that will gain a label. */
  named: z.number().int(),
  /** Issues NOT named that are touched anyway, by an "only" clause. */
  collateral: z.number().int(),
  labelsAdded: z.number().int(),
  labelsRemoved: z.number().int(),
  /** How many issues lose `factory:ready`. The number that matters. */
  unreadied: z.number().int(),
  /** How many issues gain `factory:ready`. */
  readied: z.number().int(),
  /** How many issues gain `factory:hold`. */
  held: z.number().int(),
  /** True when anything at all is removed. Renders the confirmation warning. */
  destructive: z.boolean(),
  /** "This will un-ready 17 issues." One sentence, already written. */
  summary: z.string(),
});

export const steeringInterpretationSchema = z.object({
  /** `deterministic` when the parser understood; `none` when it did not. */
  method: z.enum(['deterministic', 'none']),
  /**
   * Whether a model was called. FALSE on every path today.
   *
   * Reported rather than implied, because "the parser handled it" and "a model
   * would have been asked and could not be" are different states with the same
   * response body otherwise, and only the second is something to fix.
   */
  modelInvoked: z.boolean(),
  /** What the parser understood, or why it did not. */
  notes: z.array(z.string()),
  /** Null when the parse was confident. */
  ambiguity: z.string().nullable(),
  /**
   * Whether the chat model COULD answer, from `modelReadiness` (#423).
   *
   * NULL when the parser understood the instruction, and that null is a claim
   * rather than a missing field: on the deterministic path the chat's settings
   * are not read at all, so there is nothing to report. Reporting a readiness
   * the endpoint never consulted would make "no model was involved" unfalsifiable
   * from the response.
   */
  model: z
    .object({
      consumer: z.literal('chat'),
      provider: z.string(),
      model: z.string(),
      available: z.boolean(),
      unavailableReason: z.string().nullable(),
    })
    .nullable(),
  /**
   * Whether the chat is ALLOWED to spend. Null on the deterministic path,
   * `admitted: false` on every other path today — see `chat-spend-gate.ts`.
   */
  spend: z
    .object({
      admitted: z.boolean(),
      reason: z.string(),
    })
    .nullable(),
});

export const steeringScopeSchema = z.object({
  intent: z.enum(['ready', 'hold']),
  exclusive: z.boolean(),
  elseIntent: z.enum(['unready', 'hold']),
  /** Every repository swept for the "everything else" set. */
  repositories: z.array(z.string()),
  /** Open issues carrying `factory:ready` that were considered. */
  candidatesConsidered: z.number().int(),
  /** How an epic reference was resolved, when one was named. Null otherwise. */
  epics: z.array(
    z.object({
      ref: z.string(),
      title: z.string(),
      /** `sub-issues-api`, `issue-body`, or `none` (#424). */
      source: z.string(),
      maxDepth: z.number().int(),
      childrenFound: z.number().int(),
      /** Why the native relationship did not answer. Null when it did. */
      nativeUnavailable: z.string().nullable(),
    }),
  ),
});

export const steeringProposalSchema = z.object({
  proposalId: z.uuid(),
  proposedAt: z.iso.datetime(),
  /** `proposedAt` + `PROPOSAL_TTL_MINUTES`. Apply refuses a proposal past it. */
  expiresAt: z.iso.datetime(),
  instruction: z.string(),
  interpretation: steeringInterpretationSchema,
  scope: steeringScopeSchema,
  operations: z.array(steeringOperationSchema),
  blastRadius: steeringBlastRadiusSchema,
  unresolved: z.array(unresolvedReferenceSchema),
});

export class SteeringProposalDto extends createZodDto(steeringProposalSchema) {}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export const applySteeringOperationSchema = z.object({
  owner: z.string().min(1),
  name: z.string().min(1),
  number: z.number().int().positive(),
  add: z.array(steerableLabelSchema),
  remove: z.array(steerableLabelSchema),
  /** The baseline the proposal observed. Drift is measured against this. */
  observedInputLabels: z.array(z.string()),
});

export const applySteeringSchema = z.object({
  proposalId: z.uuid(),
  proposedAt: z.iso.datetime(),
  /** Echoed back so the audit row records what was actually instructed. */
  instruction: z.string().trim().min(1).max(2000),
  operations: z.array(applySteeringOperationSchema).min(1),
});

export class ApplySteeringDto extends createZodDto(applySteeringSchema) {}

/** Why one operation in a confirmed proposal was not carried out. */
export const skippedReasonSchema = z.enum([
  /**
   * The issue's input labels changed between propose and apply.
   *
   * Skipped, not applied and not fatal to the batch. The operator confirmed a
   * diff against a specific observation; an issue whose labels moved since is
   * one they have not seen. Aborting the whole apply instead would let one
   * unrelated edit discard nineteen correct operations.
   */
  'drift',
  'issue-not-found',
  'issue-closed',
  'is-pull-request',
  'repository-not-registered',
]);

export const labelDriftSchema = z.object({
  label: z.string(),
  /** Present on the issue when the proposal was made. */
  wasPresent: z.boolean(),
  /** Present now. */
  isPresent: z.boolean(),
});

export const appliedOperationSchema = z.object({
  ref: z.string(),
  add: z.array(steerableLabelSchema),
  remove: z.array(steerableLabelSchema),
  writes: z.array(
    z.object({
      label: steerableLabelSchema,
      operation: z.enum(['add', 'remove']),
      /** False when `github.writesEnabled` suppressed it. */
      performed: z.boolean(),
      /** True when the desired state already held. */
      noop: z.boolean(),
    }),
  ),
});

export const skippedOperationSchema = z.object({
  ref: z.string(),
  reason: skippedReasonSchema,
  detail: z.string(),
  /** Non-empty only for `drift`. */
  drift: z.array(labelDriftSchema),
});

export const steeringApplyResultSchema = z.object({
  proposalId: z.uuid(),
  applied: z.array(appliedOperationSchema),
  skipped: z.array(skippedOperationSchema),
  /**
   * Whether any label actually reached GitHub.
   *
   * The same field, meaning the same thing, as `QueueSteeringService`'s — a
   * second vocabulary for "recorded, not performed" would let two steering
   * paths describe the same kill switch differently.
   */
  labelWritten: z.boolean(),
  /** The kill switch as it stood for this call. */
  writesEnabled: z.boolean(),
  /** Always false. Reconciliation is a later tick's job, never this call's. */
  reconciled: z.boolean(),
  effect: z.string(),
  summary: z.object({
    operationsRequested: z.number().int(),
    operationsApplied: z.number().int(),
    operationsSkipped: z.number().int(),
    labelWrites: z.number().int(),
    labelWritesPerformed: z.number().int(),
  }),
});

export class SteeringApplyResultDto extends createZodDto(
  steeringApplyResultSchema,
) {}

export type SteeringProposal = z.infer<typeof steeringProposalSchema>;
export type SteeringOperation = z.infer<typeof steeringOperationSchema>;
export type SteeringApplyResult = z.infer<typeof steeringApplyResultSchema>;
export type UnresolvedReference = z.infer<typeof unresolvedReferenceSchema>;
export type UnresolvedReason = z.infer<typeof unresolvedReasonSchema>;

/** Compile-time proof that the steerable set excludes the quarantine label. */
const _neverSteerable: Exclude<InputLabel, SteerableLabel> =
  INPUT_LABELS.CLEAR_QUARANTINE;
void _neverSteerable;
