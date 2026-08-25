import { Controller, Get, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthGuard, PassportModule } from '@nestjs/passport';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { AuthService } from '../../src/auth/auth.service';
import { JwtStrategy } from '../../src/auth/strategies/jwt.strategy';

/**
 * The exploit #278 fixed, pinned as a regression.
 *
 * `jwt.strategy.ts` used to verify every access token against the literal
 * string `'fallback-secret'` whenever `JWT_SECRET` was unset — a value
 * public in this repository. Confirmed by probe before the fix: a token
 * forged with that literal returned 200 from `GET /api/auth/me` with the
 * victim's full roles and permissions.
 *
 * WHY THIS DOES NOT GO THROUGH `AppModule` / `createTestApp`: since #278
 * also added `validateEnv` (config/env.validation.ts), the full app now
 * refuses to boot at all whenever `JWT_SECRET` is unset — so the exact
 * historical condition (app running, secret unset) is no longer reachable
 * through the full module graph, on purpose; that is the OTHER half of
 * #278's fix, covered separately by test/config/boot-refusal.integration.spec.ts.
 * An earlier version of this file built its app through `createTestApp`
 * with `.env.test`'s real secret, but a real configured secret makes the
 * `configService.get('jwt.secret') || 'fallback-secret'` line unreachable
 * regardless of whether the fallback exists — restoring the fallback and
 * rerunning that version still passed. This isolated module — `JwtStrategy`
 * wired to a bare `PassportModule`, with a `ConfigService` double that
 * genuinely returns nothing for `jwt.secret` — is what actually reaches the
 * line #278 deleted, independent of the boot-time gate. This is deliberate:
 * `jwt.strategy.ts`'s doc comment calls `getOrThrow` "a second, independent
 * guard," and this test is what independently exercises it.
 */
@Controller('probe')
class ProbeController {
  @Get('me')
  @UseGuards(AuthGuard('jwt'))
  me(): { ok: true } {
    return { ok: true };
  }
}

const authServiceStub: Pick<AuthService, 'validateJwtPayload'> = {
  validateJwtPayload: async (payload) =>
    ({
      id: payload.sub,
      email: payload.email,
      isActive: true,
      userRoles: [],
    }) as unknown as Awaited<ReturnType<AuthService['validateJwtPayload']>>,
};

/**
 * Builds a minimal app containing only `JwtStrategy` behind the passport
 * `'jwt'` `AuthGuard`, with a `ConfigService` double standing in for the
 * real one. `configuredSecret === undefined` reproduces "JWT_SECRET unset"
 * for `JwtStrategy` specifically, without going through `ConfigModule`.
 */
async function buildIsolatedApp(
  configuredSecret: string | undefined,
): Promise<NestFastifyApplication> {
  const configService = {
    get: (key: string) => (key === 'jwt.secret' ? configuredSecret : undefined),
    getOrThrow: (key: string) => {
      const value = key === 'jwt.secret' ? configuredSecret : undefined;
      if (value === undefined) {
        throw new Error(`${key} is required`);
      }
      return value;
    },
  } as unknown as ConfigService;

  const moduleRef = await Test.createTestingModule({
    imports: [PassportModule.register({ defaultStrategy: 'jwt' })],
    controllers: [ProbeController],
    providers: [
      JwtStrategy,
      { provide: ConfigService, useValue: configService },
      { provide: AuthService, useValue: authServiceStub },
    ],
  }).compile();

  const app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

describe('JWT fallback-secret exploit (#278 regression)', () => {
  it('never accepts a token forged with the literal fallback secret when jwt.secret is unconfigured', async () => {
    let app: NestFastifyApplication | undefined;
    try {
      app = await buildIsolatedApp(undefined);
    } catch {
      // Refusing to even construct is a safe outcome: `getOrThrow` throwing
      // at strategy construction (the current, fixed behaviour) means the
      // literal fallback never gets a chance to become the verification
      // key. Nothing left to assert against — there is no server to
      // request.
      return;
    }

    // Reached only if construction succeeded without a configured secret —
    // i.e. the vulnerable `get() || 'fallback-secret'` line is back. Forge
    // exactly what an attacker who had read jwt.strategy.ts could mint.
    const forgedToken = jwt.sign(
      { sub: 'attacker', email: 'a@a.com' },
      'fallback-secret',
      {
        expiresIn: '15m',
      },
    );

    const response = await request(app.getHttpServer())
      .get('/probe/me')
      .set('Authorization', `Bearer ${forgedToken}`);

    await app.close();

    expect(response.status).not.toBe(200);
  });

  it('control: a token signed with the real configured secret still succeeds', async () => {
    // Without this, the assertion above could pass for an unrelated reason
    // (e.g. the guard rejecting everything) while proving nothing about the
    // exploit specifically.
    const realSecret = 'a-real-secret-at-least-32-characters-long';
    const app = await buildIsolatedApp(realSecret);

    const legitimateToken = jwt.sign(
      { sub: 'real-user', email: 'user@example.com' },
      realSecret,
      { expiresIn: '15m' },
    );

    const response = await request(app.getHttpServer())
      .get('/probe/me')
      .set('Authorization', `Bearer ${legitimateToken}`)
      .expect(200);

    await app.close();

    expect(response.body).toEqual({ ok: true });
  });
});
