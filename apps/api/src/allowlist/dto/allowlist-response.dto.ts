import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * One allowlist entry as `AllowlistService` returns it: the `allowed_emails`
 * row plus the two user relations it `include`s, each narrowed to `{ id, email }`.
 *
 * Written to match that query, not the Prisma model — the model has more
 * columns on the relations, and documenting those would describe a payload this
 * endpoint does not send.
 */
const allowlistActorSchema = z.object({
  id: z.uuid(),
  email: z.email(),
});

export const allowlistEntrySchema = z.object({
  id: z.uuid(),
  email: z.email(),
  addedById: z.uuid().nullable(),
  addedAt: z.iso.datetime(),
  /** Set once the invited address completes its first sign-in. */
  claimedById: z.uuid().nullable(),
  claimedAt: z.iso.datetime().nullable(),
  notes: z.string().nullable(),
  addedBy: allowlistActorSchema.nullable(),
  claimedBy: allowlistActorSchema.nullable(),
});

export class AllowlistEntryDto extends createZodDto(allowlistEntrySchema) {}
