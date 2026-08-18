import { SetMetadata } from '@nestjs/common';
import { RoleName } from '../../common/constants/roles.constants';

export const ROLES_KEY = 'roles';

/**
 * Decorator to specify required roles for an endpoint
 * User must have AT LEAST ONE of the specified roles
 *
 * @example
 * @Roles(ROLES.ADMIN)
 * @Roles(ROLES.ADMIN, ROLES.CONTRIBUTOR)
 */
export const Roles = (...roles: RoleName[]) => SetMetadata(ROLES_KEY, roles);
