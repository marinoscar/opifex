import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { RequestUser } from '../interfaces/authenticated-user.interface';

/**
 * Extended Fastify request with user property
 */
interface FastifyRequestWithUser {
  user?: RequestUser;
  requestUser?: RequestUser;
}

/**
 * Decorator to extract the current authenticated user from the request
 *
 * The decorator can extract properties from either `request.requestUser` (simplified user
 * set by guards) or `request.user` (full authenticated user from JWT strategy).
 *
 * @example
 * ```typescript
 * // Get full user object
 * @Get('profile')
 * getProfile(@CurrentUser() user: RequestUser) {
 *   return user;
 * }
 *
 * // Get specific property
 * @Get('email')
 * getEmail(@CurrentUser('email') email: string) {
 *   return { email };
 * }
 * ```
 */
export const CurrentUser = createParamDecorator(
  (data: keyof RequestUser | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<FastifyRequestWithUser>();
    const user = request.requestUser || request.user;

    return data ? user?.[data] : user;
  },
);
