import { ApiProperty } from '@nestjs/swagger';

/**
 * Response DTO for device authorization action
 */
export class DeviceAuthorizeResponseDto {
  @ApiProperty({
    description: 'Whether the operation was successful',
    example: true,
  })
  success!: boolean;

  @ApiProperty({
    description: 'Result message',
    example: 'Device authorized successfully',
  })
  message!: string;
}
