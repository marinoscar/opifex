import { ExecutionContext, NotImplementedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleOAuthGuard } from './google-oauth.guard';
import { GOOGLE_OAUTH_ENV } from '../google-oauth.config';

function configWith(values: Record<string, string>): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

function contextFor(url: string): ExecutionContext {
  const request = { url, raw: { url } };
  const response = { raw: {} };

  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;
}

const CONFIGURED = {
  'google.clientId': 'client-id.apps.googleusercontent.com',
  'google.clientSecret': 'client-secret',
  'google.callbackUrl': 'http://localhost:3535/api/auth/google/callback',
};

describe('GoogleOAuthGuard', () => {
  describe('when Google login is not configured', () => {
    /**
     * Both routes carry this guard, and both must answer identically — the
     * callback especially, since that is the URL a stale bookmark returns to
     * (#138).
     */
    it.each([
      ['the initiation route', '/api/auth/google'],
      ['the callback route', '/api/auth/google/callback?code=stale'],
    ])('refuses %s with 501', async (_label, url) => {
      const guard = new GoogleOAuthGuard(configWith({}));

      await expect(guard.canActivate(contextFor(url))).rejects.toBeInstanceOf(
        NotImplementedException,
      );
    });

    it('names the variables to set rather than saying only "unavailable"', async () => {
      const guard = new GoogleOAuthGuard(configWith({}));

      await expect(
        guard.canActivate(contextFor('/api/auth/google')),
      ).rejects.toThrow(
        new RegExp(
          `${GOOGLE_OAUTH_ENV.clientId}.*${GOOGLE_OAUTH_ENV.clientSecret}`,
        ),
      );
    });

    it('uses 501 and not 503, so a probe does not read it as an outage', async () => {
      const guard = new GoogleOAuthGuard(configWith({}));

      await expect(
        guard.canActivate(contextFor('/api/auth/google')),
      ).rejects.toMatchObject({ status: 501 });
    });

    it('refuses a half-configured deployment too', async () => {
      const guard = new GoogleOAuthGuard(
        configWith({ 'google.clientId': 'client-id' }),
      );

      await expect(
        guard.canActivate(contextFor('/api/auth/google')),
      ).rejects.toBeInstanceOf(NotImplementedException);
    });
  });

  describe('when Google login is configured', () => {
    it('delegates to the passport guard', async () => {
      const guard = new GoogleOAuthGuard(configWith(CONFIGURED));
      const parent = jest
        .spyOn(
          Object.getPrototypeOf(GoogleOAuthGuard.prototype) as {
            canActivate: (context: ExecutionContext) => Promise<boolean>;
          },
          'canActivate',
        )
        .mockResolvedValue(true);

      await expect(
        guard.canActivate(contextFor('/api/auth/google')),
      ).resolves.toBe(true);
      expect(parent).toHaveBeenCalledTimes(1);

      parent.mockRestore();
    });
  });

  describe('getRequest / getResponse', () => {
    it('unwraps the raw Node objects passport needs', () => {
      const guard = new GoogleOAuthGuard(configWith(CONFIGURED));
      const context = contextFor('/api/auth/google');

      expect(guard.getRequest(context)).toEqual({ url: '/api/auth/google' });
      expect(guard.getResponse(context)).toEqual({});
    });
  });

  describe('handleRequest', () => {
    it('copies the user onto the Fastify request', () => {
      const guard = new GoogleOAuthGuard(configWith(CONFIGURED));
      const context = contextFor('/api/auth/google');
      const user = { id: 'google-1', email: 'user@example.com' };

      expect(guard.handleRequest(null, user, null, context)).toBe(user);
      expect(
        (context.switchToHttp().getRequest() as { user?: unknown }).user,
      ).toBe(user);
    });

    it('rethrows the passport error', () => {
      const guard = new GoogleOAuthGuard(configWith(CONFIGURED));
      const error = new Error('boom');

      expect(() =>
        guard.handleRequest(error, false, null, contextFor('/x')),
      ).toThrow(error);
    });
  });
});
