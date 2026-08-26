import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';

import { EscalationsService } from '../escalations/escalations.service';
import { PrismaService } from '../prisma/prisma.service';
import { OperatorSettingsService } from '../settings/operator-settings/operator-settings.service';
import { buildPayload } from './notification-payload';
import {
  FallbackWebhookTransport,
  WEBHOOK_TARGET,
} from './fallback-webhook.transport';
import { PushSubscriptionsService } from './push-subscriptions.service';
import { WebPushTransport } from './web-push.transport';

/**
 * How many times one escalation is sent before it is given up on.
 *
 * #136: a `failed` escalation used to be retried never, so a push service
 * that returned a 500 for thirty seconds lost the escalation permanently —
 * the exact failure #58 exists to eliminate, arrived at by a different route.
 *
 * The reconciler tick IS the backoff: at the default one-minute interval this
 * is roughly five minutes of trying, which is the right order of magnitude
 * for a notification whose whole value is its latency. A dedicated backoff
 * column would buy precision this does not need.
 *
 * After the cap the row stays `failed`, and that is the honest end state:
 * nobody was told, `GET /escalations/latency` counts it under
 * `awaitingNotification`, and the cockpit shows it.
 */
export const MAX_DELIVERY_ATTEMPTS = 5;

export interface DispatchResult {
  /** Escalations handed to a transport this pass. */
  dispatched: number;
  /** Escalations no transport would accept. */
  failed: number;
  /** Dispatched escalations whose receipt window expired with no receipt. */
  timedOut: number;
  /** Escalations re-routed to the fallback path after Web Push failed. */
  rerouted: number;
  /** Previously-failed escalations tried again this pass. */
  retried: number;
  /** Escalations that hit the attempt cap and will not be tried again. */
  abandoned: number;
}

/**
 * Turns raised escalations into notifications, and tracks whether they landed.
 *
 * ## Three statuses, because two would hide the interesting one
 *
 * - `dispatched` — a push service accepted custody. Not the same as told.
 * - `delivered` — the device posted a receipt back. Someone's phone rang.
 * - `failed` — no transport would take it, or the receipt never came.
 *
 * #58 is blunt about why the middle one cannot be collapsed into the last:
 * *"An escalation that silently failed to send is indistinguishable from no
 * escalation — it reintroduces exactly the failure this project exists to
 * eliminate, while appearing on a dashboard as handled."* Web Push gives no
 * delivery guarantee at all, so treating a 201 as "told" would put a green
 * tick next to a phone that never rang.
 */
@Injectable()
export class EscalationDispatcher {
  private readonly logger = new Logger(EscalationDispatcher.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly escalations: EscalationsService,
    private readonly subscriptions: PushSubscriptionsService,
    private readonly push: WebPushTransport,
    private readonly fallback: FallbackWebhookTransport,
    // `appUrl` is deliberately NOT a managed key — epic #332 leaves ports and
    // URLs in `.env` — so this service reads from both paths, each for what it
    // owns.
    private readonly config: ConfigService,
    private readonly settings: OperatorSettingsService,
  ) {}

  /**
   * One pass: send what is raised, then fail what was never receipted.
   *
   * Order matters. Sweeping timeouts FIRST would give every escalation
   * dispatched in this same pass a zero-length receipt window on the next
   * one; sweeping after means a dispatch always gets its full window.
   */
  async dispatchPending(now: Date = new Date()): Promise<DispatchResult> {
    const result: DispatchResult = {
      dispatched: 0,
      failed: 0,
      timedOut: 0,
      rerouted: 0,
      retried: 0,
      abandoned: 0,
    };

    for (const escalation of await this.loadPending()) {
      // A retry, not a first attempt. Counted separately so a transport that
      // is limping along is visible as such rather than looking healthy
      // because the escalations eventually went out.
      if (escalation.deliveryAttempts > 0) result.retried += 1;

      const outcome = await this.deliver(escalation, now);
      result.dispatched += outcome.dispatched;
      result.failed += outcome.failed;
      result.rerouted += outcome.rerouted;
      result.abandoned += outcome.abandoned;
    }

    result.timedOut = await this.sweepOverdue(now);

    return result;
  }

