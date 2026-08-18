import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const updateUserRolesSchema = z.object({
  roleNames: z.array(z.string()).min(1, 'At least one role is required'),
});

export class UpdateUserRolesDto extends createZodDto(updateUserRolesSchema) {}
