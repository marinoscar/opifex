import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Request DTO for polling device authorization status
 */
export const DeviceTokenRequestSchema = z.object({
  deviceCode: z.string().min(1, 'Device code is required'),
});

export class DeviceTokenRequestDto extends createZodDto(DeviceTokenRequestSchema) {
  @ApiProperty({
    description: 'Device verification code received from /device/code endpoint',
    example: 'a4f3b8c9d2e1f5a6b7c8d9e0f1a2b3c4',
  })
  deviceCode!: string;
}
