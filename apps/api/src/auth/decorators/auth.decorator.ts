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
import { InteractiveSessionGuard } from '../guards/interactive-session.guard';
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
  /**
   * Refuse this route to any credential that does not prove a human was
   * present: no personal access token, no device-flow token (#346).
   *
   * An option on `@Auth()` rather than a decorator of its own, because guard
   * ORDER is the whole correctness argument and only one `UseGuards` call can
   * state it. As a separate decorator the check would land in a second
   * `UseGuards`, and since decorators evaluate bottom-up it would run before
   * `JwtAuthGuard` depending on where a caller wrote it — refusing an
   * anonymous request with 403 "not interactive" instead of 401, and refusing
   * it on the strength of a request property nothing had populated yet.
   */
  interactive?: boolean;
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
  /**
   * The guard additionally refuses non-interactive credentials (#346).
   *
   * Optional so that every `x-rbac` object written before this existed stays
   * valid, and absent rather than `false` on the routes that do not set it —
   * a document full of `interactive: false` would read as a decision taken
   * everywhere, when it is a decision taken in one place.
   */
  interactive?: true;
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
  const interactive = options.interactive === true;

  const rbac: RbacExtension = {
    authenticated: true,
    roles: [...roles],
    permissions: [...permissions],
    ...(interactive ? { interactive: true as const } : {}),
  };

  const decorators = [
    // LAST, deliberately (#346). Authentication first, so an anonymous caller
    // gets 401 rather than a refusal about a credential they never presented;
    // then roles and permissions, so the interactive check only ever fires for
    // a caller who would otherwise have succeeded. That is what makes the
    // audit row it writes worth reading: it records a privileged
    // non-interactive credential reaching a write path, not a stray request.
    UseGuards(
      JwtAuthGuard,
      RolesGuard,
      PermissionsGuard,
      ...(interactive ? [InteractiveSessionGuard] : []),
    ),
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
