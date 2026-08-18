import { useCallback, useMemo } from 'react';
import { useAuth } from '../contexts/AuthContext';

export function usePermissions() {
  const { user } = useAuth();

  const permissions = useMemo(() => {
    return new Set(user?.permissions || []);
  }, [user?.permissions]);

  const roles = useMemo(() => {
    return new Set(user?.roles?.map((r) => r.name) || []);
  }, [user?.roles]);

  // These predicates are wrapped in useCallback so their identity is stable
  // across renders: callers key useMemo/useEffect on them (e.g. row action
  // lists, navigation destination filtering), and a fresh identity per render
  // would rebuild that work on every tick. Behaviour is unchanged.
  const hasPermission = useCallback(
    (permission: string): boolean => {
      return permissions.has(permission);
    },
    [permissions],
  );

  const hasAnyPermission = useCallback(
    (...perms: string[]): boolean => {
      return perms.some((p) => permissions.has(p));
    },
    [permissions],
  );

  const hasAllPermissions = useCallback(
    (...perms: string[]): boolean => {
      return perms.every((p) => permissions.has(p));
    },
    [permissions],
  );

  const hasRole = useCallback(
    (role: string): boolean => {
      return roles.has(role);
    },
    [roles],
  );

  const hasAnyRole = useCallback(
    (...roleList: string[]): boolean => {
      return roleList.some((r) => roles.has(r));
    },
    [roles],
  );

  const isAdmin = useMemo(() => {
    return roles.has('admin');
  }, [roles]);

  return {
    permissions,
    roles,
    hasPermission,
    hasAnyPermission,
    hasAllPermissions,
    hasRole,
    hasAnyRole,
    isAdmin,
  };
}
