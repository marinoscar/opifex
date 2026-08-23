import { ApiProperty } from '@nestjs/swagger';

/**
 * Role information
 */
export class RoleDto {
  @ApiProperty({
    example: 'admin',
    description: 'Role name',
  })
  name!: string;
}

/**
 * Current authenticated user information
 */
export class CurrentUserDto {
  @ApiProperty({
    example: '123e4567-e89b-12d3-a456-426614174000',
    description: 'User ID',
  })
  id!: string;

  @ApiProperty({
    example: 'user@example.com',
    description: 'User email address',
  })
  email!: string;

  // `type` is explicit because `string | null` erases to `Object` in the
  // emitted design-time metadata, so without it the property publishes as an
  // object — a client generator would produce the wrong type for the field.
  @ApiProperty({
    type: String,
    example: 'John Doe',
    description: 'Display name (computed from override or provider)',
    nullable: true,
  })
  displayName!: string | null;

  @ApiProperty({
    type: String,
    example: 'https://example.com/avatar.jpg',
    description: 'Profile image URL (computed from override or provider)',
    nullable: true,
  })
  profileImageUrl!: string | null;

  @ApiProperty({
    example: true,
    description:
      'Whether this deployment lets a user choose their own theme ' +
      '(system_settings.ui.allowUserThemeOverride). Carried here because ' +
      'GET /api/system-settings 403s for exactly the users this constrains.',
  })
  allowUserThemeOverride!: boolean;

  @ApiProperty({
    example: true,
    description: 'Whether the user account is active',
  })
  isActive!: boolean;

  @ApiProperty({
    type: [RoleDto],
    description: 'User roles',
  })
  roles!: RoleDto[];

  @ApiProperty({
    type: [String],
    example: ['system_settings:read', 'users:write'],
    description: 'User permissions (aggregated from roles)',
  })
  permissions!: string[];
}

/**
 * JWT token response
 */
export class TokenResponseDto {
  @ApiProperty({
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
    description: 'JWT access token',
  })
  accessToken!: string;

  @ApiProperty({
    example: 900,
    description: 'Token expiration time in seconds',
  })
  expiresIn!: number;
}
