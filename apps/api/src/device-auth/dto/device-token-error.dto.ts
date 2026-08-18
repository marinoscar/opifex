import { ApiProperty } from '@nestjs/swagger';

/**
 * Error response DTO for device token polling
 * Follows RFC 8628 error codes
 */
export class DeviceTokenErrorDto {
  @ApiProperty({
    description: 'Error code',
    enum: ['authorization_pending', 'slow_down', 'expired_token', 'access_denied'],
    example: 'authorization_pending',
  })
  error!: string;

  @ApiProperty({
    description: 'Human-readable error description',
    example: 'The authorization request is still pending',
  })
  error_description!: string;
}
