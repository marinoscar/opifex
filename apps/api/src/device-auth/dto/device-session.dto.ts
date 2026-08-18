import { ApiProperty } from '@nestjs/swagger';

/**
 * DTO representing a device session
 */
export class DeviceSessionDto {
  @ApiProperty({
    description: 'Device session ID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  id!: string;

  @ApiProperty({
    description: 'User verification code',
    example: 'ABCD-1234',
  })
  userCode!: string;

  @ApiProperty({
    description: 'Device status',
    enum: ['pending', 'approved', 'denied', 'expired'],
    example: 'approved',
  })
  status!: string;

  @ApiProperty({
    description: 'Client information',
    required: false,
  })
  clientInfo?: Record<string, any>;

  @ApiProperty({
    description: 'When the device was authorized',
    example: '2026-01-22T10:30:00Z',
  })
  createdAt!: string;

  @ApiProperty({
    description: 'When the session expires',
    example: '2026-01-22T10:45:00Z',
  })
  expiresAt!: string;
}

/**
 * Paginated response DTO for device sessions
 */
export class DeviceSessionsResponseDto {
  @ApiProperty({
    description: 'Array of device sessions',
    type: [DeviceSessionDto],
  })
  sessions!: DeviceSessionDto[];

  @ApiProperty({
    description: 'Total count of sessions',
    example: 10,
  })
  total!: number;

  @ApiProperty({
    description: 'Current page number',
    example: 1,
  })
  page!: number;

  @ApiProperty({
    description: 'Page size',
    example: 10,
  })
  limit!: number;
}
