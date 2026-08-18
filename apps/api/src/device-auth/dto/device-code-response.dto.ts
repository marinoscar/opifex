import { ApiProperty } from '@nestjs/swagger';

/**
 * Response DTO for device code generation
 * Follows RFC 8628 specification
 */
export class DeviceCodeResponseDto {
  @ApiProperty({
    description: 'Device verification code (opaque string for device)',
    example: 'a4f3b8c9d2e1f5a6b7c8d9e0f1a2b3c4',
  })
  deviceCode!: string;

  @ApiProperty({
    description: 'User verification code (human-readable)',
    example: 'ABCD-1234',
  })
  userCode!: string;

  @ApiProperty({
    description: 'End-user verification URI',
    example: 'http://localhost:3535/device',
  })
  verificationUri!: string;

  @ApiProperty({
    description: 'Complete verification URI with user code pre-filled',
    example: 'http://localhost:3535/device?code=ABCD-1234',
  })
  verificationUriComplete!: string;

  @ApiProperty({
    description: 'Lifetime in seconds of device_code and user_code',
    example: 900,
  })
  expiresIn!: number;

  @ApiProperty({
    description: 'Minimum polling interval in seconds',
    example: 5,
  })
  interval!: number;
}
