import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const userResponseSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  displayName: z.string().nullable(),
  providerDisplayName: z.string().nullable(),
  profileImageUrl: z.string().url().nullable(),
  providerProfileImageUrl: z.string().url().nullable(),
  isActive: z.boolean(),
  roles: z.array(z.string()),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export class UserResponseDto extends createZodDto(userResponseSchema) {}

// List response with pagination
export const userListResponseSchema = z.object({
  items: z.array(userResponseSchema),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
  totalPages: z.number(),
});

export class UserListResponseDto extends createZodDto(userListResponseSchema) {}

/**
 * `GET /api/users/{id}` returns everything in {@link userResponseSchema} plus
 * the linked OAuth identities. It is the one user payload that differs, so it
 * gets its own schema rather than being documented as a `UserResponseDto` that
 * silently omits a field the endpoint actually sends.
 */
export const userDetailResponseSchema = userResponseSchema.extend({
  identities: z.array(
    z.object({
      provider: z.string(),
      providerEmail: z.string().nullable(),
      createdAt: z.iso.datetime(),
    }),
  ),
});

export class UserDetailResponseDto extends createZodDto(userDetailResponseSchema) {}
