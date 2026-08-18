import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const allowlistQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().optional(),
  status: z.enum(['all', 'pending', 'claimed']).default('all'),
  sortBy: z.enum(['email', 'addedAt', 'claimedAt']).default('addedAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export class AllowlistQueryDto extends createZodDto(allowlistQuerySchema) {}
