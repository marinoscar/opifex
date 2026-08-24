import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { FallbackWebhookTransport } from '../../notifications/fallback-webhook.transport';
import type { NotificationPayload } from '../../notifications/notification-payload';
import { PushSubscriptionsService } from '../../notifications/push-subscriptions.service';
import { WebPushTransport } from '../../notifications/web-push.transport';
import { DecisionLogService } from '../decision-log/decision-log.service';
import { SnapshotService } from '../snapshot/snapshot.service';
import { composeBrief, rankBrief } from './daily-brief';

/**
 * Compose, record and deliver the daily brief (#93).
 *
 * ## Not a proposer, and deliberately
 *
 * The supervisor invocation is hourly; the brief is daily. A proposer would
 * either need to know when it last ran — which means giving proposers a
 * handle on the decision log, and the whole point of `SupervisorProposer` is
 * that it holds nothing but a snapshot and a text-in-text-out model — or it
 * would send twenty-four briefs a day.
 *
 * It is still supervisor output, still recorded in the decision log under the
 * `daily-brief` action class, and still executes nothing.
 *
 * ## Not an escalation
 *
 * VISION §8 defines the brief as the things that did NOT warrant waking
 * someone. Minting an `Escalation` row to reuse the delivery path would
 * inflate the escalation lifecycle and the latency percentiles computed over
 * it — success metric 1 would start counting briefs. So the brief rides the
 * `NotificationTransport` seam directly, at `normal` priority, with no
 * receipt: receipts exist to prove somebody was TOLD about a stall, and a
 * brief nobody read is a brief, not a missed escalation.
 *
 * ## Delivery failing does not lose the brief
 *
 * The proposal is written first. A brief that was composed and could not be
 * sent is in the log where an operator can find it, and the log entry says
 * delivery failed — which is the same distinction #58 insists on between "we
 * tried to tell you" and "we never noticed".
 */
@Injectable()
export class DailyBriefService {
  private readonly logger = new Logger(DailyBriefService.name);

  constructor(
    private readonly snapshots: SnapshotService,
    private readonly log: DecisionLogService,
    private readonly subscriptions: PushSubscriptionsService,
    private readonly push: WebPushTransport,
    private readonly fallback: FallbackWebhookTransport,
    private readonly config: ConfigService,
  ) {}

  /** Compose, record, deliver. Never throws. */
  async send(
    now: Date = new Date(),
  ): Promise<{ proposalId: string | null; delivered: boolean }> {
    const startedAt = now;

    let state;
    try {
      state = await this.snapshots.collect(now);
    } catch (error) {
      this.logger.error(
        `Could not read state for the daily brief: ${message(error)}`,
      );
      return { proposalId: null, delivered: false };
    }

    const brief = rankBrief(state);
    const text = composeBrief(brief, state);
    const delivered = await this.deliver(brief.quiet, text, now);

    try {
      const { proposalIds } = await this.log.record(
        {
          startedAt,
          finishedAt: new Date(),
          outcome: 'completed',
          // No model was asked. The ranking is deterministic, and recording a
          // model name here would put a claim in the log that nothing backs.
          model: 'none',
          snapshotText: text,
          snapshotGeneratedAt: state.generatedAt,
          snapshotCharacters: text.length,
        },
        [
          {
            actionClass: 'daily-brief',
            // A quiet day is still a proposal: "nothing needed you" is the
            // answer, not the absence of one, and #90 needs the log to have
            // no gaps.
            outcome: 'proposed',
            summary: brief.quiet
              ? 'Nothing needed you today.'
              : `${brief.items.length} item(s) need you; top: ${brief.items[0].headline}`,
            reasoning: text,
            targetKind: 'factory',
            details: {
              items: brief.items,
              trustExecuted: brief.trustExecuted,
              trustNotShown: brief.trustNotShown,
              delivered,
            },
          },
        ],
      );
      return { proposalId: proposalIds[0] ?? null, delivered };
    } catch (error) {
      this.logger.error(`Could not record the daily brief: ${message(error)}`);
      return { proposalId: null, delivered };
    }
  }

  /**
   * Send through the same transports escalations use, at `normal` priority.
   *
   * Push first, webhook second — the same order and the same seam as
   * `EscalationDispatcher`, so a deployment configured for one is configured
   * for both.
   */
  private async deliver(
    quiet: boolean,
    text: string,
    now: Date,
  ): Promise<boolean> {
    const payload: NotificationPayload = {
      title: quiet ? 'Opifex: a quiet day' : 'Opifex daily brief',
      body: firstLine(text),
      why: text,
      // The four VISION §8 fields exist for an interruption. A brief is not
      // one, and saying so plainly beats inventing a blast radius for a
      // summary.
      blastRadius: 'None. This is a summary, not an escalation.',
      ifIgnored:
        'Nothing changes. Everything in it is already recorded in the cockpit and the ' +
        'decision log.',
      url: `${this.config.get<string>('appUrl') ?? ''}/runs`,
      kind: 'daily_brief',
      priority: 'normal',
      raisedAt: now.toISOString(),
    };

    let anyAccepted = false;

    try {
      const targets = await this.subscriptions.targets();
      if (this.push.isConfigured()) {
        for (const target of targets) {
          const outcome = await this.push.send(target, payload);
          anyAccepted = anyAccepted || outcome.accepted;
        }
      }
    } catch (error) {
      this.logger.warn(`Daily brief push failed: ${message(error)}`);
    }

    if (!anyAccepted && this.fallback.isConfigured()) {
      try {
        const outcome = await this.fallback.send(
          { id: 'daily-brief', endpoint: '', keys: { p256dh: '', auth: '' } },
          payload,
        );
        anyAccepted = anyAccepted || outcome.accepted;
      } catch (error) {
        this.logger.warn(`Daily brief webhook failed: ${message(error)}`);
      }
    }

    return anyAccepted;
  }
}

function firstLine(text: string): string {
  const line =
    text.split('\n').find((candidate) => candidate.trim() !== '') ?? '';
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
