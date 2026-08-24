import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { type DecimalLike, toNumberOrNull } from '../../common/decimal';
import { toTrustGrantView } from '../../trust/trust-grant.service';
import {
  MAX_TRUST_DIGEST_ITEMS,
  type TrustDigestAction,
  type TrustDigestInput,
} from './trust-digest';

/** Fallback window when no earlier brief exists: the brief is daily. */
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Everything `buildTrustDigest` needs, read from the database (#100).
 *
 * ## Why this reads Prisma instead of injecting `TrustGrantService`
 *
 * `TrustGrantService` and `ApprovalGateService` carry `create`, `decide`,
 * `revoke` and `alwaysApproveThisClass`. Injecting either would hand the
 * supervisor the ability to mint a grant and to approve an action — and VISION
 * §8 is explicit about that specific capability:
 *
 * > An agent that can edit the check enforcing its own trailers, or grant
 * > itself trust, has the appearance of guardrails and none of the substance.
 *
 * #90 states the rule the module graph is built on: a capability absent from
 * the graph is structurally unavailable, while one that is merely unused is a
 * convenient afternoon away from being used. So `SupervisorModule`'s import
 * list stays `PrismaModule` + `NotificationsModule`, `supervisor-isolation`'s
 * allowlist stays two entries long, and the digest gets exactly what it needs:
 * reads. `SnapshotService` reaches into runs, work orders and escalations the
 * same way and for the same reason.
 *
 * The one thing borrowed from the trust module is `toTrustGrantView`, a pure
 * row→view function. That is deliberate rather than lazy: `trust-grant.types`
 * warns that "two independently written versions of `remaining / ceiling` is
 * exactly how a renewal banner and a budget bar end up disagreeing on screen",
 * and a digest that computed its own headroom would be the third version.
 *
 * ## Nothing here throws
 *
 * A digest that cannot be read must not take the brief down with it. The
 * ranked half of the brief is about things that need a human NOW; losing it
 * because a trust query failed would trade the urgent half for the
 * retrospective one. `DailyBriefService` treats a null digest as "no digest
 * section", which renders as the pre-#100 line.
 */
@Injectable()
export class TrustDigestSource {
  private readonly logger = new Logger(TrustDigestSource.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Gather. Returns null when the read failed — never throws. */
  async collect(now: Date): Promise<TrustDigestInput | null> {
    try {
      return await this.read(now);
    } catch (error) {
      this.logger.warn(
        `Could not read trust activity for the daily brief: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  private async read(now: Date): Promise<TrustDigestInput> {
    const windowStart = await this.windowStart(now);
    const windowMs = Math.max(1, now.getTime() - windowStart.getTime());
    const previousStart = new Date(windowStart.getTime() - windowMs);

    // What ran without a human. Two conditions, unioned:
    //
    //  - `decidedVia: 'grant'` — a standing grant covered it.
    //  - `decidedVia: 'timeout'` AND `status: 'auto_approved'` — nobody
    //    answered and the recorded policy let it through.
    //
    // The status half of the second is load-bearing. `timeout` also pairs with
    // `auto_denied`, and an auto-denied action DID NOT RUN; listing it under
    // "what happened without you" would report a non-event as an event.
    const ranWithoutAHuman = {
      decidedAt: { gte: windowStart, lte: now },
      OR: [
        { decidedVia: 'grant' as const },
        { decidedVia: 'timeout' as const, status: 'auto_approved' as const },
      ],
    };

    // Count and page separately so `notShown` is EXACT rather than "at least".
    // `take: N` alone can only ever say "there were more"; the completeness
    // guarantee is a number, not an inequality.
    const [totalActions, rows] = await Promise.all([
      this.prisma.approvalRequest.count({ where: ranWithoutAHuman }),
      this.prisma.approvalRequest.findMany({
        where: ranWithoutAHuman,
        orderBy: [{ decidedAt: 'asc' }, { id: 'asc' }],
        take: MAX_TRUST_DIGEST_ITEMS,
        select: {
          id: true,
          actionClass: true,
          repositoryId: true,
          summary: true,
          targetRef: true,
          grantId: true,
          estimatedCostUsd: true,
          decidedAt: true,
          decidedVia: true,
        },
      }),
    ]);

    const actions: TrustDigestAction[] = rows.map((row) => ({
      approvalId: row.id,
      actionClass: row.actionClass,
      repositoryId: row.repositoryId,
      summary: row.summary,
      targetRef: row.targetRef,
      grantId: row.grantId,
      // Unknown stays unknown all the way through (VISION §6). A Decimal that
      // will not convert is treated as unreported rather than as zero, which
      // is the same call `spend-ledger.service.ts` makes.
      estimatedCostUsd: toCost(row.estimatedCostUsd),
      // Non-null by the `decidedAt` filter above; the fallback keeps the type
      // honest without inventing a plausible-looking time.
      at: row.decidedAt ?? now,
      origin: row.decidedVia === 'grant' ? 'grant' : 'timeout',
    }));

    const [activeRows, endedRows, previousGroups] = await Promise.all([
      this.prisma.trustGrant.findMany({
        where: { status: 'active' },
        orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
      }),
      // Grants that stopped authorizing INSIDE the window, whatever ended
      // them. An expiry is as much a state change as a revocation — VISION
      // §8's "silence revokes" only reads as deliberate if the operator is
      // told the silence took effect.
      this.prisma.trustGrant.findMany({
        where: {
          status: { not: 'active' },
          endedAt: { gte: windowStart, lte: now },
        },
        orderBy: [{ endedAt: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.approvalRequest.groupBy({
        by: ['grantId'],
        where: {
          decidedVia: 'grant',
          decidedAt: { gte: previousStart, lt: windowStart },
        },
        _count: { _all: true },
      }),
    ]);

    const previousWindowActionsByGrant: Record<string, number> = {};
    for (const group of previousGroups) {
      if (group.grantId === null) continue;
      previousWindowActionsByGrant[group.grantId] = group._count._all;
    }

    return {
      now,
      windowStart,
      actions,
      totalActions,
      activeGrants: activeRows.map((row) => toTrustGrantView(row, now)),
      endedGrants: endedRows.map((row) => toTrustGrantView(row, now)),
      previousWindowActionsByGrant,
    };
  }

  /**
   * Since the last brief, not "the last 24 hours".
   *
   * If a brief was missed — the container was down, the cron did not fire, the
   * supervisor switch was off — the actions in that gap ran without anybody
   * and were never reported. A fixed 24-hour lookback would drop them
   * permanently, which is a silent hole of exactly the kind the completeness
   * guarantee exists to prevent. So the window starts where the last report
   * ended, however long ago that was, and a long outage produces one long
   * digest rather than a lost one.
   *
   * The fallback is 24 hours, used only when no brief has ever been recorded.
   */
  private async windowStart(now: Date): Promise<Date> {
    const last = await this.prisma.supervisorProposal.findFirst({
      where: { actionClass: 'daily-brief', createdAt: { lt: now } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { createdAt: true },
    });

    if (!last) return new Date(now.getTime() - DEFAULT_WINDOW_MS);
    // Never in the future, even if the clock moved backwards: a negative
    // window would silently report nothing at all.
    return last.createdAt < now
      ? last.createdAt
      : new Date(now.getTime() - DEFAULT_WINDOW_MS);
  }
}

/**
 * `Decimal | null` → `number | null`.
 *
 * A figure that will not convert stays NULL rather than becoming zero. VISION
 * §6: unknown and zero are different, and zero is the flattering one.
 */
function toCost(value: DecimalLike | number | null): number | null {
  const asNumber = toNumberOrNull(value);
  return asNumber !== null && Number.isFinite(asNumber) ? asNumber : null;
}
