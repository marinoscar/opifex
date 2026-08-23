import { applyDecorators, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExtension,
  ApiForbiddenResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { RolesGuard } from '../guards/roles.guard';
import { PermissionsGuard } from '../guards/permissions.guard';
import { Roles } from './roles.decorator';
import { Permissions } from './permissions.decorator';
import { ErrorDto } from '../../common/dto/error.dto';
import {
  RoleName,
  PermissionName,
} from '../../common/constants/roles.constants';

interface AuthOptions {
  roles?: RoleName[];
  permissions?: PermissionName[];
}

/**
 * Vendor-extension key under which `@Auth()` records what it is about to
 * enforce. Read back by `src/openapi/rbac-docs.ts` and by the document builder.
 */
export const RBAC_EXTENSION_KEY = 'x-rbac';

/** Shape stamped at {@link RBAC_EXTENSION_KEY} on every `@Auth()` operation. */
export interface RbacExtension {
  /** Always true — `@Auth()` always applies `JwtAuthGuard`. */
  authenticated: true;
  /** The guard admits a caller holding ANY of these system roles. */
  roles: string[];
  /** The guard requires ALL of these permissions. */
  permissions: string[];
}

/** Name of the session bearer scheme declared in `src/openapi/document.ts`. */
const SESSION_SCHEME = 'JWT-auth';

/**
 * Combined auth decorator that applies JWT, roles, and permissions guards.
 *
 * It also records the roles and permissions it enforces as an `x-rbac` vendor
 * extension on the operation. The human-readable "**Requires:** …" line is
 * rendered from that extension by a later pass over the finished document
 * (`applyRbacDocs`) rather than being written here.
 *
 * WHY A LATER PASS AND NOT `@ApiOperation({ description })` RIGHT HERE.
 * Decorators evaluate bottom-up and `@nestjs/swagger` merges operation metadata
 * shallowly, so a `description` written by this decorator would race the
 * controller's own `@ApiOperation({ description })` — whichever ran last would
 * silently clobber the other, and which one that is depends on decorator order
 * at each call site. Post-processing appends instead, so hand-written prose and
 * generated requirements always coexist. Recording structured metadata here and
 * rendering it there is what makes that possible.
 *
 * @example
 * // Just authentication
 * @Auth()
 *
 * // With roles (user needs ANY of the roles)
 * @Auth({ roles: [ROLES.ADMIN] })
 *
 * // With permissions (user needs ALL permissions)
 * @Auth({ permissions: [PERMISSIONS.USERS_READ] })
 *
 * // Combined
 * @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.SYSTEM_SETTINGS_WRITE] })
 */
export function Auth(options: AuthOptions = {}) {
  const roles = options.roles ?? [];
  const permissions = options.permissions ?? [];

  const rbac: RbacExtension = {
    authenticated: true,
    roles: [...roles],
    permissions: [...permissions],
  };

  const decorators = [
    UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard),
    ApiBearerAuth(SESSION_SCHEME),
    ApiExtension(RBAC_EXTENSION_KEY, rbac),
    ApiUnauthorizedResponse({
      description: 'Unauthorized - Invalid or missing token',
      type: ErrorDto,
    }),
    ApiForbiddenResponse({
      description: 'Forbidden - Insufficient permissions',
      type: ErrorDto,
    }),
  ];

  if (roles.length > 0) {
    decorators.push(Roles(...roles));
  }

  if (permissions.length > 0) {
    decorators.push(Permissions(...permissions));
  }

  return applyDecorators(...decorators);
}
