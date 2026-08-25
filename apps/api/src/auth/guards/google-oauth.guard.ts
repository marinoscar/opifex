import {
  ExecutionContext,
  Injectable,
  NotImplementedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthGuard } from '@nestjs/passport';
import {
  googleOAuthUnavailableMessage,
  isGoogleOAuthConfigured,
  readGoogleOAuthStatus,
} from '../google-oauth.config';

/**
 * Google OAuth guard for Fastify
 *
 * Initiates the Google OAuth flow when applied to a route.
 * Used on both the initial OAuth endpoint and the callback endpoint.
 *
 * Note: Passport OAuth strategies expect Express-style request/response objects.
 * This guard overrides getRequest/getResponse to return raw Node.js http objects
 * that Passport can work with. After authentication, it copies the user back
 * to the Fastify request so controllers can access req.user normally.
 *
 * ## When Google login is not configured
 *
 * Since #138 the strategy is only registered with passport when the
 * credentials exist, so on a headless deployment `AuthGuard('google')` would
 * find nothing and passport would raise `Unknown authentication strategy
 * "google"` — a bare `Error`, which the global filter can only render as a
 * 500. A 500 says "this deployment is broken". The deployment is not broken;
 * it simply does not offer this. So the guard answers the question itself,
 * before delegating.
 *
 * **501 Not Implemented**, and deliberately not the alternatives:
 *
 * - Not **404**. The route exists, is in the OpenAPI document, and a 404 is
 *   indistinguishable from a typo in the path. It tells the operator nothing
 *   about the cause, which is the whole complaint in #138 — the failure that
 *   everyone works around in thirty seconds and never diagnoses.
 * - Not **503**. 503 means "unable *right now*", invites a retry, and is what
 *   a monitoring probe reads as an outage. This condition never resolves by
 *   retrying, and paging someone about a deployment that is deliberately
 *   headless and perfectly healthy is the opposite of the point.
 * - **501** says the server does not support the requested functionality
 *   (RFC 9110 §15.6.2). No well-behaved client retries it, no probe reads it
 *   as an outage, and the body names the two variables to set.
 *
 * Both `/auth/google` and `/auth/google/callback` carry this guard, so both
 * answer identically. That matters most for the callback: it is the URL a
 * stale bookmark or a half-finished consent screen returns to, and answering
 * it with a redirect to the frontend carrying `?error=` would be a worse
 * answer than the truth, because the frontend of a deployment with no login
 * has no useful page to show.
 */
@Injectable()
export class GoogleOAuthGuard extends AuthGuard('google') {
  constructor(private readonly configService: ConfigService) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const status = readGoogleOAuthStatus(this.configService);

    if (!isGoogleOAuthConfigured(status)) {
      throw new NotImplementedException(googleOAuthUnavailableMessage(status));
    }

    return (await super.canActivate(context)) as boolean;
  }

  getRequest(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest();
    // Return the raw Node.js IncomingMessage for Passport compatibility
    return request.raw || request;
  }

  getResponse(context: ExecutionContext) {
    const response = context.switchToHttp().getResponse();
    // Return the raw Node.js ServerResponse for Passport compatibility
    return response.raw || response;
  }

  handleRequest<TUser = unknown>(
    err: Error | null,
    user: TUser | false,
    _info: unknown,
    context: ExecutionContext,
  ): TUser {
    if (err || !user) {
      throw err || new Error('Authentication failed');
    }

    // Copy user from raw request to Fastify request so controllers can access it
    const fastifyRequest = context.switchToHttp().getRequest();
    fastifyRequest.user = user;

    return user;
  }
}
