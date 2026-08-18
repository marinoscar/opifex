import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const updateMetadataSchema = z.object({
  /** Merged into the object's existing metadata rather than replacing it. */
  metadata: z.record(z.string(), z.unknown()),
});

export type UpdateMetadataDto = z.infer<typeof updateMetadataSchema>;

export class UpdateMetadataBodyDto extends createZodDto(updateMetadataSchema) {}
