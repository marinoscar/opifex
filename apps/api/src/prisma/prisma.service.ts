import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

/**
 * How many times to re-probe the database at boot before giving up, and how
 * long to wait between attempts (~1.75s in total).
 *
 * This is not a retry framework and is deliberately not configurable. It
 * exists for one case: PostgreSQL is not a service in
 * `infra/compose/base.compose.yml` — it is an external container on the shared
 * `devnet` network — so Compose cannot order the API behind it with
 * `depends_on`, and `compose up` routinely races a database that is ready a
 * few hundred milliseconds later. Without these attempts the boot log would
 * print an alarming line on boots that are actually fine, and a warning that
 * cries wolf on healthy boots is #161 with the sign flipped: still a log line
 * that does not correspond to reality.
 *
 * It is short on purpose. The failure path does not abort the boot, so every
 * millisecond spent here is a millisecond that `/api/health/ready` — the thing
 * that reports the failure — is not yet answering.
 */
const CONNECT_RETRY_DELAYS_MS: readonly number[] = [250, 500, 1000];

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Builds a PostgreSQL connection string from individual environment variables,
 * falling back to DATABASE_URL when already provided.
 *
 * Mirrors the logic in src/config/configuration.ts and scripts/prisma-env.js
 * so PrismaService works regardless of NestJS module initialization order.
 */
