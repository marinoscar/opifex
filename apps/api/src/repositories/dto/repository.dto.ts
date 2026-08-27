import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * GitHub's own rules for an owner and a repository name, enforced here rather
 * than discovered by a 404.
 *
 * A name that cannot exist is a typo, and rejecting it at the boundary with a
 * clear message beats spending a GitHub request to be told "Not Found" — which
 * is the same answer a private repository the token cannot see would give,
 * so the two would be indistinguishable in the error.
 */
const ownerSchema = z
  .string()
  .min(1)
  .max(39, 'A GitHub owner is at most 39 characters')
  .regex(
    /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/,
    'A GitHub owner may contain only letters, numbers and single hyphens, and cannot start or end with one',
  );

const repoNameSchema = z
  .string()
  .min(1)
  .max(100, 'A GitHub repository name is at most 100 characters')
  .regex(
    /^[a-zA-Z0-9._-]+$/,
    'A GitHub repository name may contain only letters, numbers, dots, hyphens and underscores',
  );

/**
 * Per-repository policy, shared by create and update.
 *
 * Everything here is optional and every default lives in the Prisma schema, so
 * a PATCH that omits a field leaves it alone rather than resetting it to a
 * default the caller never mentioned.
 */
const repositoryPolicySchema = z.object({
  /** The reconciler reads this repository each tick. */
  observeEnabled: z.boolean().optional(),
  /**
   * Work orders for this repository may be dispatched to a runner.
   *
   * Separate from `observeEnabled` because VISION §12's observation week has
   * to end ONE REPOSITORY AT A TIME — a global switch is the unsafe way to do
   * it, and a single `enabled` flag would leave no other option.
   */
  dispatchEnabled: z.boolean().optional(),
  /**
   * Opifex may write `factory/*` mirror labels to this repository.
   *
   * A third switch, not folded into `dispatchEnabled`, so VISION §12's
   * observation week can end in stages: observe, then write labels, then
   * dispatch. Collapsing them would make the first write and the first RUN
   * happen on one flag flip, and proving the write path before dispatch
   * exists is the whole point of doing labels first.
   */
  mirrorLabelsEnabled: z.boolean().optional(),
  /**
   * Opifex may comment on an issue to say why its spec was rejected (#155).
   *
   * A fourth switch rather than a reuse of `mirrorLabelsEnabled`, because the
   * two writes differ in kind: a mirror label restates a status the operator
   * already asked to see, and this is unsolicited prose addressed to a human
   * on their own issue. Turning on labels is not a request to start giving
   * people feedback.
   */
  specFeedbackEnabled: z.boolean().optional(),
  /** Per-run spend ceiling in USD. Null clears it. */
  budgetCeilingUsd: z.number().positive().max(10000).nullable().optional(),
  /** Per-run wall-clock ceiling in minutes. Null clears it. */
  wallClockTimeoutMinutes: z
    .number()
    .int()
    .positive()
    .max(1440)
    .nullable()
    .optional(),
  /** Glob constraints on what a runner may touch. Empty means unconstrained. */
  pathConstraints: z.array(z.string().min(1)).max(50).optional(),
});

export const registerRepositorySchema = repositoryPolicySchema.extend({
  owner: ownerSchema,
  name: repoNameSchema,
  /** Optional grouping. Must be an existing project. */
  projectId: z.uuid().nullable().optional(),
});

export class RegisterRepositoryDto extends createZodDto(
  registerRepositorySchema,
) {}

export const updateRepositorySchema = repositoryPolicySchema.extend({
  projectId: z.uuid().nullable().optional(),
});

export class UpdateRepositoryDto extends createZodDto(updateRepositorySchema) {}

/**
 * A repository as the API returns it.
 *
 * `budgetCeilingUsd` is a string, not a number: the column is a Postgres
 * `DECIMAL` and Prisma returns a `Decimal`. Serialising it through a JS number
 * would round a spend ceiling, which is the one field where that is least
 * acceptable.
 */
export const repositoryResponseSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid().nullable(),
  owner: z.string(),
  name: z.string(),
  /** `owner/name`, so a consumer never has to reassemble it. */
  fullName: z.string(),
  defaultBranch: z.string(),
  observeEnabled: z.boolean(),
  dispatchEnabled: z.boolean(),
  mirrorLabelsEnabled: z.boolean(),
  specFeedbackEnabled: z.boolean(),
  budgetCeilingUsd: z.string().nullable(),
  wallClockTimeoutMinutes: z.number().int().nullable(),
  pathConstraints: z.array(z.string()),
  lastObservedAt: z.iso.datetime().nullable(),
  /**
   * When this repository was stood down, or null if it never has been (#405).
   *
   * Stored, not derived from the four flags above. All four off is reachable
   * without anyone deciding anything — four PATCHes, or a registration that
   * passed `observeEnabled: false` — so it cannot distinguish a stand-down
   * from a pause. A client should read THIS field to decide whether to offer
   * "retire" or "un-retire", never the flags.
   */
  retiredAt: z.iso.datetime().nullable(),
  /** Who stood it down. Null when not retired, or when that account is gone. */
  retiredById: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export class RepositoryResponseDto extends createZodDto(
  repositoryResponseSchema,
) {}

export const listRepositoriesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  /** Filter to what the reconciler actually reads. */
  observeEnabled: z.stringbool().optional(),
  dispatchEnabled: z.stringbool().optional(),
  /**
   * Which project's repositories to return — or `none` for the ones in no
   * project at all.
   *
   * `none` is a member of this filter rather than a separate `unassigned` flag
   * because unassigned is an ANSWER to "which project", not a different
   * question. Every repository registered before projects existed is in that
   * bucket (#404), and without a way to ask for it the one group an operator
   * most needs to find would be the only group with no query that returns it.
   */
  projectId: z.union([z.uuid(), z.literal('none')]).optional(),
  /**
   * Filter on retirement. Omitted means BOTH — a retired repository is still
   * listed, because hiding it would leave an operator unable to find the thing
   * they just retired in order to un-retire it.
   */
  retired: z.stringbool().optional(),
});

export class ListRepositoriesQueryDto extends createZodDto(
  listRepositoriesQuerySchema,
) {}

/**
 * The body of a retire or un-retire request.
 *
 * Both are actions rather than resource edits, so the body carries nothing
 * about the resulting state — the whole point of #405 is that the state is not
 * the caller's to compose. All it may carry is why.
 */
export const retireRepositorySchema = z.object({
  /**
   * Free prose, recorded on the audit row.
   *
   * Optional, because requiring a justification produces the string "asdf".
   * It is the one field that can answer "was this a decision, and whose?" in
   * the operator's own words rather than by inference from a timestamp.
   */
  reason: z.string().trim().min(1).max(500).optional(),
});

export class RetireRepositoryDto extends createZodDto(retireRepositorySchema) {}
