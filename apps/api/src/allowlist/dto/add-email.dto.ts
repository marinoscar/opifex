import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const addEmailSchema = z.object({
  email: z
    .string()
    .email('Invalid email format')
    .transform((email) => email.toLowerCase()),
  notes: z.string().max(500, 'Notes must be 500 characters or less').optional(),
});

export class AddEmailDto extends createZodDto(addEmailSchema) {}
