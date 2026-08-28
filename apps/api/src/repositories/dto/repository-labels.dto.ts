import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  LABEL_ACTIONS,
  LABEL_PROVISIONING_STATUSES,
  LABEL_STATES,
} from '../../github/labels/label-provisioning.service';
import { PROVISIONED_LABEL_KINDS } from '../../github/labels/label-taxonomy';
import { repositoryResponseSchema } from './repository.dto';

/**
 * What the label endpoints answer (#415).
 *
 * ## The vocabularies are imported, not restated
 *
 * The statuses, states, actions and kinds come from the modules that produce
 * them. A copy is a second thing to update, and the one that gets missed is a
 * response the schema rejects at runtime — after the GitHub calls have already
 * been made. `available-repository.dto.ts` states the same rule.
 *
 * ## Why a failure is a 200 with a `status`
 *
 * "The request failed" and "the request found a failure" are the two things
 * these endpoints exist to tell apart, and behind one HTTP status they are
 * indistinguishable to the client. A token that can read a repository and
 * cannot write its labels — the likeliest failure, and unknowable in advance
 * with the fine-grained PAT ADR-0001 chose — is a successful answer carrying a
 * finding. The client renders one shape, always.
 *
 * ## Why the counts are nullable rather than a discriminated union
 *
 * The stronger version of "a report that was never read has no counts" is a
 * union: two branches, one with the count fields and one without, so an unread
 * report cannot express a count even in principle. It was considered and not
 * taken, for a reason specific to this shape rather than a general preference.
 *
 * The only honest discriminator is `status`, and `status` does not split the
 * way a union needs. Its nine values divide 2/7 between read and unread, so a
 * discriminated union would need either nine branches — seven of them
 * identical — or a discriminator over a SET of literals, which
 * `z.discriminatedUnion` does not express and which degrades to a plain
 * `z.union`. A plain union publishes `anyOf` with no `discriminator` mapping,
 * which gives a generated client no narrowing that `present !== null` does not
 * already give it, while making every consumer destructure through a type
 * guard to reach `detail` and `status` — fields that are present on both
 * branches and that the failure path is mostly about.
 *
 * And `status` is the wrong discriminator anyway: a REFUSED WRITE has real
 * counts, because the read succeeded and only the write that followed was
 * refused. Keying the union on `status` would have to null those counts to
 * keep the branches honest, which throws away a genuine observation to satisfy
 * the type. The condition that matters is "were the labels read", and that is
 * not a status.
 *
 * So: seven nullable fields, null together or populated together, with the
 * meaning stated on each. The rule is pinned by
 * `label-provisioning.service.spec.ts` rather than left to review.
 */

export const labelStateSchema = z.object({
  name: z.string(),
  /** `input`, `mirror` or `routing`. Never an organisational label. */
  kind: z.enum(PROVISIONED_LABEL_KINDS),
  /**
   * What GitHub had BEFORE this call — the observation, not the outcome.
   *
   * Deliberately not rewritten when a write succeeds: a UI that showed
   * `present` for a label it just created could not say that anything
   * happened. The name carries the tense so a consumer does not have to
   * remember it — `state` would be plainly false about the present the moment
   * a POST succeeds. Read `action` for what this call did.
   */
  stateBefore: z.enum(LABEL_STATES),
  /** What this call did about it. `none` for an inspection. */
  action: z.enum(LABEL_ACTIONS),
  /** For `drifted`: what differs, e.g. `color ededed -> d93f0b`. */
  differences: z.array(z.string()),
  /** Why the write failed, when `action` is `failed`. Else null. */
  detail: z.string().nullable(),
});

export class LabelStateDto extends createZodDto(labelStateSchema) {}

export const labelProvisioningReportSchema = z.object({
  /** `owner/name`. */
  repository: z.string(),
  /**
   * True only when every declared label is present and matches.
   *
   * The same `{ ok, detail, checkedAt }` triple the Test buttons answer with
   * (`operator-probe.dto.ts`), because this is the same kind of thing: an
   * OBSERVATION of a deployment, taken at a moment, not a stored fact.
   */
  ok: z.boolean(),
  status: z.enum(LABEL_PROVISIONING_STATUSES),
  /**
   * True when this call TRIED to write; false for an inspection.
   *
   * Not "the writes landed" — a refused repair is `attempted: true` having
   * written nothing. The outcome is `status`, `created` and `failed`.
   */
  attempted: z.boolean(),
  /** One human sentence, safe to render. Never contains the GitHub token. */
  detail: z.string(),
  checkedAt: z.iso.datetime(),

  // --- The counts. NULL MEANS NOT READ. It never means zero. ---------------
  //
  // Nullable rather than merely documented, because `present: 0` on a report
  // whose read was refused is a claim nobody established — the token could not
  // see the repository's labels, so nothing at all is known about them.
  // Publishing a zero there invites every consumer to render "0 of 15 labels
  // present", which is a lie with a plausible shape. Null cannot be rendered
  // as a count by accident.
  //
  // All seven are null together or populated together, so one check gates
  // them all. A refused WRITE keeps its counts: the read succeeded and only
  // the write failed. Do not infer nullness from `status`; check the null.

  /** The M in "N of M labels present". Null when the labels were not read. */
  declared: z.number().int().nullable(),
  /**
   * The N — how many exist on GitHub as of `checkedAt`.
   *
   * **Null means the labels could not be read, not that there are none.**
   */
  present: z.number().int().nullable(),
  /** Null when not read. */
  missing: z.number().int().nullable(),
  /** Null when not read. */
  created: z.number().int().nullable(),
  /** Null when not read. */
  updated: z.number().int().nullable(),
  /**
   * Already present and already correct: a no-op, reported as one. Null when
   * the labels were not read.
   */
  unchanged: z.number().int().nullable(),
  /** Null when not read. */
  failed: z.number().int().nullable(),
  /**
   * Per-label state, so a client can NAME what is missing.
   *
   * Empty when the repository's labels could not be read at all — a 404, a
   * rejected credential, an unreachable GitHub. `status` says which, and that
   * is the same condition under which every count above is null.
   */
  labels: z.array(labelStateSchema),
});

export class LabelProvisioningReportDto extends createZodDto(
  labelProvisioningReportSchema,
) {}

/**
 * `POST /api/repositories`' answer: the repository, plus what happened to its
 * labels.
 *
 * A separate schema rather than a field on `repositoryResponseSchema`, because
 * label provisioning is an EVENT of the registration, not a property of the
 * repository. Putting it on the shared shape would oblige `GET /api/
 * repositories` to call GitHub fifteen times per row, or to publish a field
 * that is always null there — and a field that is null everywhere except one
 * endpoint teaches clients to ignore it.
 */
export const registeredRepositorySchema = repositoryResponseSchema.extend({
  /**
   * What provisioning did, or why it could not.
   *
   * **Never null in practice, and nullable in the schema on purpose.**
   * Registration must succeed even when provisioning fails — ADR-0001's
   * fine-grained token can read a repository it cannot label, and a
   * registration that failed for that reason would leave the operator with
   * nothing registered and no explanation. Null is the belt-and-braces case: a
   * bug in provisioning itself must not cost a registration either.
   */
  labelProvisioning: labelProvisioningReportSchema.nullable(),
});

export class RegisteredRepositoryDto extends createZodDto(
  registeredRepositorySchema,
) {}
