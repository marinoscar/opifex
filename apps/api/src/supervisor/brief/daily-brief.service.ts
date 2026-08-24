import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { FallbackWebhookTransport } from '../../notifications/fallback-webhook.transport';
import type { NotificationPayload } from '../../notifications/notification-payload';
import { PushSubscriptionsService } from '../../notifications/push-subscriptions.service';
import { WebPushTransport } from '../../notifications/web-push.transport';
import { DecisionLogService } from '../decision-log/decision-log.service';
import { SnapshotService } from '../snapshot/snapshot.service';
import { type DailyBrief, composeBrief, rankBrief } from './daily-brief';
import { type TrustDigest, buildTrustDigest } from './trust-digest';
import { TrustDigestSource } from './trust-digest.source';

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
 *
 * ## One artifact, two halves (#100, ADR-0012)
 *
 * The trust digest is gathered here and rendered as a SECTION of this brief.
 * No second cron, no second notification, no second endpoint: ADR-0012
 * disqualified all three, because "two competing daily summaries is how both
 * get ignored."
 *
 * The digest is also gathered SECOND and defensively. `TrustDigestSource`
 * returns null rather than throwing, and a null digest means the brief goes
 * out with its pre-#100 trust line. The ranked half is about what needs a
 * human now; losing it because a trust query failed would trade the urgent
 * half for the retrospective one.
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
    private readonly trust: TrustDigestSource,
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

    const digestInput = await this.trust.collect(now);
    const digest = digestInput ? buildTrustDigest(digestInput) : undefined;

    const brief = rankBrief(state, digest);
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
            summary: proposalSummary(brief, digest),
            reasoning: text,
            targetKind: 'factory',
            details: {
              items: brief.items,
              trustExecuted: brief.trustExecuted,
              trustNotShown: brief.trustNotShown,
              // The structured digest goes into the log alongside the prose,
              // so "what ran under trust" is queryable rather than only
              // readable. #99's ladder and #115's renewal prompt both want the
              // numbers, not the sentence.
              trust: digest
                ? {
                    windowStart: digestInput?.windowStart.toISOString() ?? null,
                    quiet: digest.quiet,
                    totalCostUsd: digest.totalCostUsd,
                    costUnknownActions: digest.costUnknownActions,
                    perGrant: digest.perGrant,
                    grantStates: digest.grantStates,
                    endedGrants: digest.endedGrants,
                    anomalies: digest.anomalies,
                  }
                : null,
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

/**
 * The one line the decision log shows for this brief.
 *
 * The ranked half sets the sentence; the trust half APPENDS to it rather than
 * replacing it. A day where nothing needed a human but twelve actions ran
 * unattended is still "nothing needed you" — that is what the ranking means —
 * and it is also not a day whose log entry should read as if nothing happened.
 */
function proposalSummary(brief: DailyBrief, digest?: TrustDigest): string {
  const base = brief.quiet
    ? 'Nothing needed you today.'
    : `${brief.items.length} item(s) need you; top: ${brief.items[0].headline}`;

  const ranUnderTrust = digest ? digest.executed.length + digest.notShown : 0;
  if (ranUnderTrust === 0) return base;

  return `${base} ${ranUnderTrust} action(s) ran under trust.`;
}

function firstLine(text: string): string {
  const line =
    text.split('\n').find((candidate) => candidate.trim() !== '') ?? '';
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
