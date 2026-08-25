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
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('jwt.secret'),
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