  /**
   * Confirm a device actually showed a notification.
   *
   * Authenticated by the receipt token alone, which is why it is 32 random
   * bytes and single-use. A service worker has no session; the alternative
   * would be storing a bearer token somewhere a service worker can read it,
   * which is a strictly worse credential than an unguessable id that grants
   * exactly one thing: marking one escalation delivered.
   */
  async recordReceipt(receiptId: string, at: Date = new Date()) {
    const escalation = await this.prisma.escalation.findFirst({
      where: { receiptId },
      select: { id: true, deliveredAt: true },
    });

    if (!escalation) {
      // Deliberately the same 404 a wrong token gets. A receipt endpoint that
      // distinguished "expired" from "never existed" would be an oracle for
      // guessing tokens.
      throw new NotFoundException('Unknown receipt');
    }

    // Already receipted: two devices showing the same notification is normal,
    // and the FIRST one is when the operator was informed. Re-recording would
    // move success metric 1 later for no reason (#59).
    if (escalation.deliveredAt) {
      return { escalationId: escalation.id, recorded: false };
    }

    await this.escalations.markDelivered(escalation.id, this.push.name, {
      receiptId,
      deliveredAt: at,
    });

    this.logger.log(
      `Escalation ${escalation.id} confirmed delivered by a device`,
    );
    return { escalationId: escalation.id, recorded: true };
  }

  /**
   * Everything still owed to a human.
   *
   * `failed` is included, bounded by the attempt cap — #136. An escalation
   * that failed once is not finished with; it is one the operator has still
   * not been told about, and the transport that refused it a minute ago may
   * well take it now.
   *
   * `dispatched` is deliberately NOT here: a transport already has custody,
   * and sending it again would put two notifications on the phone for one
   * stall. `sweepOverdue` is what deals with a dispatch that never arrived.
   */
  private async loadPending() {
    return this.prisma.escalation.findMany({
      where: {
        status: { in: ['raised', 'failed'] },
        deliveryAttempts: { lt: MAX_DELIVERY_ATTEMPTS },
      },
      // Oldest first: the one that has been waiting longest is the one whose
      // detection latency is worst, and #59 measures to notification.
      orderBy: { raisedAt: 'asc' },
      // Bounded so one pass cannot monopolise the tick. Anything left is
      // picked up next pass, a minute later — and if this bound is ever
      // reached, something upstream is raising far more than it should.
      take: 25,
      select: {
        id: true,
        kind: true,
        summary: true,
        detail: true,
        raisedAt: true,
        progressStoppedAt: true,
        deliveryAttempts: true,
        run: {
          select: {
            workOrder: {
              select: {
                identity: true,
                issueNumber: true,
                repository: { select: { owner: true, name: true } },
              },
            },
          },
        },
      },
    });
  }

  /**
   * Send one escalation to every registered device, then to the fallback if
   * none of them took it.
   */
  private async deliver(
    escalation: Awaited<
      ReturnType<EscalationDispatcher['loadPending']>
    >[number],
    now: Date,
  ): Promise<{
    dispatched: number;
    failed: number;
    rerouted: number;
    abandoned: number;
  }> {
    const receiptId = randomBytes(32).toString('hex');
    const appUrl = this.config.get<string>('appUrl') ?? '';
    const payload = buildPayload(escalation, receiptId, appUrl);

    const targets = await this.subscriptions.targets();
    const outcomes = await Promise.all(
      targets.map((target) => this.push.send(target, payload)),
    );

    for (const outcome of outcomes) {
      await (outcome.accepted
        ? this.subscriptions.recordSuccess(outcome.targetId)
        : this.subscriptions.recordFailure(outcome.targetId, outcome.gone));
    }

    if (outcomes.some((outcome) => outcome.accepted)) {
      await this.prisma.escalation.update({
        where: { id: escalation.id },
        data: {
          status: 'dispatched',
          transport: this.push.name,
          receiptId,
          dispatchedAt: now,
          deliveryAttempts: { increment: 1 },
        },
      });
      return { dispatched: 1, failed: 0, rerouted: 0, abandoned: 0 };
    }

    // Nothing took it. #58: "a delivery failure must itself escalate through
    // a different path" — a retry of the same transport is not a different
    // path, because if the push service is down or there are no devices,
    // trying again produces the same silence.
    const reason = describeFailure(
      targets.length,
      outcomes,
      this.push.isConfigured(),
    );
    const rerouted = await this.reroute(escalation.id, payload, reason, now);

    if (rerouted)
      return { dispatched: 1, failed: 0, rerouted: 1, abandoned: 0 };

    await this.prisma.escalation.update({
      where: { id: escalation.id },
      data: {
        status: 'failed',
        failureReason: reason,
        deliveryAttempts: { increment: 1 },
      },
    });

    // Was that the last try? Read from the value the update just wrote, not
    // from the stale row we loaded, so the count cannot drift.
    const attempts = escalation.deliveryAttempts + 1;
    const abandoned = attempts >= MAX_DELIVERY_ATTEMPTS;

    // At `error`, with a marker an infrastructure alert can match. Two
    // different sentences, because they are two different situations: one
    // will be tried again shortly, and one never will.
    this.logger.error(
      abandoned
        ? `NOTIFICATION ABANDONED — escalation ${escalation.id} (${escalation.summary}) failed ` +
            `${attempts} times and will NOT be retried. Nobody has been told. ${reason}`
        : `NOTIFICATION FAILED — escalation ${escalation.id} (${escalation.summary}), attempt ` +
            `${attempts} of ${MAX_DELIVERY_ATTEMPTS}, will retry next tick. ${reason}`,
    );

    return {
      dispatched: 0,
      failed: 1,
      rerouted: 0,
      abandoned: abandoned ? 1 : 0,
    };
  }

