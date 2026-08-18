import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Client info schema for device authorization requests
 */
export const ClientInfoSchema = z.object({
  deviceName: z.string().optional(),
  userAgent: z.string().optional(),
});

/**
 * Request DTO for initiating device authorization flow
 */
export const DeviceCodeRequestSchema = z.object({
  clientInfo: ClientInfoSchema.optional(),
});

export class DeviceCodeRequestDto extends createZodDto(DeviceCodeRequestSchema) {
  @ApiProperty({
    description: 'Optional client information',
    required: false,
  })
  clientInfo?: {
    deviceName?: string;
    userAgent?: string;
  };
}
