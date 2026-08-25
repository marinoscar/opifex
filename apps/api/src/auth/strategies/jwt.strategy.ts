import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AuthService } from '../auth.service';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';

/**
 * JWT payload structure
 */
export interface JwtPayload {
  sub: string; // User ID
  email: string;
  roles: string[];
}

/**
 * JWT authentication strategy
 *
 * Validates JWT tokens and attaches user information to the request.
 * Tokens are extracted from the Authorization header as Bearer tokens.
 *
 * NO FALLBACK SECRET (#278). This line used to read
 * `configService.get('jwt.secret') || 'fallback-secret'`, and with JWT_SECRET
 * unset that string — public in this repository — was the key every access
 * token was verified against. Confirmed behaviourally before the fix: the app
 * booted clean, `@nestjs/jwt` threw `secretOrPrivateKey must have a value` on
 * every real login, and a token minted with the literal `fallback-secret`
 * returned 200 from `GET /auth/me` with full roles and permissions. Exactly
 * inverted: nobody legitimate could get in, anybody who had read this file
 * could.
 *
 * The secret is now guaranteed present by `validateEnv` at boot
 * (config/env.validation.ts), so there is nothing left to fall back to.
 * `getOrThrow` rather than `get` anyway: it is a second, independent guard at
 * strategy construction, so if that boot check is ever loosened this fails
 * the boot instead of silently reintroducing an unverifiable key.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    private readonly configService: ConfigService,
    private readonly authService: AuthService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.getOrThrow<string>('jwt.secret'),
    });
  }

  /**
   * Validates the JWT payload and returns the user object
   * This method is called after the JWT signature is verified
   */
  async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
    const user = await this.authService.validateJwtPayload(payload);

    if (!user) {
      throw new UnauthorizedException('Invalid token');
    }

    return user;
  }
}
