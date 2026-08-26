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
 *
 * WHY POSTGRES_PASSWORD IS ONLY REQUIRED IN PRODUCTION (#299)
 * ---------------------------------------------------------------------------
 * The second variable this file gates is deliberately gated more weakly than
 * the first, and the asymmetry above is exactly why.
 *
 * `JWT_SECRET`'s fallback was an INBOUND verification key: a repo-public value
 * meant anyone who read the repository could mint a token and be believed,
 * silently, forever. `POSTGRES_PASSWORD`'s fallback is an OUTBOUND credential.
 * A wrong value fails to connect immediately and never grants anyone access to
 * us, so it is already self-announcing — it has the symptom #278's fallback
 * lacked. That makes this hardening, not a vulnerability, and it does not earn
 * the same unconditional startup failure.
 *
 * What it does earn is that a default password must never SHIP. So the rule is
 * conditional on `NODE_ENV === 'production'`: `docker compose up` and a fresh
 * laptop checkout stay frictionless, which is the only place the default ever
 * earned its keep, while a production deployment cannot boot on a credential
 * nobody chose. Requiring it unconditionally would be more consistent with
 * #278 but charges every development path for a risk none of them carry;
 * warning at boot instead is the weakest of the three, and a warning nobody
 * reads is precisely how this survived long enough to be found by a sweep.
 *
 * KNOWN GAP, stated rather than papered over: a deployment that is production
 * in every way that matters but does not set `NODE_ENV=production` — a staging
 * host, a one-off container — is not covered. `NODE_ENV` is the only signal
 * available here, and there is no second one to cross-check it against. The
 * mitigation is that such a host still cannot connect unless its database
 * genuinely accepts the default pair, which is a weakness at the database end
 * that no application-side check can repair.
 */

/**
 * WHY OPIFEX_SETTINGS_ENCRYPTION_KEY IS NOT VALIDATED HERE AT ALL (#337)
 * ---------------------------------------------------------------------------
 * The data key that encrypts operator-supplied credentials at rest is absent
 * from this file on purpose, and a reader who arrives after epic #332 has
 * moved real credentials into the database is expected to think that must be
 * an oversight. It is not.
 *
 * Apply the test this file already uses. Without the key, is the rest of the
 * service still telling the truth? Yes, and demonstrably so: every existing
 * endpoint answers exactly as before, secret READS fall back to the
 * environment variables they already used, and secret WRITES are refused with
 * a 503 that names this variable. Nothing is quietly accepted, nothing is
 * quietly weakened. That is the #138/#161 shape, not the #278 one.
 *
 * The asymmetry argument lands the same way. `JWT_SECRET`'s fallback was
 * silent and inbound; a missing settings key is loud and produces a refusal
 * the operator sees on their first attempt to store a credential. It is
 * self-announcing, so it does not earn a startup failure.
 *
 * An INVALID key — set but not 32 bytes — is treated identically rather than
 * being upgraded to a boot failure, which is the part most likely to be
 * re-litigated. Splitting them would mean a typo'd key kills the process while
 * a missing one does not, so the more careful operator gets the worse outcome.
 * `common/crypto/secret-box.ts` reports both through the same path, naming the
 * decoded length when that is the problem.
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
 * The value `configuration.ts` and `prisma.service.ts` fall back to when
 * `POSTGRES_PASSWORD` is unset, and the value `infra/compose/.env.example`
 * ships. Named here so the production check below can reject it by identity
 * rather than by a copy of the literal drifting out of step with theirs.
 */
export const DEFAULT_POSTGRES_PASSWORD = 'postgres';

/**
 * Applied to `POSTGRES_PASSWORD` only when `NODE_ENV === 'production'`.
 *
 * No length floor, unlike `secret()`: this is not a value we generate, it is
 * one an existing database already has, and a minimum here would reject
 * working deployments to express a preference we cannot act on anyway.
 *
 * The default value is rejected as well as the empty one, and that second
 * check is the one that does the work. Requiring the variable to be *set*
 * would be satisfied by the documented setup step — `cp .env.example .env`
 * ships `POSTGRES_PASSWORD=postgres` — so a check for presence alone would
 * let the exact credential this issue exists to stop through the front door
 * while reporting success.
 */
const productionDatabasePassword = z
  .string({ error: 'POSTGRES_PASSWORD is required when NODE_ENV=production' })
  .min(1, 'POSTGRES_PASSWORD is required when NODE_ENV=production')
  .refine((value) => value !== DEFAULT_POSTGRES_PASSWORD, {
    error:
      `POSTGRES_PASSWORD must not be the default value ` +
      `'${DEFAULT_POSTGRES_PASSWORD}' in production ` +
      `(infra/compose/.env.example ships it, so copying that file is not ` +
      `choosing a password)`,
  });

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
 *
 * The same holds, more strongly, for the OPERATOR-MANAGED settings (#340,
 * epic #332). Those are declared once in
 * `settings/operator-settings/operator-settings.registry.ts`, which carries
 * each one's schema and default, and they resolve through
 * `OperatorSettingsService` rather than through `ConfigService` at all — so
 * validating one here would be validating a variable that this file's own
 * consumers no longer read. The registry validates them at the point of use
 * and falls back to the declared default with a warning, deliberately: a
 * mistyped reconcile interval must not be able to stop the API booting. The
 * header above is the argument for why the three variables this file DOES gate
 * are different: without a signing secret every authorization decision the
 * process makes is void, and a default database password must never ship.
 * None of the three is a managed key, and
 * `test/governing/managed-keys-off-config.spec.ts` fails the build if one ever
 * becomes one without this file being revisited.
 *
 * `POSTGRES_PASSWORD` is deliberately NOT a member of this object even though
 * `validateEnv` checks it: its rule depends on `NODE_ENV`, which is a sibling
 * key rather than something a field validator can see. It is checked
 * separately below and reaches `ValidatedEnv` through this passthrough, the
 * same way `INITIAL_ADMIN_EMAIL` does.
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
 * The `POSTGRES_PASSWORD` rule, which cannot live in `envSchema` because it
 * depends on a sibling key (#299).
 *
 * `NODE_ENV` is read off the object being validated rather than off
 * `process.env`, and that is a correctness point, not a style one:
 * `ConfigModule.forRoot` builds what it hands to `validate` as
 * `{ ...dotEnvFileVars, ...process.env }`, so a `NODE_ENV` supplied by an
 * `.env` file — which `process.env` would not yet show at this instant —
 * is visible here. It also means a caller can exercise the production branch
 * by passing an object, without mutating the process it runs in.
 *
 * Returns the problems rather than throwing so they can be reported alongside
 * the schema's, keeping `validateEnv`'s promise to name everything at once.
 */
function productionOnlyProblems(config: Record<string, unknown>): string[] {
  if (config.NODE_ENV !== 'production') {
    return [];
  }

  const result = productionDatabasePassword.safeParse(config.POSTGRES_PASSWORD);

  return result.success
    ? []
    : result.error.issues.map(
        (issue) => `  - POSTGRES_PASSWORD: ${issue.message}`,
      );
}

/**
 * Throws on an invalid environment, which fails the boot.
 *
 * The message names every problem at once rather than the first: an operator
 * fixing a fresh deployment should not have to restart the container to find
 * out about the second missing variable. That is why the production-only
 * checks are collected into the same list as the schema's rather than run
 * behind an early return — a deployment missing both `JWT_SECRET` and
 * `POSTGRES_PASSWORD` is told about both on the first attempt.
 */
export function validateEnv(config: Record<string, unknown>): ValidatedEnv {
  const result = envSchema.safeParse(config);

  const problems: string[] = [
    ...(result.success
      ? []
      : result.error.issues.map(
          (issue) =>
            `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`,
        )),
    ...productionOnlyProblems(config),
  ];

  // The `!result.success` arm is what narrows `result` for the return below;
  // it is never reachable on its own, since a failed parse always contributes
  // at least one problem.
  if (!result.success || problems.length > 0) {
    throw new Error(
      `Invalid environment configuration:\n${problems.join('\n')}\n\n` +
        `The API refuses to start without these. See infra/compose/.env.example.`,
    );
  }

  return result.data;
}
