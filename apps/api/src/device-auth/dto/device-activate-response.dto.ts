import { ApiProperty } from '@nestjs/swagger';

/**
 * Response DTO for activation page information
 */
export class DeviceActivateResponseDto {
  @ApiProperty({
    description: 'Verification URI base',
    example: 'http://localhost:3535/device',
  })
  verificationUri!: string;

  @ApiProperty({
    description: 'User verification code (if provided in query)',
    example: 'ABCD-1234',
    required: false,
  })
  userCode?: string;

  @ApiProperty({
    description: 'Client information for the device (if code is valid)',
    required: false,
  })
  clientInfo?: Record<string, any>;

  @ApiProperty({
    description: 'Expiration timestamp (if code is valid)',
    example: '2026-01-22T12:00:00Z',
    required: false,
  })
  expiresAt?: string;
}
