import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { StorageObjectStatus } from '@prisma/client';

/**
 * Storage object metadata as returned to a caller.
 *
 * Declared as a zod schema rather than a bare TypeScript `interface` because an
 * interface is erased at compile time: `@ApiResponse({ type: ObjectResponseDto })`
 * against one produced nothing, and the controller fell back to `type: Object`,
 * publishing an empty schema. A `createZodDto` class is both the compile-time
 * type the service already used and a real JSON Schema in the document.
 */
export const objectResponseSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  /** BigInt serialized as a string — 64-bit values lose precision as JSON numbers. */
  size: z.string(),
  mimeType: z.string(),
  status: z.enum(StorageObjectStatus),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export class ObjectResponseDto extends createZodDto(objectResponseSchema) {}

export const uploadStatusResponseSchema = z.object({
  objectId: z.uuid(),
  status: z.enum(StorageObjectStatus),
  /** Part numbers already uploaded, so a resuming client knows what to skip. */
  uploadedParts: z.array(z.number().int()),
  totalParts: z.number().int(),
  uploadedBytes: z.string(),
  totalBytes: z.string(),
});

export class UploadStatusResponseDto extends createZodDto(
  uploadStatusResponseSchema,
) {}
