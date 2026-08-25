import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { JwtModule } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { CommonModule } from '../common/common.module';
import { AllowlistModule } from '../allowlist/allowlist.module';
import { PatModule } from '../pat/pat.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import {
  GoogleStrategy,
  createGoogleStrategy,
} from './strategies/google.strategy';
import { JwtStrategy } from './strategies/jwt.strategy';
import { TokenCleanupTask } from './tasks/token-cleanup.task';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [
    SettingsModule,
    // Passport configuration
    PassportModule.register({ defaultStrategy: 'jwt' }),

    // JWT configuration
    //
    // `getOrThrow`, not `get` (#278). `get<string>` types the result as
    // `string` while it can be `undefined`, which is how the signing and
    // verifying halves of this system came to disagree about the secret at
    // all: this side quietly produced `undefined` and threw
    // `secretOrPrivateKey must have a value` on every login, while
    // `jwt.strategy.ts` fell back to a literal and kept verifying. Both sides
    // now read the value the same way, and the boot check in
    // config/env.validation.ts means neither should ever reach it unset.
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('jwt.secret'),
        signOptions: {
          expiresIn: `${config.get<number>('jwt.accessTtlMinutes', 15)}m`,
        },
      }),
    }),

    // Common module for AdminBootstrapService
    CommonModule,

    // Allowlist module for email allowlist checks
    AllowlistModule,

    // PAT module for Personal Access Token validation in JwtAuthGuard
    PatModule,
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    JwtStrategy,
    TokenCleanupTask,
    {
      // Google login, or nothing (#138).
      //
      // A factory rather than a class provider because the binding is
      // conditional: `createGoogleStrategy` returns a strategy when
      // GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are both set, and
      // `undefined` when they are not. As a class provider this line was a
      // guaranteed boot failure for any deployment without Google credentials
      // -- `passport-oauth2` rejects the empty-string `clientID` the strategy
      // used to fall back to -- which made `GET /auth/providers`, an endpoint
      // written specifically to report that Google is unconfigured,
      // unreachable in exactly the case it was written for.
      //
      // Nothing injects this token. The provider exists for the side effect of
      // its construction: the `PassportStrategy` mixin registers the instance
      // with passport under the name 'google'. `undefined` therefore means no
      // registration, which `GoogleOAuthGuard` reports as a 501 rather than
      // letting passport raise 'Unknown authentication strategy'.
      provide: GoogleStrategy,
      inject: [ConfigService],
      useFactory: createGoogleStrategy,
    },
  ],
  exports: [AuthService, JwtModule],
})
export class AuthModule {}