  /** The second path. Returns true when it took the message. */
  private async reroute(
    escalationId: string,
    payload: ReturnType<typeof buildPayload>,
    pushFailure: string,
    now: Date,
  ): Promise<boolean> {
    if (!this.fallback.isConfigured()) return false;

    const outcome = await this.fallback.send(WEBHOOK_TARGET, payload);
    if (!outcome.accepted) return false;

    await this.prisma.escalation.update({
      where: { id: escalationId },
      data: {
        status: 'dispatched',
        transport: this.fallback.name,
        receiptId: payload.receiptId,
        dispatchedAt: now,
        // Recorded even though the escalation went out: the operator needs to
        // know their phone is not working, and a successful fallback that
        // erased the reason it was needed would hide that.
        failureReason: `Web Push did not deliver, re-routed to the fallback webhook. ${pushFailure}`,
        deliveryAttempts: { increment: 1 },
      },
    });

    this.logger.warn(
      `Escalation ${escalationId} re-routed to the fallback webhook: ${pushFailure}`,
    );
    return true;
  }

  /**
   * Dispatched, and no device ever said it arrived.
   *
   * The whole reason `dispatched` is a distinct status. Without this sweep an
   * escalation the push service accepted and nothing displayed would sit
   * looking handled forever — indistinguishable, from the cockpit, from one
   * an operator has seen.
   */
  private async sweepOverdue(now: Date): Promise<number> {
    const timeoutMs = this.settings.get('notifications.receiptTimeoutMs');
    const cutoff = new Date(now.getTime() - timeoutMs);

    const overdue = await this.prisma.escalation.findMany({
      where: {
        status: 'dispatched',
        deliveredAt: null,
        dispatchedAt: { lt: cutoff },
      },
      select: { id: true, summary: true, failureReason: true },
    });

    for (const escalation of overdue) {
      await this.prisma.escalation.update({
        where: { id: escalation.id },
        data: {
          status: 'failed',
          failureReason:
            `A transport accepted this escalation but no device confirmed it within ` +
            `${Math.round(timeoutMs / 1000)}s. It was sent and probably not seen.` +
            (escalation.failureReason
              ? ` Earlier: ${escalation.failureReason}`
              : ''),
        },
      });

      this.logger.error(
        `NOTIFICATION UNCONFIRMED — escalation ${escalation.id} (${escalation.summary}) was ` +
          `accepted by a transport and never confirmed by a device`,
      );
    }

    return overdue.length;
  }
}

/**
 * Why nothing took it, in terms an operator can act on.
 *
 * Three genuinely different problems — no configuration, no devices, every
 * device rejecting — with three different fixes. A single "delivery failed"
 * would leave the operator to work out which, at the exact moment they are
 * least equipped to.
 */
function describeFailure(
  targetCount: number,
  outcomes: { error?: string; statusCode?: number }[],
  configured: boolean,
): string {
  if (!configured) {
    return (
      'Web Push is not configured: set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT. ' +
      'Until then no escalation can reach a phone.'
    );
  }

  if (targetCount === 0) {
    return (
      'No devices are subscribed. Open the cockpit on a phone and enable notifications, ' +
      'or every escalation will stop here.'
    );
  }

  const reasons = outcomes
    .map(
      (outcome) =>
        (outcome.statusCode ? `${outcome.statusCode}: ` : '') +
        (outcome.error ?? ''),
    )
    .filter((reason) => reason.length > 0);

  return `All ${targetCount} subscribed device(s) rejected the notification. ${reasons.join('; ')}`;
}
