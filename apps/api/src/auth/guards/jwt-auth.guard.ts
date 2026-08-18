import { ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { PatService } from '../../pat/pat.service';

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
        throw new UnauthorizedException('Invalid or expired personal access token');
      }
      // Set the full AuthenticatedUser on request.user so RolesGuard/PermissionsGuard
      // can call toRequestUser() on it (same format as JWT strategy validate() returns)
      request.user = user;
      return true;
    }

    return super.canActivate(context) as Promise<boolean>;
  }
}
