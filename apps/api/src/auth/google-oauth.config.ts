import type { LoggerService } from '@nestjs/common';

/**
 * Whether this deployment offers Google login, decided in one place (#138).
 *
 * Three things need this answer and used to each guess at it separately:
 * the provider that constructs `GoogleStrategy`, the guard on the two
 * `/auth/google*` routes, and `AuthService.getEnabledProviders()`. When they
 * disagreed the result was #138 — `getEnabledProviders()` was written for the
 * unconfigured case (`if (googleClientId && googleClientSecret)`) while the
 * module made that case impossible to reach, because the strategy was an
 * unconditional provider and `passport-oauth2` rejects an empty `clientID` at
 * construction. The API could not boot far enough to serve the endpoint that
 * would have told an operator Google was not configured.
 *
 * So the rule lives here as a pure function over the configuration, with no
 * Nest container and no `passport` import, and everything that needs to know
 * asks it.
 */

/** The environment variables that turn Google login on. Named, so that a log line or an error can tell an operator exactly what to set. */
export const GOOGLE_OAUTH_ENV = {
  clientId: 'GOOGLE_CLIENT_ID',
  clientSecret: 'GOOGLE_CLIENT_SECRET',
  callbackUrl: 'GOOGLE_CALLBACK_URL',
} as const;

/** Exactly the options `passport-google-oauth20` is constructed with. */
export interface GoogleOAuthOptions {
  readonly clientID: string;
  readonly clientSecret: string;
  /**
   * Optional on purpose. `passport-oauth2` omits `redirect_uri` when this is
   * absent and Google then falls back to the redirect URI registered on the
   * OAuth client, which is a working (if less explicit) configuration. It is
   * `undefined` rather than `''` because an empty string would be sent as an
   * empty `redirect_uri` and rejected by Google — the same class of mistake
   * as the `|| ''` this file exists to remove.
   */
  readonly callbackURL?: string;
}

/**
 * What the configuration says, as three distinguishable answers rather than a
 * boolean.
 *
 * `partial` is the case worth separating: an operator who set one of the two
 * variables believes they configured Google login and did not. That deserves a
 * warning. A deployment that set none of them is deliberately headless and
 * deserves a single informational line, not a scolding on every boot.
 */
export type GoogleOAuthStatus =
  | {
      readonly kind: 'configured';
      readonly options: GoogleOAuthOptions;
      /** Set when the optional callback URL is absent; the strategy is still built. */
      readonly missing: readonly string[];
    }
  | { readonly kind: 'partial'; readonly missing: readonly string[] }
  | { readonly kind: 'absent' };

/**
 * The subset of `ConfigService` this needs.
 *
 * Narrow, so the rule can be unit-tested against a plain object and so nothing
 * here can reach for `set()` or the rest of the config surface.
 */
export interface GoogleOAuthConfigReader {
  get<T = string>(propertyPath: string): T | undefined;
}

/** Whitespace is not configuration. A variable set to `""` or `"  "` counts as unset. */
function present(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Reads the Google OAuth configuration and says which of the three states it
 * is in. Never throws, never returns half-built options.
 */
export function readGoogleOAuthStatus(
  config: GoogleOAuthConfigReader,
): GoogleOAuthStatus {
  const clientId = config.get<string>('google.clientId');
  const clientSecret = config.get<string>('google.clientSecret');
  const callbackUrl = config.get<string>('google.callbackUrl');

  const missing: string[] = [];
  if (!present(clientId)) missing.push(GOOGLE_OAUTH_ENV.clientId);
  if (!present(clientSecret)) missing.push(GOOGLE_OAUTH_ENV.clientSecret);
  if (!present(callbackUrl)) missing.push(GOOGLE_OAUTH_ENV.callbackUrl);

  // The credential pair is the gate, and it is deliberately the same pair
  // `AuthService.getEnabledProviders()` checks. If these two ever diverge,
  // `/auth/providers` starts lying again.
  if (present(clientId) && present(clientSecret)) {
    return {
      kind: 'configured',
      options: {
        clientID: clientId,
        clientSecret,
        callbackURL: present(callbackUrl) ? callbackUrl : undefined,
      },
      missing,
    };
  }

  // Nothing at all was set: an intentional headless deployment.
  if (missing.length === Object.keys(GOOGLE_OAUTH_ENV).length) {
    return { kind: 'absent' };
  }

  return { kind: 'partial', missing };
}

/** True when Google login can actually be served. */
export function isGoogleOAuthConfigured(
  status: GoogleOAuthStatus,
): status is Extract<GoogleOAuthStatus, { kind: 'configured' }> {
  return status.kind === 'configured';
}

/**
 * The message returned to a caller who asks for Google login on a deployment
 * that does not offer it.
 *
 * It names the variables. They are variable *names*, not values, and the
 * alternative — a generic "not available" — sends the operator who is
 * smoke-testing a fresh deployment hunting through the code for the cause,
 * which is the half-hour #138 describes as never getting filed.
 */
export function googleOAuthUnavailableMessage(
  status: GoogleOAuthStatus,
): string {
  const missing =
    status.kind === 'absent'
      ? [GOOGLE_OAUTH_ENV.clientId, GOOGLE_OAUTH_ENV.clientSecret]
      : status.missing.filter((name) => name !== GOOGLE_OAUTH_ENV.callbackUrl);

  return (
    'Google login is not configured on this deployment. ' +
    `Set ${missing.join(' and ')} and restart the API. ` +
    'GET /api/auth/providers lists the providers this deployment does support.'
  );
}

/**
 * Says at boot what an operator would otherwise discover at first login.
 *
 * `hard-spend-ceiling.ts` sets the standard this follows: "a safety limit
 * nobody can see the state of is one an operator will assume is working."
 * Auth is not a safety limit, but the same asymmetry applies — believing you
 * configured OAuth and not having done so is discovered at the worst possible
 * moment otherwise.
 *
 * Level is chosen per state, not uniformly:
 *
 * - `partial` -> `warn`. Half a credential pair is always a mistake.
 * - `configured` but no callback URL -> `warn`. It will work against Google's
 *   registered redirect URI or fail confusingly; either way it was not meant.
 * - `absent` -> `log`. #138 is explicit that running the control plane
 *   headless is a supported way to run it, and a deployment that chose it
 *   should not be nagged on every boot. One line, so the state is still
 *   visible, at a level that is not an alarm.
 */
export function logGoogleOAuthStatus(
  status: GoogleOAuthStatus,
  logger: LoggerService,
): void {
  if (status.kind === 'partial') {
    logger.warn(
      `Google login is NOT enabled: ${status.missing.join(', ')} ` +
        'not set, but other GOOGLE_* variables are. This looks like an ' +
        'incomplete configuration rather than a deliberate one. ' +
        'Browser login is disabled.',
    );
    return;
  }

  if (status.kind === 'absent') {
    logger.log(
      `Google login is not configured (${GOOGLE_OAUTH_ENV.clientId}, ` +
        `${GOOGLE_OAUTH_ENV.clientSecret}); the OAuth routes will answer 501 ` +
        'and /api/auth/providers will report no providers. Everything that ' +
        'does not depend on interactive login is unaffected.',
    );
    return;
  }

  if (status.missing.length > 0) {
    logger.warn(
      `Google login is enabled but ${GOOGLE_OAUTH_ENV.callbackUrl} is not ` +
        "set; the OAuth client's registered redirect URI will be used.",
    );
  }

  logger.log('Google login is enabled');
}
