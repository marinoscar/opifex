import { z } from 'zod';
import { ObjectResponseDto } from './object-response.dto';

export const objectListQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
  status: z
    .enum(['pending', 'uploading', 'processing', 'ready', 'failed'])
    .optional(),
  sortBy: z.enum(['createdAt', 'name', 'size']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export type ObjectListQueryDto = z.infer<typeof objectListQuerySchema>;

/**
 * The NESTED list shape — counts live in a `meta` object inside the payload,
 * and the total is named `totalItems`. The flat lists (`GET /api/users`,
 * `GET /api/allowlist`) spell the same concept differently; see
 * `ApiDataResponse` for why that asymmetry is documented rather than hidden.
 *
 * Left as an interface: the controller documents this shape through
 * `@ApiDataResponse(ObjectResponseDto, { pagination: 'nested' })`, which is
 * where the published schema comes from, so a parallel zod schema here would be
 * a second declaration to keep in step for no gain.
 */
export interface ObjectListResponseDto {
  items: ObjectResponseDto[];
  meta: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
  };
}
