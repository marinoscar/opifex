import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, VerifyCallback, Profile } from 'passport-google-oauth20';

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
 */
@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  constructor(private readonly configService: ConfigService) {
    super({
      clientID: configService.get<string>('google.clientId') || '',
      clientSecret: configService.get<string>('google.clientSecret') || '',
      callbackURL: configService.get<string>('google.callbackUrl') || '',
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
