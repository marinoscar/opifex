import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { TestAuthController } from './test-auth.controller';
import { TestAuthService } from './test-auth.service';

@Module({
  imports: [
    // JWT configuration (reuse from AuthModule)
    //
    // The fourth consumer of `jwt.secret`, and the one easiest to miss when
    // sweeping for them (#278). It signs tokens that `JwtStrategy` verifies,
    // so it has to read the secret exactly the way AuthModule does — a
    // divergence here would show up as non-production test logins failing for
    // no visible reason.
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('jwt.secret'),
        signOptions: {
          expiresIn: `${config.get<number>('jwt.accessTtlMinutes', 15)}m`,
        },
      }),
    }),
    ConfigModule,
    PrismaModule,
  ],
  controllers: [TestAuthController],
  providers: [TestAuthService],
  exports: [TestAuthService],
})
export class TestAuthModule {}
