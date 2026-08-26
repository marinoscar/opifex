import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AuthService } from '../auth.service';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';
import {
  CREDENTIAL_KIND_CLAIM,
  credentialKindFromClaim,
  type CredentialKind,
  type RequestWithCredentialKind,
} from '../credential-kind';

/**
 * JWT payload structure
 */
export interface JwtPayload {
  sub: string; // User ID
  email: string;
  roles: string[];
  /**
   * How the human authenticated (#346): `'interactive'` for a browser login,
   * `'device-code'` for a token minted by the RFC 8628 device flow.
   *
   * Optional because a token minted before #346 deployed does not carry it,
   * and because `JwtPayload` is also the shape a verifier reads. An absent or
   * unrecognised value resolves to `'unknown'`, which
   * `InteractiveSessionGuard` refuses — see `credential-kind.ts` for why the
   * default has to fall that way.
   */
  [CREDENTIAL_KIND_CLAIM]?: CredentialKind;
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
      // #346 needs the credential kind on the REQUEST, not on the user: the
      // user is the same person whether they are at a keyboard or their
      // automation is running, and folding the two together would put a
      // property that is true of one request onto an object that outlives it.
      // `passReqToCallback` is passport's own way to reach the request from
      // `validate`, and costs no injection here.
      passReqToCallback: true,
    });
  }

  /**
   * Validates the JWT payload and returns the user object
   * This method is called after the JWT signature is verified
   *
   * Also records HOW this request authenticated on the request itself (#346).
   * Recorded here rather than in `JwtAuthGuard` because this is the only place
   * the verified payload exists — reading the claim anywhere downstream would
   * mean decoding the token a second time, and a second decode is a second
   * chance to forget to verify it.
   */
  async validate(
    req: RequestWithCredentialKind,
    payload: JwtPayload,
  ): Promise<AuthenticatedUser> {
    const user = await this.authService.validateJwtPayload(payload);

    if (!user) {
      throw new UnauthorizedException('Invalid token');
    }

    req.credentialKind = credentialKindFromClaim(
      payload[CREDENTIAL_KIND_CLAIM],
    );

    return user;
  }
}
