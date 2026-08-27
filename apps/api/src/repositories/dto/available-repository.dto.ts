import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  AVAILABLE_REPOSITORY_STATUSES,
  REPOSITORY_ADMISSIONS,
} from '../available-repositories.service';

/**
 * What `GET /api/repositories/available` answers (#401).
 *
 * ## The vocabularies are imported, not restated
 *
 * The statuses and the three admissions come from the service that produces
 * them. A copy is a second thing to update, and the one that gets missed is a
 * response the schema rejects at runtime — after the work of calling GitHub
 * has already been done.
 *
 * ## Why a failure is a 200 with a `status`
 *
 * The same rule `supervisor-model-catalog.dto.ts` states. "The request failed"
 * and "the request found a failure" are the two things this endpoint exists to
 * tell apart, and behind one HTTP status they are indistinguishable to the
 * client. A missing credential, a rejected one and an unreachable GitHub are
 * all successful responses carrying a finding — and the client renders one
 * shape, always.
 */

export const availableRepositorySchema = z.object({
  owner: z.string(),
  name: z.string(),
  /** `owner/name`, so a consumer never has to reassemble it. */
  fullName: z.string(),
  description: z.string().nullable(),
  /** What a work order would branch from, straight from GitHub. */
  defaultBranch: z.string(),
  private: z.boolean(),
  /**
   * `POST /api/repositories` refuses an archived repository, so it is marked
   * here rather than offered as if it would work. It is still listed: an
   * operator hunting for a repository they can see on GitHub needs it present
   * and explained, not absent.
   */
  archived: z.boolean(),
  /** Last push, or null when GitHub did not say. Drives the default order. */
  pushedAt: z.iso.datetime().nullable(),
  /**
   * Whether this can be registered, and if not, why not.
   *
   * `registered` outranks `archived` when both apply: both make the row
   * unaddable, but only `registered` has somewhere to send the operator.
   */
  admission: z.enum(REPOSITORY_ADMISSIONS),
  /**
   * The existing registration's id when `admission` is `registered`, else
   * null — so a client can link to the row instead of only refusing the add.
   */
  repositoryId: z.uuid().nullable(),
});

export class AvailableRepositoryDto extends createZodDto(
  availableRepositorySchema,
) {}

export const availableRepositoriesSchema = z.object({
  /**
   * What happened, in one word the UI can branch on.
   *
   * Each value names a different remedy: `no_credential` means configure one,
   * `invalid_credential` means get another, `refused` means widen the token's
   * scope rather than replace it, `rate_limited` means wait, and `unreachable`
   * means nothing was ever judged.
   */
  status: z.enum(AVAILABLE_REPOSITORY_STATUSES),
  /** One human sentence, safe to render. Never contains the GitHub token. */
  detail: z.string(),
  /** The requested page. Empty on every failure, and possibly on success. */
  repositories: z.array(availableRepositorySchema),
  page: z.number().int(),
  pageSize: z.number().int(),
  /** Rows matching `search`, across all pages. */
  total: z.number().int(),
  totalPages: z.number().int(),
  /**
   * Rows the credential reaches, before `search` — a lower bound when
   * `truncated`. Published separately from `total` so a client can tell "your
   * search matched nothing" from "the token reaches nothing", which are
   * different sentences with different fixes.
   */
  reachable: z.number().int(),
  /** The search applied, echoed back. Null when none was given. */
  search: z.string().nullable(),
  /**
   * True when the listing hit its page cap, so `reachable` is partial.
   *
   * A cap that is not reported is a truncated list presented as complete,
   * which is the one way this endpoint could mislead an operator without
   * failing.
   */
  truncated: z.boolean(),
  checkedAt: z.iso.datetime(),
});

export class AvailableRepositoriesDto extends createZodDto(
  availableRepositoriesSchema,
) {}

export const listAvailableRepositoriesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  /**
   * Case-insensitive substring over `owner/name`.
   *
   * Applied to the set the token reaches, never through GitHub's search API —
   * that searches all of GitHub and would return public repositories the token
   * cannot touch, turning an honest list into a misleading one.
   */
  search: z.string().trim().min(1).max(100).optional(),
});

export class ListAvailableRepositoriesQueryDto extends createZodDto(
  listAvailableRepositoriesQuerySchema,
) {}
