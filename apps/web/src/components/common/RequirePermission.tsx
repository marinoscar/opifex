import { ReactNode } from 'react';
import { usePermissions } from '../../hooks/usePermissions';

interface RequirePermissionProps {
  permission?: string;
  permissions?: string[];
  requireAll?: boolean;
  role?: string;
  roles?: string[];
  children: ReactNode;
  fallback?: ReactNode;
}

export function RequirePermission({
  permission,
  permissions,
  requireAll = false,
  role,
  roles,
  children,
  fallback = null,
}: RequirePermissionProps) {
  const {
    hasPermission,
    hasAnyPermission,
    hasAllPermissions,
    hasRole,
    hasAnyRole,
  } = usePermissions();

  // Check single permission
  if (permission && !hasPermission(permission)) {
    return <>{fallback}</>;
  }

  // Check multiple permissions
  if (permissions && permissions.length > 0) {
    const hasPerms = requireAll
      ? hasAllPermissions(...permissions)
      : hasAnyPermission(...permissions);
    if (!hasPerms) {
      return <>{fallback}</>;
    }
  }

  // Check single role
  if (role && !hasRole(role)) {
    return <>{fallback}</>;
  }

  // Check multiple roles
  if (roles && roles.length > 0 && !hasAnyRole(...roles)) {
    return <>{fallback}</>;
  }

  return <>{children}</>;
}
