import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  dataTablesSchema,
  navigationSchema,
} from '../../common/schemas/user-settings-namespaces.schema';

export const userSettingsResponseSchema = z.object({
  theme: z.enum(['light', 'dark', 'system']),
  profile: z.object({
    displayName: z.string().nullable().optional(),
    useProviderImage: z.boolean(),
    customImageUrl: z.string().url().nullable().optional(),
  }),
  // Emitted only when the user has stored something for the namespace; an
  // absent namespace means "client should apply its built-in defaults".
  dataTables: dataTablesSchema.optional(),
  navigation: navigationSchema.optional(),
  updatedAt: z.iso.datetime(),
  version: z.number(),
});

export class UserSettingsResponseDto extends createZodDto(
  userSettingsResponseSchema,
) {}
