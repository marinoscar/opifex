import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, VerifyCallback, Profile } from 'passport-google-oauth20';
import {
  GoogleOAuthOptions,
  isGoogleOAuthConfigured,
  logGoogleOAuthStatus,
  readGoogleOAuthStatus,
} from '../google-oauth.config';

/**
 * Google OAuth profile information extracted from the provider
 */
export interface GoogleProfile {
  id: string;
  email: string;
  displayName: string;
  picture?: string;
}

/**
 * Google OAuth 2.0 authentication strategy
 *
 * Handles the OAuth flow with Google:
 * 1. Redirects user to Google login
 * 2. Google redirects back to callback URL
 * 3. Strategy validates the authorization code
 * 4. Extracts user profile information
 *
 * ## Why this takes options and not `ConfigService`, and is not `@Injectable()`
 *
 * Constructing this class has a side effect: the `PassportStrategy` mixin
 * calls `passport.use('google', this)`. That is the entire reason the class is
 * instantiated — nothing injects it. It is also why #138 was a boot failure
 * rather than a runtime one: an unconditional class provider means Nest
 * constructs it on every boot, and `passport-oauth2` throws
 * `OAuth2Strategy requires a clientID option` for a falsy `clientID`. The old
 * `configService.get('google.clientId') || ''` read as a default and was a
 * guaranteed crash, because `''` is exactly as falsy as `undefined`.
 *
 * Removing the `|| ''` alone would only move the throw. So the class no longer
 * takes a `ConfigService` it could find nothing in: it takes options that have
 * already been proved present, and it is not `@Injectable()`, so it cannot be
 * registered as a plain class provider again. `createGoogleStrategy` below is
 * the only way to build one, and it declines to when the credentials are
 * absent.
 */
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  constructor(options: GoogleOAuthOptions) {
    super({
      clientID: options.clientID,
      clientSecret: options.clientSecret,
      callbackURL: options.callbackURL,
      scope: ['email', 'profile'],
    });
  }

  /**
   * Validates the Google OAuth response and extracts user profile
   *
   * @param accessToken - OAuth access token (not used in our implementation)
   * @param refreshToken - OAuth refresh token (not used in our implementation)
   * @param profile - User profile from Google
   * @param done - Passport callback
   */
  async validate(
    accessToken: string,
    refreshToken: string,
    profile: Profile,
    done: VerifyCallback,
  ): Promise<void> {
    const { id, emails, displayName, photos } = profile;

    // Extract email from profile
    const email = emails?.[0]?.value;
    if (!email) {
      return done(new Error('No email found in Google profile'), false);
    }

    // Build standardized profile object
    const googleProfile: GoogleProfile = {
      id,
      email,
      displayName,
      picture: photos?.[0]?.value,
    };

    done(null, googleProfile);
  }
}

/**
 * The strategy, or nothing (#138).
 *
 * A factory rather than a class provider because the binding is CONDITIONAL,
 * the shape ADR-0015 / #230 used for `SUPERVISOR_MODEL`. It differs from that
 * case in what the returned value is for: `SUPERVISOR_MODEL` is injected, with
 * an `@Optional()` injection point handling the `undefined`. Nothing injects
 * `GoogleStrategy` at all — its value is the `passport.use('google', …)`
 * registration performed in its constructor. So `undefined` here is never
 * dereferenced; it means the registration did not happen, and
 * `AuthGuard('google')` therefore has no strategy to find. `GoogleOAuthGuard`
 * makes that state a truthful 501 instead of the error passport would raise.
 *
 * The decision is made here, at instantiation, rather than by building the
 * providers array conditionally in `@Module({})`: the decorator is evaluated
 * while `app.module.ts` is being imported, which is before
 * `ConfigModule.forRoot()` has loaded a `.env` file. A `process.env` read up
 * there would be right in a container and wrong on a developer's machine.
 */
export function createGoogleStrategy(
  configService: ConfigService,
): GoogleStrategy | undefined {
  const status = readGoogleOAuthStatus(configService);
  logGoogleOAuthStatus(status, new Logger('GoogleOAuth'));

  if (!isGoogleOAuthConfigured(status)) {
    return undefined;
  }

  return new GoogleStrategy(status.options);
}
