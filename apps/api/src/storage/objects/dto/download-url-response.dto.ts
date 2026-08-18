import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const downloadUrlResponseSchema = z.object({
  /** Time-limited signed URL. Fetch it directly; it does not carry an Authorization header. */
  url: z.url(),
  /** Seconds until the URL stops working. */
  expiresIn: z.number().int().positive(),
});

export class DownloadUrlResponseDto extends createZodDto(downloadUrlResponseSchema) {}
