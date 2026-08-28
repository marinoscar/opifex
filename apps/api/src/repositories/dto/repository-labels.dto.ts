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
   * happened. Read `action` for what this call did.
   */
  state: z.enum(LABEL_STATES),
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
  /** True when the call attempted writes; false for an inspection. */
  applied: z.boolean(),
  /** One human sentence, safe to render. Never contains the GitHub token. */
  detail: z.string(),
  checkedAt: z.iso.datetime(),
  /** The M in "N of M labels present". */
  declared: z.number().int(),
  /** The N — how many exist on GitHub as of `checkedAt`. */
  present: z.number().int(),
  missing: z.number().int(),
  created: z.number().int(),
  updated: z.number().int(),
  /** Already present and already correct: a no-op, reported as one. */
  unchanged: z.number().int(),
  failed: z.number().int(),
  /**
   * Per-label state, so a client can NAME what is missing.
   *
   * Empty when the repository's labels could not be read at all — a 404, a
   * rejected credential, an unreachable GitHub. `status` says which.
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
