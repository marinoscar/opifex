import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';

import { EscalationsService } from '../escalations/escalations.service';
import { PrismaService } from '../prisma/prisma.service';
import { buildPayload } from './notification-payload';
import { FallbackWebhookTransport, WEBHOOK_TARGET } from './fallback-webhook.transport';
import { PushSubscriptionsService } from './push-subscriptions.service';
import { WebPushTransport } from './web-push.transport';

export interface DispatchResult {
  /** Escalations handed to a transport this pass. */
  dispatched: number;
  /** Escalations no transport would accept. */
  failed: number;
  /** Dispatched escalations whose receipt window expired with no receipt. */
  timedOut: number;
  /** Escalations re-routed to the fallback path after Web Push failed. */
  rerouted: number;
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
    private readonly config: ConfigService,
  ) {}

  /**
   * One pass: send what is raised, then fail what was never receipted.
   *
   * Order matters. Sweeping timeouts FIRST would give every escalation
   * dispatched in this same pass a zero-length receipt window on the next
   * one; sweeping after means a dispatch always gets its full window.
   */
  async dispatchPending(now: Date = new Date()): Promise<DispatchResult> {
    const result: DispatchResult = { dispatched: 0, failed: 0, timedOut: 0, rerouted: 0 };

    for (const escalation of await this.loadRaised()) {
      const outcome = await this.deliver(escalation, now);
      result.dispatched += outcome.dispatched;
      result.failed += outcome.failed;
      result.rerouted += outcome.rerouted;
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

    this.logger.log(`Escalation ${escalation.id} confirmed delivered by a device`);
    return { escalationId: escalation.id, recorded: true };
  }

  private async loadRaised() {
    return this.prisma.escalation.findMany({
      where: { status: 'raised' },
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
    escalation: Awaited<ReturnType<EscalationDispatcher['loadRaised']>>[number],
    now: Date,
  ): Promise<{ dispatched: number; failed: number; rerouted: number }> {
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
      return { dispatched: 1, failed: 0, rerouted: 0 };
    }

    // Nothing took it. #58: "a delivery failure must itself escalate through
    // a different path" — a retry of the same transport is not a different
    // path, because if the push service is down or there are no devices,
    // trying again produces the same silence.
    const reason = describeFailure(targets.length, outcomes, this.push.isConfigured());
    const rerouted = await this.reroute(escalation.id, payload, reason, now);

    if (rerouted) return { dispatched: 1, failed: 0, rerouted: 1 };

    await this.prisma.escalation.update({
      where: { id: escalation.id },
      data: {
        status: 'failed',
        failureReason: reason,
        deliveryAttempts: { increment: 1 },
      },
    });

    // At `error`, with a marker an infrastructure alert can match. This is
    // the end of the line: nobody has been told, and the only remaining
    // channel is the server's own logs and the cockpit's `failed` list.
    this.logger.error(
      `NOTIFICATION FAILED — nobody has been told about escalation ${escalation.id} ` +
        `(${escalation.summary}). ${reason}`,
    );

    return { dispatched: 0, failed: 1, rerouted: 0 };
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
    const timeoutMs = this.config.get<number>('notifications.receiptTimeoutMs') ?? 120_000;
    const cutoff = new Date(now.getTime() - timeoutMs);

    const overdue = await this.prisma.escalation.findMany({
      where: { status: 'dispatched', deliveredAt: null, dispatchedAt: { lt: cutoff } },
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
            (escalation.failureReason ? ` Earlier: ${escalation.failureReason}` : ''),
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
    .map((outcome) => (outcome.statusCode ? `${outcome.statusCode}: ` : '') + (outcome.error ?? ''))
    .filter((reason) => reason.length > 0);

  return `All ${targetCount} subscribed device(s) rejected the notification. ${reasons.join('; ')}`;
}
