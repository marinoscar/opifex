import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Response DTO for a newly created PAT (includes the raw token, shown only once)
 */
export class PatCreatedResponseDto {
  @ApiProperty({ description: 'The raw token value - shown only once, store securely' })
  token!: string;

  @ApiProperty({ description: 'Token ID (UUID)' })
  id!: string;

  @ApiProperty({ description: 'Human-readable name for this token' })
  name!: string;

  @ApiProperty({ description: 'Token prefix for identification (e.g. pat_xxxx)' })
  tokenPrefix!: string;

  @ApiProperty({ description: 'ISO 8601 expiry timestamp' })
  expiresAt!: string;

  @ApiProperty({ description: 'ISO 8601 creation timestamp' })
  createdAt!: string;
}

/**
 * Response DTO for a single PAT in a listing (raw token is never returned)
 */
export class PatListItemDto {
  @ApiProperty({ description: 'Token ID (UUID)' })
  id!: string;

  @ApiProperty({ description: 'Human-readable name for this token' })
  name!: string;

  @ApiProperty({ description: 'Token prefix for identification (e.g. pat_xxxx)' })
  tokenPrefix!: string;

  @ApiProperty({ description: 'Duration value used when creating the token' })
  durationValue!: number;

  @ApiProperty({
    description: 'Duration unit used when creating the token',
    enum: ['minutes', 'days', 'months'],
  })
  durationUnit!: string;

  @ApiProperty({ description: 'ISO 8601 expiry timestamp' })
  expiresAt!: string;

  @ApiPropertyOptional({ description: 'ISO 8601 timestamp of last use, null if never used' })
  lastUsedAt!: string | null;

  @ApiProperty({ description: 'ISO 8601 creation timestamp' })
  createdAt!: string;

  @ApiPropertyOptional({ description: 'ISO 8601 revocation timestamp, null if not revoked' })
  revokedAt!: string | null;
}
