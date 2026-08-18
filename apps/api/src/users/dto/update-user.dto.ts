import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const updateUserSchema = z.object({
  displayName: z.string().max(100).optional(),
  isActive: z.boolean().optional(),
});

export class UpdateUserDto extends createZodDto(updateUserSchema) {}
