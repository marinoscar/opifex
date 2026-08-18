import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Request DTO for authorizing a device
 */
export const DeviceAuthorizeRequestSchema = z.object({
  userCode: z
    .string()
    .min(1, 'User code is required')
    .regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/, 'Invalid user code format'),
  approve: z.boolean(),
});

export class DeviceAuthorizeRequestDto extends createZodDto(DeviceAuthorizeRequestSchema) {
  @ApiProperty({
    description: 'User verification code to authorize',
    example: 'ABCD-1234',
    pattern: '^[A-Z0-9]{4}-[A-Z0-9]{4}$',
  })
  userCode!: string;

  @ApiProperty({
    description: 'Whether to approve or deny the device',
    example: true,
  })
  approve!: boolean;
}
