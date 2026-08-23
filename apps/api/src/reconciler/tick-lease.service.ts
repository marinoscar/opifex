import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

/**
 * A namespaced 64-bit key for `pg_try_advisory_lock`.
 *
 * Postgres advisory locks share one global keyspace across the database, so an
 * arbitrary constant risks colliding with anything else that ever takes one.
 * The pair form namespaces it: the first half identifies Opifex, the second
 * the specific lock.
 */
const LOCK_NAMESPACE = 0x0f1e; // arbitrary, fixed; identifies Opifex's locks
const RECONCILER_TICK_LOCK = 1; // the tick lock within that namespace

@Injectable()
export class TickLeaseService {
  private readonly logger = new Logger(TickLeaseService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Run `work` holding the reconciler lease, or skip if another tick holds it.
   *
   * ## Why an advisory lock rather than a lease row
   *
   * #45 requires that a crashed tick releases its lease rather than wedging the
   * loop. A lease row has to encode that as an expiry, which means picking a
   * timeout — too short and a slow-but-healthy tick gets its lease stolen mid-
   * flight, too long and a crash wedges the loop for exactly that long. Both
   * are wrong, and the right value depends on how long a tick takes, which
   * varies with how many repositories are watched.
   *
   * A session-scoped advisory lock has no such number. Postgres releases it
   * when the connection ends, so a crashed process, a killed container and an
   * OOM all release it in the time it takes the server to notice the socket
   * closed. There is no expiry to tune because there is no expiry.
   *
   * The cost is that the lock lives in the connection, so this must run the
   * lock, the work and the unlock **on one connection** — hence the
   * interactive transaction below. Prisma's pool would otherwise be free to
   * hand the unlock to a different connection, which silently does nothing
   * and leaks the lock until the process exits.
   *
   * ## Why not `SELECT ... FOR UPDATE` on a row
   *
   * That blocks rather than returning immediately. A blocked tick is worse
   * than a skipped one: ticks queue behind the slow one and then all fire at
   * once, which is precisely the overlapping-tick burst against the GitHub API
   * that #40's rate-limit budget exists to prevent.
   */
  async withLease<T>(work: () => Promise<T>): Promise<LeaseOutcome<T>> {
    // `$transaction` pins one connection for the callback's lifetime, which is
    // what makes lock and unlock refer to the same session.
    return this.prisma.$transaction(
      async (tx) => {
        const [{ locked }] = await tx.$queryRaw<[{ locked: boolean }]>`
          SELECT pg_try_advisory_lock(${LOCK_NAMESPACE}::int, ${RECONCILER_TICK_LOCK}::int) AS locked
        `;

        if (!locked) {
          // Not an error. Overlap is the expected outcome of a tick that ran
          // long, and the scheduler firing again is not a fault to report.
          this.logger.debug(
            'Reconciler tick skipped: another tick holds the lease',
          );
          return { acquired: false as const };
        }

        try {
          return { acquired: true as const, result: await work() };
        } finally {
          // Explicit release rather than relying on transaction end: a
          // session-scoped advisory lock is NOT released by COMMIT, only by
          // the session ending. Without this the connection returns to the
          // pool still holding it, and the next tick skips forever.
          await tx.$queryRaw`
            SELECT pg_advisory_unlock(${LOCK_NAMESPACE}::int, ${RECONCILER_TICK_LOCK}::int)
          `;
        }
      },
      {
        // A tick that runs longer than this is a bug worth surfacing, but the
        // ceiling has to clear a slow sweep of many repositories. Prisma's
        // 5s default would abort almost every real tick.
        timeout: 10 * 60 * 1000,
        maxWait: 5000,
      },
    );
  }
}

export type LeaseOutcome<T> =
  { acquired: false } | { acquired: true; result: T };
