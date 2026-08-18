import { SetMetadata } from '@nestjs/common';
import { PermissionName } from '../../common/constants/roles.constants';

export const PERMISSIONS_KEY = 'permissions';

/**
 * Decorator to specify required permissions for an endpoint
 * User must have ALL of the specified permissions
 *
 * @example
 * @Permissions(PERMISSIONS.USERS_READ)
 * @Permissions(PERMISSIONS.USERS_READ, PERMISSIONS.USERS_WRITE)
 */
export const Permissions = (...permissions: PermissionName[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);
