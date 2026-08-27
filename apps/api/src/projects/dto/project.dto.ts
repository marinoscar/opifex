import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  PROJECT_SLUG_MAX_LENGTH,
  PROJECT_SLUG_MESSAGE,
  PROJECT_SLUG_PATTERN,
} from '../slug';

/**
 * An operator-supplied slug, validated against the same alphabet derivation
 * produces. One alphabet, not two: a supplied slug that derivation could never
 * have produced would make `billing-platform` and `Billing_Platform` two
 * different handles for the same idea depending on which path created them.
 */
const slugSchema = z
  .string()
  .min(1)
  .max(
    PROJECT_SLUG_MAX_LENGTH,
    `A project slug is at most ${PROJECT_SLUG_MAX_LENGTH} characters`,
  )
  .regex(PROJECT_SLUG_PATTERN, PROJECT_SLUG_MESSAGE);

const nameSchema = z.string().trim().min(1).max(120);

/**
 * `null` and absent mean different things and both are accepted: absent leaves
 * the description alone on a PATCH, `null` clears it.
 */
const descriptionSchema = z.string().trim().max(2000).nullable();

export const createProjectSchema = z.object({
  name: nameSchema,
  /**
   * Optional. Omitted, it is derived from `name` — once, at creation.
   *
   * Supplying one is how an operator gets a handle shorter or steadier than
   * the name: `{ name: "Billing Platform (2026)", slug: "billing" }`.
   */
  slug: slugSchema.optional(),
  description: descriptionSchema.optional(),
});

export class CreateProjectDto extends createZodDto(createProjectSchema) {}

/**
 * Every field optional, so a PATCH that omits one leaves it alone.
 *
 * `slug` is changeable but never RE-DERIVED: renaming a project leaves its
 * handle where it was, and moving the handle has to be asked for explicitly
 * because everything that linked to the project used it.
 */
export const updateProjectSchema = z
  .object({
    name: nameSchema.optional(),
    slug: slugSchema.optional(),
    description: descriptionSchema.optional(),
  })
  // A PATCH with no recognised field is a caller bug — most often a
  // misspelled key — and answering 200 with the row unchanged would report
  // success for a write that did nothing.
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one of name, slug or description',
  });

export class UpdateProjectDto extends createZodDto(updateProjectSchema) {}

/**
 * A project as the API returns it.
 *
 * `repositoryCount` is included because the only question anybody asks of a
 * project list is how much is in each one, and answering it per row otherwise
 * costs a request per project.
 */
export const projectResponseSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  /** How many repositories are assigned to this project right now. */
  repositoryCount: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export class ProjectResponseDto extends createZodDto(projectResponseSchema) {}

export const listProjectsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  /** Case-insensitive substring over the name and the slug. */
  search: z.string().trim().min(1).max(120).optional(),
});

export class ListProjectsQueryDto extends createZodDto(
  listProjectsQuerySchema,
) {}

/**
 * What deleting a project actually did.
 *
 * A 204 would be shorter and would hide the one fact worth stating: the
 * repositories were NOT deleted with it. Returning the count makes the
 * non-cascade guarantee visible in the API's own answer — a caller can say
 * "3 repositories are now unassigned" — rather than leaving it as something
 * a reader has to go and confirm in the schema.
 */
export const projectDeletionResponseSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  /**
   * Repositories that were in this project and are now unassigned. They are
   * still registered, still observed, and still enableable: `projectId: null`
   * is a first-class state, not a broken one.
   */
  unassignedRepositories: z.number().int(),
});

export class ProjectDeletionResponseDto extends createZodDto(
  projectDeletionResponseSchema,
) {}
