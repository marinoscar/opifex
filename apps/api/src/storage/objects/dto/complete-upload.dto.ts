import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const completeUploadSchema = z.object({
  parts: z
    .array(
      z.object({
        partNumber: z.number().int().positive(),
        eTag: z.string().min(1),
      }),
    )
    .min(1),
});

export type CompleteUploadDto = z.infer<typeof completeUploadSchema>;

export class CompleteUploadBodyDto extends createZodDto(completeUploadSchema) {}
