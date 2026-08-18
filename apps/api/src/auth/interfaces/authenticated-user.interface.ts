import { User, Role, Permission } from '@prisma/client';

/**
 * User object attached to request after JWT validation
 */
export interface AuthenticatedUser extends User {
  userRoles: Array<{
    role: Role & {
      rolePermissions: Array<{
        permission: Permission;
      }>;
    };
  }>;
}

/**
 * Simplified user info for request context
 */
export interface RequestUser {
  id: string;
  email: string;
  roles: string[];
  permissions: string[];
  isActive: boolean;
}

/**
 * Extract RequestUser from AuthenticatedUser
 */
export function toRequestUser(user: AuthenticatedUser): RequestUser {
  const roles = user.userRoles.map((ur) => ur.role.name);
  const permissions = [
    ...new Set(
      user.userRoles.flatMap((ur) =>
        ur.role.rolePermissions.map((rp) => rp.permission.name),
      ),
    ),
  ];

  return {
    id: user.id,
    email: user.email,
    roles,
    permissions,
    isActive: user.isActive,
  };
}
