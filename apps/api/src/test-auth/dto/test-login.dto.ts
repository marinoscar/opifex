import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const testLoginSchema = z.object({
  email: z.string().email(),
  role: z.enum(['admin', 'contributor', 'viewer']).optional().default('viewer'),
  displayName: z.string().optional(),
});

export class TestLoginDto extends createZodDto(testLoginSchema) {}
