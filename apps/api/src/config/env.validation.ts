import { z } from 'zod';

/**
 * Boot-time validation of the environment (#278).
 *
 * Wired into `ConfigModule.forRoot({ validate })` in `app.module.ts`. Nest's
 * other hook, `validationSchema`, expects a Joi-shaped object with a
 * `.validate()` method; this repository validates with zod everywhere else
 * (see any `dto/*.dto.ts`), so `validate` is the hook that fits the stack and
 * no new dependency is needed.
 *
 * WHY THIS ONE REFUSES TO BOOT, WHEN #138 AND #161 DELIBERATELY DID NOT
 * ---------------------------------------------------------------------------
 * This repository has twice decided that a missing dependency should leave the
 * process up and reporting rather than dead:
 *
 *   #138  No Google credentials -> boot anyway, and let `GET /auth/providers`
 *         and a 501 from `GET /auth/google` say so. A missing login provider
 *         removes one capability; everything else the API does still works,
 *         and a process that is up is a process that can explain itself.
 *   #161  No database -> boot anyway, and let `/health/ready` report it. A
 *         dead process cannot tell anyone why it is dead.
 *
 * The precedent does NOT extend to the signing secret, and the next reader is
 * expected to assume it does, which is why this comment exists.
 *
 * The difference is not importance, it is what the failure does to the
 * remaining service. Without Google, the API still answers correctly. Without
 * a database, the API still answers correctly about being unable to serve.
 * Without `JWT_SECRET`, every authorization decision the process makes is
 * void: there is nothing left that is safe to serve, and staying up means
 * serving it to whoever asks. Degrading is only a virtue when the part still
 * running is still telling the truth.
 *
 * It also fails in the direction that is not self-correcting. A boot failure
 * is fixed within a minute of the first deploy because nothing works. A
 * verification key that quietly accepts the wrong tokens has no symptom at
 * all: `/health/ready` says `ok`, the dashboards are green, and the only way
 * to discover it is for someone to try it. That asymmetry is the whole reason
 * to spend a startup failure here.
 */

/**
 * Documented in CLAUDE.md, `infra/compose/.env.example` and
 * docs/SECURITY-ARCHITECTURE.md since long before it was enforced anywhere.
 * `openssl rand -base64 32` produces 44 characters, so the documented way of
 * generating one has always cleared this.
 */
export const SECRET_MIN_LENGTH = 32;

const secret = (name: string) =>
  z
    .string({ error: `${name} is required` })
    .min(
      SECRET_MIN_LENGTH,
      `${name} must be at least ${SECRET_MIN_LENGTH} characters ` +
        `(generate one with: openssl rand -base64 32)`,
    );

/**
 * `.loose()` is load-bearing, not tidiness: whatever this function returns
 * REPLACES the environment `ConfigService` was built from (see
 * `ConfigModule.forRoot`, which calls `assignVariablesToProcess` on the
 * result). A strict object would silently drop every variable not named here
 * — including `INITIAL_ADMIN_EMAIL` and `NODE_ENV`, which
 * `AdminBootstrapService` reads straight off `ConfigService` — and the first
 * admin would stop being bootstrapped with no error anywhere.
 *
 * So: validate a little, pass through everything. Variables consumed via
 * `configuration.ts` are not repeated here; that file already documents each
 * one's default, and duplicating them would create two places to disagree.
 */
export const envSchema = z
  .object({
    /**
     * The verification key for every access token. Required, no default, and
     * no fallback anywhere in the codebase — see `jwt.strategy.ts`, which used
     * to supply one.
     */
    JWT_SECRET: secret('JWT_SECRET'),

    /**
     * Optional: `main.ts` signs cookies with `COOKIE_SECRET || JWT_SECRET`.
     * That `||` is a choice between two operator-supplied secrets rather than
     * a hardcoded fallback, so it stays — but when a deployment does set its
     * own, it has to clear the same floor, otherwise "set a separate cookie
     * secret" would be a way to end up with a weaker one than not setting it.
     */
    COOKIE_SECRET: secret('COOKIE_SECRET').optional(),
  })
  .loose();

export type ValidatedEnv = z.infer<typeof envSchema>;

/**
 * Throws on the first invalid environment, which fails the boot.
 *
 * The message names every problem at once rather than the first: an operator
 * fixing a fresh deployment should not have to restart the container to find
 * out about the second missing variable.
 */
export function validateEnv(config: Record<string, unknown>): ValidatedEnv {
  const result = envSchema.safeParse(config);

  if (!result.success) {
    const problems = result.error.issues
      .map(
        (issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`,
      )
      .join('\n');

    throw new Error(
      `Invalid environment configuration:\n${problems}\n\n` +
        `The API refuses to start without these. See infra/compose/.env.example.`,
    );
  }

  return result.data;
}
