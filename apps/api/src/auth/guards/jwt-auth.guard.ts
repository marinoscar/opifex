import {
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { PatService } from '../../pat/pat.service';
import type { RequestWithCredentialKind } from '../credential-kind';

/**
 * JWT authentication guard
 *
 * Validates JWT tokens on protected routes.
 * Routes marked with @Public() decorator are skipped.
 * Supports Personal Access Tokens (PAT) via "Bearer pat_..." Authorization header.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(
    private reflector: Reflector,
    private patService: PatService,
  ) {
    super();
  }

  /**
   * Determines if the route requires authentication.
   * Skips authentication for routes marked with @Public().
   * Handles PAT tokens (Bearer pat_...) before falling back to JWT validation.
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers?.authorization;

    if (authHeader?.startsWith('Bearer pat_')) {
      const token = authHeader.slice(7); // Remove "Bearer "
      const user = await this.patService.validateToken(token);
      if (!user) {
        throw new UnauthorizedException(
          'Invalid or expired personal access token',
        );
      }
      // Set the full AuthenticatedUser on request.user so RolesGuard/PermissionsGuard
      // can call toRequestUser() on it (same format as JWT strategy validate() returns)
      request.user = user;
      // Recorded here for the same reason `JwtStrategy.validate` records it
      // there: this branch is the only place that knows a PAT was what
      // authenticated the request (#346). A PAT is documented as being for
      // "automated or non-interactive clients", so it is never interactive,
      // with no claim to read and no case where it could be.
      (request as RequestWithCredentialKind).credentialKind =
        'personal-access-token';
      return true;
    }

    return super.canActivate(context) as Promise<boolean>;
  }
}