function buildConnectionString(): string {
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }

  const host = process.env.POSTGRES_HOST ?? 'localhost';
  const port = process.env.POSTGRES_PORT ?? '5432';
  const user = process.env.POSTGRES_USER ?? 'postgres';
  const password = process.env.POSTGRES_PASSWORD ?? 'postgres';
  const dbName = process.env.POSTGRES_DB ?? 'appdb';
  const ssl = process.env.POSTGRES_SSL === 'true';
  const sslParam = ssl ? '?sslmode=require' : '';

  // URL-encode the password to handle special characters
  const encodedPassword = encodeURIComponent(password);

  return `postgresql://${user}:${encodedPassword}@${host}:${port}/${dbName}${sslParam}`;
}

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    const adapter = new PrismaPg(buildConnectionString());
    super({
      adapter,
      log: [
        { emit: 'event', level: 'query' },
        { emit: 'event', level: 'error' },
        { emit: 'event', level: 'warn' },
      ],
    });
  }

  /**
   * @see CONNECT_RETRY_DELAYS_MS. An instance field rather than a direct
   * reference to the constant so unit tests can shorten the schedule without
   * mocking timers; `protected` keeps it out of the service's public surface.
   */
  protected connectRetryDelaysMs: readonly number[] = CONNECT_RETRY_DELAYS_MS;

  /**
   * Verify the database is actually reachable, and report it truthfully.
   *
   * ## The success line has to be earned (#161)
   *
   * `$connect()` is not evidence. With the `PrismaPg` driver adapter the pool
   * is lazy: `$connect()` resolves against a stopped server, an unroutable
   * host and a rejected password alike, and the first real query is what
   * discovers the truth. The previous `await this.$connect();
   * log('Database connected')` therefore asserted a fact nobody had checked,
   * and it was wrong in exactly the case where an operator reads it — the
   * failing boot. The claim is now backed by `verifyConnection()`, a real
   * round trip.
   *
   * ## Why an unreachable database does not stop the boot
   *
   * The tempting answer is to throw: nothing here works without a database, so
   * a process that cannot reach one is useless and should exit and let a
   * supervisor deal with it. That argument is about usefulness, and about
   * usefulness it is right. It is the wrong question.
   *
   * A process that has exited cannot be asked anything. The one that stays up
   * answers `/api/health/ready` with a 503 carrying the driver's actual error
   * string — "Can't reach database server at 127.0.0.1:5432",
   * "Authentication failed against the database server" — which is the
   * difference between knowing the cause in one request and inferring it from
   * a container that is simply gone. Neither process serves traffic; only one
   * of them explains why.
   *
   * This repo's own deployment makes that concrete rather than theoretical:
   *
   * - `base.compose.yml` and `dev.compose.yml` set no `restart:` policy on
   *   `api`. In development — the environment where #161 was observed — a
   *   throw does not buy a self-healing crash-loop. It buys a container that
   *   exits once and stays exited until a human notices.
   * - `prod.compose.yml` does set `restart: unless-stopped`, so there a throw
   *   is a real crash-loop, throughout which nginx has no upstream and every
   *   request — the health probes included — is a bare 502 with no diagnosis
   *   in it.
   * - PostgreSQL is an external container shared with the other apps on the
   *   dev host. Its restarts are not this app's to coordinate, and a blip
   *   caused by someone else's maintenance must not be able to take this API
   *   down permanently.
   *
   * `RunnerRegistrationService` declines to abort the boot on the grounds that
   * the rest of the control plane is what VISION §9 relies on to notice
   * trouble and should not be taken out over the least important of its parts.
   * That reasoning does *not* transfer verbatim: a missing runner degrades one
   * capability, a missing database disables everything, so the database really
   * is different in kind. It lands in the same place for a different reason.
   * What is being defended here is not continued service but continued
   * *reportability* — plus recovery, because the adapter's pool is lazy, so
   * the moment the database comes back the next query simply succeeds, with no
   * restart and no ordering dance.
   *
   * The cost is real and worth naming: the process runs, useless, and every
   * request fails until the database returns. The mitigation is that it fails
   * loudly at `error` level here and unready at `/api/health/ready`, which is
   * the contract #161 asks for — the log must say the database is not
   * reachable, and readiness must report unready until it is.
   *
   * ## Interaction with #162
   *
   * Warning rather than throwing leaves #162 live: `RunnerRegistrationService`
   * registers once at boot and never retries, so a database down through this
   * window leaves the fleet table empty for the life of the process. Throwing
   * would have masked that in production by crash-looping until the database
   * answered. That is not an argument for throwing; it is an argument for
   * fixing #162 where it lives — retrying registration on a tick — rather than
   * buying an accidental workaround with a crash-loop that costs the
   * diagnostic surface described above.
   */
  async onModuleInit() {
    // Registered before the probe, so a database that is slow or absent still
    // gets its eventual queries logged in development.
    if (process.env.NODE_ENV === 'development') {
      // @ts-expect-error - Prisma event typing
      this.$on('query', (e: any) => {
        this.logger.debug(`Query: ${e.query}`);
        this.logger.debug(`Duration: ${e.duration}ms`);
      });
    }

    const failure = await this.probeUntilReachable();

    if (failure !== null) {
      this.logger.error(
        `Database NOT reachable: ${failure}. Starting anyway; ` +
          '/api/health/ready will report unready until the database answers.',
      );
      return;
    }

    this.logger.log('Database connected');
  }

  /**
   * Probe the database, retrying on the bounded schedule above.
   *
   * Returns `null` once it answers, or the last error's message if it never
   * did. A returned string rather than a thrown error because "unreachable" is
   * an expected outcome of this function, not an exception to it — the caller
   * decides what to do about it, and per the comment above what it does is
   * report rather than abort.
   */
  private async probeUntilReachable(): Promise<string | null> {
    for (let attempt = 0; ; attempt++) {
      try {
        // `$connect()` stays because it is the documented lifecycle call and
        // is idempotent and cheap. It simply is not proof of anything, which
        // is why the line below follows it.
        await this.$connect();
        await this.verifyConnection();
        return null;
      } catch (error) {
        if (attempt >= this.connectRetryDelaysMs.length) {
          return asMessage(error);
        }
        await sleep(this.connectRetryDelaysMs[attempt]);
      }
    }
  }

  /**
   * One round trip to the database: resolves if it answered, throws the
   * driver's error if it did not.
   *
   * The single definition of "reachable" in this application, shared by the
   * boot check above and by `DatabaseHealthIndicator`. The two previously each
   * issued their own `SELECT 1`, which was harmless right up until they
   * disagreed — and #161 is precisely a case of the boot log and the readiness
   * probe telling an operator two different things about one database. Sharing
   * the query makes "Database connected" and a readiness `up` mean the same
   * fact by construction.
   *
   * Deliberately carries no retry of its own: readiness must answer now, about
   * now. The bounded retry at boot wraps this call; never the reverse.
   */
  async verifyConnection(): Promise<void> {
    await this.$queryRaw`SELECT 1`;
  }

  async onModuleDestroy() {
    await this.$disconnect();
    this.logger.log('Database disconnected');
  }

  /**
   * Clean database for testing
   */
  async cleanDatabase() {
    if (process.env.NODE_ENV !== 'test') {
      throw new Error('cleanDatabase only allowed in test environment');
    }

    const tablenames = await this.$queryRaw<Array<{ tablename: string }>>`
      SELECT tablename FROM pg_tables WHERE schemaname='public'
    `;

    for (const { tablename } of tablenames) {
      if (tablename !== '_prisma_migrations') {
        await this.$executeRawUnsafe(
          `TRUNCATE TABLE "public"."${tablename}" CASCADE;`,
        );
      }
    }
  }
}
