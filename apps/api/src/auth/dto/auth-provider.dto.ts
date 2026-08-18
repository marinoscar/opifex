import { ApiProperty } from '@nestjs/swagger';

/**
 * OAuth provider information
 */
export class AuthProviderDto {
  @ApiProperty({
    example: 'google',
    description: 'OAuth provider name',
  })
  name!: string;

  @ApiProperty({
    example: true,
    description: 'Whether the provider is enabled',
  })
  enabled!: boolean;
}

/**
 * Response for listing enabled OAuth providers
 */
export class AuthProvidersResponseDto {
  @ApiProperty({
    type: [AuthProviderDto],
    description: 'List of OAuth providers',
  })
  providers!: AuthProviderDto[];
}
