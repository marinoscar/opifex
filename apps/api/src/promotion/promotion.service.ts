import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  Prisma,
  PromotionChangeReason,
  PromotionRung,
} from '@prisma/client';

import { ApprovalGateService } from '../approvals/approval-gate.service';
import { FallbackWebhookTransport } from '../notifications/fallback-webhook.transport';
import type { NotificationPayload } from '../notifications/notification-payload';
import { PushSubscriptionsService } from '../notifications/push-subscriptions.service';
import { WebPushTransport } from '../notifications/web-push.transport';
import { PrismaService } from '../prisma/prisma.service';
import {
  getActionClass,
  isActionClass,
  isAutonomyEligible,
} from '../supervisor/action-classes';
import { DecisionLogService } from '../supervisor/decision-log/decision-log.service';
import { TrustGrantService } from '../trust/trust-grant.service';
import {
  DEMOTION_MIN_SAMPLE,
  DEMOTION_RATE,
  LADDER_CLASSES,
  LIFETIME_WINDOW_DAYS,
  MIN_SAMPLE,
  PROMOTION_RATE,
  REGRESSION_WINDOW_DAYS,
  type ClassEvidence,
  emptyEvidence,
  evaluateLadder,
  pct,
  promotionOrderAnomaly,
  rateOf,
  rungFor,
} from './promotion-policy';

/**
 * One rung change the ladder made, and everything it rested on.
 *
 * Returned rather than only logged so the task can report it, the spec can
 * assert on it, and #101 can render "what changed and why" without re-deriving
 * anything.
 */
export interface LadderChange {
  actionClass: string;
  from: PromotionRung;
  to: PromotionRung;
  /** Null for the `observe` -> `measure` transition, which decides nothing. */
  reason: PromotionChangeReason | null;
  detail: string;
  /** The numbers the decision was made from, as they were frozen on the row. */
  evidence: ClassEvidence;
  /** Whether an operator was actually told. False is a real, recorded outcome. */
  notified: boolean;
  /** Grants suspended as a consequence. Demotions only. */
  grantsSuspended: number;
}

/** What one evaluation concluded, in full. */
export interface EvaluateResult {
  evaluatedAt: string;
  paused: boolean;
  changes: LadderChange[];
  /** Every class that did not move, and what it is waiting on. */
  holds: { actionClass: string; rung: PromotionRung; detail: string }[];
}

/** A `PromotionState` row as a read model renders it (#101). */
export interface PromotionStateView {
  actionClass: string;
  rung: PromotionRung;
  eligible: boolean;
  changedAt: string;
  changeReason: PromotionChangeReason | null;
  changeDetail: string | null;
  evidence: ClassEvidence | null;
  promotedAt: string | null;
  demotedAt: string | null;
  demotionCount: number;
}

/**
 * The thresholds a `requirement` sentence refers to, published as numbers.
 *
 * The sentence is authoritative and a client should render it verbatim; these
 * exist so a progress bar can be drawn without PARSING it. They are re-exported
 * from `promotion-policy.ts` rather than restated, so a bar and the sentence
 * beside it cannot describe different thresholds.
 */
export const LADDER_THRESHOLDS = Object.freeze({
  /** Fewest human decisions a class may be promoted on. */
  minSample: MIN_SAMPLE,
  /** Approval rate required to promote, over `minSample` or more. */
  promotionRate: PROMOTION_RATE,
  /** Rate a promoted class must stay above. Below `promotionRate` — the band
   * between them is the hysteresis that stops one decision oscillating a
   * class. */
  demotionRate: DEMOTION_RATE,
  /** Fewest RECENT decisions a demotion may rest on. */
  demotionMinSample: DEMOTION_MIN_SAMPLE,
  /** The window `recent*` counts are measured over. */
  regressionWindowDays: REGRESSION_WINDOW_DAYS,
});

/** A ladder state with the live evidence and the policy layer's sentence. */
export interface PromotionLadderStateView extends PromotionStateView {
  /** ADR-0011 registry title, or NULL — never the raw id. */
  actionClassTitle: string | null;
  /**
   * The evidence AS IT STANDS NOW, distinct from the frozen `evidence` the
   * last rung change was made from. `rate` is the approval rate and `sample`
   * the sample size the promotion rule reads.
   */
  currentEvidence: ClassEvidence;
  /**
   * What would be needed to promote — or, for a promoted class, what is
   * keeping it there. The policy layer's own sentence, verbatim.
   */
  requirement: string;
  /**
   * What the next evaluation would do over this evidence, or null for a hold.
   *
   * A FORECAST, not a plan: when `PromotionLadderView.enabled` is false
   * nothing will act on it. Render it as such.
   */
  wouldChange: 'promote' | 'demote' | null;
}

/** The whole ladder, plus the one fact that makes the rungs mean anything. */
export interface PromotionLadderView {
  /**
   * Whether `PROMOTION_LADDER_ENABLED` is on. DEFAULTS OFF.
   *
   * Reported at the top level and not per class because it is one switch. A
   * cockpit that showed rungs without saying the ladder is off would be
   * actively misleading: every rung would look like a live conclusion when in
   * fact nothing has moved or will move.
   */
  enabled: boolean;
  readAt: string;
  thresholds: typeof LADDER_THRESHOLDS;
  states: PromotionLadderStateView[];
}

/** What a hand-demotion did. */
export interface ManualDemotionResult {
  state: PromotionLadderStateView;
  /** Active grants for the class that were suspended. The durable effect. */
  grantsSuspended: number;
  /** Whether any transport accepted the notification. False is a real outcome. */
  notified: boolean;
  /**
   * Whether the next evaluation would put the class straight back on the
   * promoted rung, because its lifetime record still clears the bar.
   *
   * TRUE is the common case for a class demoted while its numbers are good.
   * The suspended grants stay suspended either way, so nothing resumes running
   * — but the rung will read `promoted` again, and an operator not told that
   * would reasonably conclude the demotion had been undone or had never
   * worked.
   */
  rungMayBeRestoredByLadder: boolean;
}

/**
 * The promotion ladder (#99, epic #22, VISION §7 "Earned autonomy").
 *
 * ## What this service does NOT do: mint grants
 *
 * A promotion makes a class ELIGIBLE for a trust grant. It does not create
 * one, and nothing in this file can. That separation is the point rather than
 * an omission:
 *
 * VISION §8 requires every grant to carry four attributes — scope (action
 * class x repository), expiry, a budget ceiling, and auto-revoke thresholds.
 * The ladder knows exactly one of the four. It measures per CLASS, across all
 * repositories, and has no opinion about which repository the operator wants
 * autonomy in, how long for, or how much money it may spend. A grant minted
 * from a promotion would have to invent the other three, and an invented
 * budget ceiling is a spend limit nobody chose.
 *
 * More directly: VISION §8's "Always approve this class" is a TAP. It is the
 * moment a human extends trust, and it is the only edge in the provenance
 * graph that says a person did. A ladder that minted grants would make the
 * system grant itself authority on its own measurements — "an agent that can
 * grant itself trust has the appearance of guardrails and none of the
 * substance." The promotion is the evidence that makes the tap reasonable; the
 * tap is still the tap.
 *
 * ## What it DOES do on demotion: suspend grants
 *
 * The reverse direction is not symmetric, and should not be. On demotion this
 * suspends every active grant for the class with `endReason: 'class_demoted'`.
 * Narrowing authority is always safe, needs no attributes invented, and needs
 * no human present — VISION §7 rung 4 is explicit that demotion is "automatic
 * on regression, not a judgment call". Leaving grants live for a demoted class
 * would make demotion cosmetic: the rung would read `measure` on the cockpit
 * while the class carried on executing unattended under a grant nobody
 * revoked.
 *
 * Suspend, not revoke. `TrustGrantService` separates the two deliberately —
 * suspension is the system's opinion on evidence and a human may disagree with
 * it; revocation is a decision. This is the former.
 */
@Injectable()
export class PromotionService {
  private readonly logger = new Logger(PromotionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gate: ApprovalGateService,
    private readonly log: DecisionLogService,
    private readonly trust: TrustGrantService,
    private readonly subscriptions: PushSubscriptionsService,
    private readonly push: WebPushTransport,
    private readonly fallback: FallbackWebhookTransport,
    private readonly config: ConfigService,
  ) {}

  /**
   * Whether the ladder may change anything.
   *
   * DEFAULTS OFF, compared against `true` so unset, misspelled and empty all
   * mean off — the rule every outward-acting switch in `configuration.ts`
   * follows. It belongs in that set for the same reason `DISPATCH_ENABLED`
   * does: turning this on is what eventually causes things to run unattended,
   * and a default that said yes would make that an accident rather than a
   * decision.
   */
  get enabled(): boolean {
    return this.config.get<boolean>('promotion.enabled') === true;
  }

  /**
   * Gather per-class evidence from BOTH sources, summed.
   *
   * See `ClassEvidence` for why both, and why neither may include a timeout or
   * a grant-authorized action. The exclusions are not re-derived here: this
   * consumes `ApprovalGateService.approvalRatesByClass`, which already applies
   * them, and `DecisionLogService.approvalRates`, whose `wouldApprove` /
   * `wouldReject` counts are human review verdicts by construction.
   *
   * ## Recency is measured from when the decision was RAISED
   *
   * Both upstream read models filter on `createdAt` — when the proposal was
   * made, or the approval requested — not on when a human answered. So a
   * proposal raised twenty days ago and reviewed yesterday is not recent
   * evidence, even though the judgement is. Using the two sources' own filters
   * rather than a third definition is deliberate: a window computed here would
   * have to re-query both tables and would then be a second implementation
   * that could disagree with the numbers #100's digest and #101's cockpit show.
   *
   * The cost is real and worth naming: an operator who clears a month-old
   * review backlog in one sitting produces evidence that counts toward the
   * lifetime record but not toward the recent window, so a class cannot be
   * demoted on a catch-up session. That errs toward not demoting on evidence
   * about an old factory, which is the safer of the two mistakes here.
   */
  async gatherEvidence(now: Date = new Date()): Promise<ClassEvidence[]> {
    const recentSince = new Date(
      now.getTime() - REGRESSION_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );

    const [
      lifetimeProposals,
      recentProposals,
      lifetimeApprovals,
      recentApprovals,
    ] = await Promise.all([
      this.log.approvalRates(),
      this.log.approvalRates(recentSince),
      this.gate.approvalRatesByClass(LIFETIME_WINDOW_DAYS, now),
      this.gate.approvalRatesByClass(REGRESSION_WINDOW_DAYS, now),
    ]);

    // Seeded with EVERY registered class, so a class nothing has proposed
    // appears with zeros rather than being absent. #90 makes the same argument
    // about its own read model: a class MISSING from the list is
    // indistinguishable from a class that has never been asked for, and the
    // ladder must be able to tell "not yet measured" from "never proposed".
    const byClass = new Map<string, ClassEvidence>(
      LADDER_CLASSES.map((id) => [id, emptyEvidence(id)]),
    );

    const bucket = (actionClass: string): ClassEvidence => {
      const existing = byClass.get(actionClass);
      if (existing) return existing;
      // A class in the history that is no longer in the registry. Kept rather
      // than dropped: it may be promoted right now, and a promoted class that
      // vanished from this list would never be re-evaluated and never demoted.
      const created = emptyEvidence(actionClass);
      byClass.set(actionClass, created);
      return created;
    };

    for (const row of lifetimeProposals) {
      const entry = bucket(row.actionClass);
      entry.approved += row.wouldApprove;
      entry.rejected += row.wouldReject;
      entry.fromProposals += row.wouldApprove + row.wouldReject;
    }

    for (const row of lifetimeApprovals) {
      const entry = bucket(row.actionClass);
      entry.approved += row.approved;
      entry.rejected += row.denied;
      entry.fromApprovals += row.approved + row.denied;
    }

    for (const row of recentProposals) {
      const entry = bucket(row.actionClass);
      entry.recentApproved += row.wouldApprove;
      entry.recentRejected += row.wouldReject;
    }

    for (const row of recentApprovals) {
      const entry = bucket(row.actionClass);
      entry.recentApproved += row.approved;
      entry.recentRejected += row.denied;
    }

    const result = [...byClass.values()];
    for (const entry of result) {
      entry.sample = entry.approved + entry.rejected;
      entry.rate = rateOf(entry.approved, entry.rejected);
      entry.recentSample = entry.recentApproved + entry.recentRejected;
      entry.recentRate = rateOf(entry.recentApproved, entry.recentRejected);
    }

    // A total order, so two classes with identical counts do not swap places
    // between reads of the same data.
    return result.sort((a, b) => a.actionClass.localeCompare(b.actionClass));
  }

  /**
   * Evaluate every class, persist what changed, notify, return the lot.
   *
   * ## Idempotent by construction, not by care
   *
   * The rung is a total function of two facts — is it promoted, has anyone
   * judged it (`rungFor`) — so a second call over unchanged evidence computes
   * the same rung, finds the row already says so, and writes nothing. That is
   * a property of the shape rather than a guard someone has to remember: an
   * implementation that appended a transition each tick would need a
   * "did anything change" check that a later refactor could quietly drop, and
   * the symptom would be an hourly demotion notification for a class that had
   * not moved.
   *
   * Never throws. It runs on the shared scheduler, and a task that threw would
   * take the reconciler's cleanup and the run-summary sweep with it — for the
   * sake of a promotion nobody was waiting on this hour.
   */
  async evaluate(now: Date = new Date()): Promise<EvaluateResult> {
    const paused = !this.enabled;
    const evidence = await this.gatherEvidence(now);
    const states = await this.prisma.promotionState.findMany();
    const byClass = new Map(states.map((row) => [row.actionClass, row]));

    const changes: LadderChange[] = [];
    const holds: EvaluateResult['holds'] = [];

    for (const item of evidence) {
      const existing = byClass.get(item.actionClass);
      const current: PromotionRung = existing?.rung ?? 'observe';
      const eligible = isAutonomyEligible(item.actionClass);

      const verdict = evaluateLadder(current, item, eligible, paused);

      const promoted =
        verdict.action === 'promote'
          ? true
          : verdict.action === 'demote'
            ? false
            : current === 'promoted';
      const target = rungFor(promoted, item);

      if (verdict.action === 'hold') {
        if (target === current) {
          holds.push({
            actionClass: item.actionClass,
            rung: current,
            detail: verdict.detail,
          });
          continue;
        }

        // `observe` -> `measure`: the first human judgement of this class
        // arrived. A rung change, but not a DECISION — nothing was promoted or
        // demoted and nothing runs differently, so it carries no
        // `changeReason` (the column is nullable for exactly this) and sends no
        // notification. Waking someone to say "one data point exists now" is
        // the interruption VISION §8 exists to remove.
        await this.persist(item, target, null, verdict.detail, now, existing);
        changes.push({
          actionClass: item.actionClass,
          from: current,
          to: target,
          reason: null,
          detail: verdict.detail,
          evidence: item,
          notified: false,
          grantsSuspended: 0,
        });
        continue;
      }

      if (verdict.action === 'promote') {
        await this.persist(
          item,
          target,
          'promoted_on_evidence',
          verdict.reason,
          now,
          existing,
        );

        // Computed AFTER the write, so the anomaly check sees the promotion it
        // is commenting on. A check run against the pre-promotion set could
        // never flag the promotion currently being made, which is the only one
        // the operator is being shown right now.
        const promotedNow = [
          ...states
            .filter(
              (row) =>
                row.rung === 'promoted' && row.actionClass !== item.actionClass,
            )
            .map((row) => row.actionClass),
          item.actionClass,
        ];

        const notified = await this.notifyPromotion(
          item,
          verdict.reason,
          promotionOrderAnomaly(promotedNow),
          now,
        );

        this.logger.log(
          `Promoted "${item.actionClass}" to auto-execution. ${verdict.reason}`,
        );

        changes.push({
          actionClass: item.actionClass,
          from: current,
          to: target,
          reason: 'promoted_on_evidence',
          detail: verdict.reason,
          evidence: item,
          notified,
          // Nothing. A promotion makes the class eligible for a grant; it does
          // not create one. See the class doc.
          grantsSuspended: 0,
        });
        continue;
      }

      // --- Demotion ---------------------------------------------------------
      await this.persist(
        item,
        target,
        verdict.reason,
        verdict.detail,
        now,
        existing,
      );

      const grantsSuspended = await this.suspendGrantsFor(
        item.actionClass,
        verdict.detail,
        now,
      );

      const notified = await this.notifyDemotion(
        item,
        verdict.reason,
        verdict.detail,
        grantsSuspended,
        now,
      );

      this.logger.warn(
        `Demoted "${item.actionClass}" (${verdict.reason}); ` +
          `${grantsSuspended} active grant(s) suspended. ${verdict.detail}`,
      );

      changes.push({
        actionClass: item.actionClass,
        from: current,
        to: target,
        reason: verdict.reason,
        detail: verdict.detail,
        evidence: item,
        notified,
        grantsSuspended,
      });
    }

    return {
      evaluatedAt: now.toISOString(),
      paused,
      changes,
      holds,
    };
  }

  // -------------------------------------------------------------------------
  // Reads (#101)
  // -------------------------------------------------------------------------

  /**
   * Where one class stands.
   *
   * A class with no row is reported at `observe` with zero demotions rather
   * than as a 404. The ladder not having run yet is not the same as the class
   * not existing, and a read surface that could not tell an operator "this is
   * on rung 1" until a cron had fired would look broken on a fresh install.
   */
  async stateFor(actionClass: string): Promise<PromotionStateView> {
    const row = await this.prisma.promotionState.findUnique({
      where: { actionClass },
    });
    return row ? toView(row) : defaultView(actionClass);
  }

  /** Every registered class, in registry order, whether or not it has a row. */
  async allStates(): Promise<PromotionStateView[]> {
    const rows = await this.prisma.promotionState.findMany();
    const byClass = new Map(rows.map((row) => [row.actionClass, toView(row)]));

    const views = LADDER_CLASSES.map(
      (id) => byClass.get(id) ?? defaultView(id),
    );

    // Rows for classes no longer in the registry are appended rather than
    // hidden. One of them may still be promoted, and a cockpit that did not
    // show it would report less autonomy than the system actually holds.
    const extras = [...byClass.values()].filter(
      (view) => !LADDER_CLASSES.includes(view.actionClass as never),
    );

    return [...views, ...extras];
  }

  /**
   * The whole ladder as the cockpit reads it: every class, where it stands,
   * and what it is waiting on (#101).
   *
   * ## The requirement sentence comes from the policy layer, never from here
   *
   * `requirement` is `evaluateLadder`'s own verdict text — the same
   * `holdDetail` the hourly evaluation would produce over the same evidence.
   * It is not re-derived, and that is the point rather than a convenience:
   * `promotion-policy.ts` argues that a cockpit computing "2 more needed" from
   * its own copy of `MIN_SAMPLE` would be a second copy, and the day someone
   * tuned the threshold the screen would confidently state a requirement that
   * no longer applies. One implementation decides and explains; this read just
   * carries the sentence.
   *
   * ## Why it is evaluated as if the ladder were RUNNING
   *
   * `evaluateLadder` is called with `paused: false` even when the ladder is
   * globally off, and `enabled` reports the switch separately. Rule 2 short-
   * circuits a paused ladder to "the ladder is paused" for EVERY class, which
   * would be true and useless: `PROMOTION_LADDER_ENABLED` defaults off, so on
   * a typical deployment every class would answer the operator's question
   * ("what would it take to promote this?") with the same sentence about a
   * flag, and the shortfall — the one number they can act on — would be
   * invisible precisely when they most need it. Reporting the pause once,
   * globally, and the evidence per class keeps both facts and confuses
   * neither. `wouldChange` is what the next evaluation WOULD do if the ladder
   * were on; while `enabled` is false it is a forecast, not a plan, and a
   * client must render it as one.
   *
   * Evidence is gathered ONCE for the whole list rather than per class: it is
   * four queries, and doing them per class would make a cockpit poll scale
   * with the taxonomy.
   */
  async ladder(now: Date = new Date()): Promise<PromotionLadderView> {
    const [states, evidence] = await Promise.all([
      this.allStates(),
      this.gatherEvidence(now),
    ]);

    const byClass = new Map(evidence.map((item) => [item.actionClass, item]));

    return {
      enabled: this.enabled,
      readAt: now.toISOString(),
      thresholds: LADDER_THRESHOLDS,
      states: states.map((state) =>
        this.withRequirement(state, byClass.get(state.actionClass)),
      ),
    };
  }

  /**
   * One class, the same way.
   *
   * A registered class with no row is reported at `observe` rather than as a
   * 404 — the ladder not having run yet is not the same as the class not
   * existing, and a read that 404'd until a cron had fired would look broken
   * on a fresh install. An UNREGISTERED id with no row is a 404, though: it is
   * a typo, and answering "this is on rung 1, no evidence" for `re-dispach`
   * would be a confident answer about nothing.
   */
  async ladderStateFor(
    actionClass: string,
    now: Date = new Date(),
  ): Promise<PromotionLadderStateView> {
    if (!isActionClass(actionClass)) {
      // Only for an unrecognised id, so the common path stays one round trip.
      // A row can outlive its registry entry — that class is still reportable,
      // because it may be standing on the promoted rung right now.
      const row = await this.prisma.promotionState.findUnique({
        where: { actionClass },
        select: { actionClass: true },
      });
      if (!row) {
        throw new NotFoundException(
          `Unknown action class "${actionClass}". The taxonomy is ` +
            'apps/api/src/supervisor/action-classes.ts (ADR-0011), and no ' +
            'ladder row exists under that id either.',
        );
      }
    }

    const [state, evidence] = await Promise.all([
      this.stateFor(actionClass),
      this.gatherEvidence(now),
    ]);

    return this.withRequirement(
      state,
      evidence.find((item) => item.actionClass === actionClass),
    );
  }

  /**
   * Join one persisted state to live evidence and the policy layer's verdict.
   *
   * `currentEvidence` and `evidence` are deliberately BOTH present and are
   * different things. `evidence` is frozen: the counts the last rung change
   * was actually made from, never refreshed, because #99 requires a decision
   * to state its evidence and evidence that moves afterwards cannot be checked
   * against the decision. `currentEvidence` is the factory as it stands now.
   * A screen that showed only the first would explain a decision nobody can
   * act on; one that showed only the second would let an old promotion appear
   * to rest on numbers that were never in front of it.
   */
  private withRequirement(
    state: PromotionStateView,
    live: ClassEvidence | undefined,
  ): PromotionLadderStateView {
    // A class with no evidence entry at all — possible only for a row whose
    // class has left the registry between the two reads. Zeros, not a throw:
    // that row may still be promoted, and a cockpit that failed to render the
    // ladder because one class was retired would hide the promotions that
    // matter most.
    const currentEvidence = live ?? emptyEvidence(state.actionClass);

    const verdict = evaluateLadder(
      state.rung,
      currentEvidence,
      state.eligible,
      // Never the real pause. See `ladder`.
      false,
    );

    return {
      ...state,
      // The registry title, joined server-side, and NULL rather than the raw
      // id when the registry does not know the class — the same rule the
      // approvals queue and the grant list follow. A title that silently
      // equalled its id would make registry drift invisible, and a class that
      // has left the registry while still holding a rung is exactly the drift
      // worth seeing here.
      actionClassTitle: getActionClass(state.actionClass)?.title ?? null,
      currentEvidence,
      requirement:
        verdict.action === 'promote' ? verdict.reason : verdict.detail,
      wouldChange: verdict.action === 'hold' ? null : verdict.action,
    };
  }

  // -------------------------------------------------------------------------
  // Manual demotion (#101)
  // -------------------------------------------------------------------------

  /**
   * A human takes autonomy back from a class, now.
   *
   * ## Why demotion may be manual when promotion may not
   *
   * VISION §7 rung 4 says demotion is "automatic on regression, not a judgment
   * call", and rung 3 says promotion happens on "a demonstrated record". Both
   * sentences point the same way: NARROWING authority is always safe and
   * WIDENING it must be earned. A hand-promotion would be exactly the
   * judgement call the ladder exists to eliminate — it would grant autonomy on
   * somebody's confidence instead of on evidence, and there is no endpoint for
   * it anywhere in this module. A hand-demotion cannot make anything run that
   * was not already running; the worst case is that work queues for a human
   * who did not need to be asked, which is delay rather than damage.
   *
   * The operator has evidence the ladder structurally cannot: a class whose
   * output is bad in ways no approval count captures, or a repository incident
   * that has not yet reached the regression window. Waiting a fortnight for
   * `REGRESSION_WINDOW_DAYS` to notice is not a safety property.
   *
   * ## The durable effect is the grant suspension, not the rung
   *
   * Every active grant for the class is suspended, exactly as an automatic
   * demotion suspends them, and NOTHING re-creates a suspended grant: only a
   * human tapping "always approve this class" can. That is the part that stops
   * unattended execution and it does not expire.
   *
   * The RUNG is weaker, and callers must be told so rather than left to
   * discover it. `evaluateLadder` rule 4 promotes any non-promoted class whose
   * lifetime record still clears the bar, so a class demoted by hand while its
   * numbers are good is re-promoted by the next hourly evaluation — back to
   * `promoted`, with `changeReason: promoted_on_evidence`, as though the
   * operator had never acted. There is no column recording a human hold-down,
   * so this cannot be suppressed here without inventing state; the honest
   * response is to REPORT it, which is what `rungMayBeRestoredByLadder` is
   * for. Re-promotion restores ELIGIBILITY only — the suspended grants stay
   * suspended, so nothing resumes running.
   */
  async demoteManually(
    actionClass: string,
    actorUserId: string,
    note: string | null = null,
    now: Date = new Date(),
  ): Promise<ManualDemotionResult> {
    const existing = await this.prisma.promotionState.findUnique({
      where: { actionClass },
    });

    // Refused rather than treated as a no-op. "Demote" is a claim about a
    // transition, and answering 200 for a class that was already on `measure`
    // would tell an operator they had just taken autonomy away from something
    // that never had it — and, worse, imply its grants were dealt with. To
    // stop a grant on a non-promoted class, revoke the grant.
    if (!existing || existing.rung !== 'promoted') {
      throw new ConflictException({
        code: 'PROMOTION_CLASS_NOT_PROMOTED',
        message:
          `Action class "${actionClass}" is not on the promoted rung ` +
          `(it is on "${existing?.rung ?? 'observe'}"), so there is no ` +
          'autonomy to take back and nothing was changed. Note that a class ' +
          'can hold trust grants without being promoted — grants come from a ' +
          'human tapping "always approve this class", not from the ladder — ' +
          'so if something of this class is running unattended, revoke its ' +
          'grant directly at DELETE /api/trust/grants/{id}.',
        details: {
          reason: 'not-promoted',
          actionClass,
          rung: existing?.rung ?? 'observe',
        },
      });
    }

    const evidence =
      (await this.gatherEvidence(now)).find(
        (item) => item.actionClass === actionClass,
      ) ?? emptyEvidence(actionClass);

    // The actor's id travels in the sentence because `promotion_states` has no
    // actor column. That is a real gap in VISION §5's provenance graph and is
    // named here rather than papered over: prose is not an edge, and the day
    // someone wants "which demotions were human" as a query this will have to
    // become a column.
    const detail =
      `Demoted by hand at ${now.toISOString()} by user ${actorUserId}, ` +
      'not by the ladder. The record was ' +
      `${evidence.approved}/${evidence.sample} approved lifetime ` +
      `(${pct(evidence.rate)}), ${evidence.recentApproved}/${evidence.recentSample} ` +
      `in the last ${REGRESSION_WINDOW_DAYS} days (${pct(evidence.recentRate)}) — ` +
      'which is to say the ladder itself had not concluded anything was ' +
      'wrong.' +
      (note ? ` Reason given: ${note}` : ' No reason was given.');

    await this.persist(
      evidence,
      rungFor(false, evidence),
      'demoted_manually',
      detail,
      now,
      existing,
    );

    const grantsSuspended = await this.suspendGrantsFor(
      actionClass,
      detail,
      now,
    );

    const notified = await this.notifyDemotion(
      evidence,
      'demoted_manually',
      detail,
      grantsSuspended,
      now,
    );

    this.logger.warn(
      `Action class "${actionClass}" demoted manually by user ${actorUserId}; ` +
        `${grantsSuspended} active grant(s) suspended. ${detail}`,
    );

    // Asked of the POST-demotion rung, so it answers the question the operator
    // actually has: given where this class now stands, will the next
    // evaluation put it back? Computed by the policy layer, not by a copy of
    // rule 4 living here.
    const next = evaluateLadder(
      rungFor(false, evidence),
      evidence,
      isAutonomyEligible(actionClass),
      false,
    );

    return {
      state: await this.ladderStateFor(actionClass, now),
      grantsSuspended,
      notified,
      rungMayBeRestoredByLadder: next.action === 'promote',
    };
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  private async persist(
    evidence: ClassEvidence,
    rung: PromotionRung,
    reason: PromotionChangeReason | null,
    detail: string,
    now: Date,
    existing: { demotionCount: number } | undefined,
  ): Promise<void> {
    const demoting = reason !== null && reason.startsWith('demoted');
    const promoting = reason === 'promoted_on_evidence';

    const data = {
      rung,
      changedAt: now,
      changeReason: reason,
      changeDetail: detail,
      // Frozen here and never recomputed. #99 requires promotion and demotion
      // to "state their evidence", and evidence refreshed on read describes a
      // different factory from the one the decision was made in — the same
      // argument ADR-0013 makes for freezing declared effects at raise time.
      evidenceJson: evidence as unknown as Prisma.InputJsonValue,
      ...(promoting ? { promotedAt: now } : {}),
      ...(demoting ? { demotedAt: now } : {}),
    };

    await this.prisma.promotionState.upsert({
      where: { actionClass: evidence.actionClass },
      create: {
        actionClass: evidence.actionClass,
        ...data,
        demotionCount: demoting ? 1 : 0,
      },
      update: {
        ...data,
        // Incremented only on a demotion, so it counts demotions rather than
        // rung changes. A class that promoted, demoted and re-promoted reads
        // `demotionCount: 1`, which is the fact worth knowing.
        ...(demoting
          ? { demotionCount: (existing?.demotionCount ?? 0) + 1 }
          : {}),
      },
    });
  }

  /**
   * Suspend every active grant for a demoted class.
   *
   * Failure to suspend one grant does not stop the others. The alternative —
   * abandoning the loop on the first error — would leave an arbitrary suffix
   * of the grants live for a class the system has just decided may not run
   * unattended, and would do it silently.
   */
  private async suspendGrantsFor(
    actionClass: string,
    detail: string,
    now: Date,
  ): Promise<number> {
    let suspended = 0;

    try {
      const grants = await this.prisma.trustGrant.findMany({
        where: { actionClass, status: 'active' },
        select: { id: true },
      });

      for (const grant of grants) {
        try {
          const ended = await this.trust.suspend(
            grant.id,
            'class_demoted',
            `Action class "${actionClass}" was demoted off the promotion ladder ` +
              `(#99). ${detail}`,
            now,
          );
          if (ended) suspended++;
        } catch (error) {
          this.logger.error(
            `Could not suspend trust grant ${grant.id} after demoting ` +
              `"${actionClass}": ${message(error)}`,
          );
        }
      }
    } catch (error) {
      this.logger.error(
        `Could not read trust grants while demoting "${actionClass}": ${message(error)}`,
      );
    }

    return suspended;
  }

  // -------------------------------------------------------------------------
  // Notification
  // -------------------------------------------------------------------------

  /**
   * Promotion notifies at `normal`; demotion notifies at `high`.
   *
   * The asymmetry is the argument, not an oversight. A promotion says
   * something MAY now run unattended once the operator grants it — nothing has
   * changed in the world yet, and reading it over breakfast loses nothing. A
   * demotion says something that WAS running unattended has been stopped and
   * its grants suspended: work the operator believed was being handled is now
   * queueing for a human, and the sooner they know the shorter the gap. VISION
   * §8's whole batching goal is that `high` means "get up" — spending it on a
   * promotion would make the one that means "get up" indistinguishable from
   * the one that does not.
   */
  private async notifyPromotion(
    evidence: ClassEvidence,
    reason: string,
    anomaly: string | null,
    now: Date,
  ): Promise<boolean> {
    const why =
      reason +
      (anomaly
        ? `\n\nORDER CHECK: ${anomaly}`
        : `\n\nOrder check: consistent with VISION §7's expected promotion order.`);

    return this.deliver({
      priority: 'normal',
      title: `Promoted: ${evidence.actionClass}`,
      body:
        `"${evidence.actionClass}" has earned a demonstrated record and is now eligible ` +
        'to run under a trust grant.',
      why,
      blastRadius:
        'None yet. Promotion makes this class ELIGIBLE for a trust grant; it does not ' +
        'create one, and nothing runs unattended until you tap "Always approve this ' +
        'class" and the grant is scoped to a repository with an expiry and a budget ' +
        'ceiling (VISION §8).',
      ifIgnored:
        'Nothing changes. Approvals for this class keep arriving exactly as they do ' +
        'today, and the promotion stays on record until the class regresses.',
      url: this.deepLink(),
      kind: 'promotion',
      raisedAt: now.toISOString(),
    });
  }

  private async notifyDemotion(
    evidence: ClassEvidence,
    reason: PromotionChangeReason,
    detail: string,
    grantsSuspended: number,
    now: Date,
  ): Promise<boolean> {
    return this.deliver({
      priority: 'high',
      title: `Demoted: ${evidence.actionClass}`,
      body:
        `"${evidence.actionClass}" no longer meets the bar for unattended execution ` +
        `and has been demoted (${reason}).`,
      why: detail,
      blastRadius:
        grantsSuspended > 0
          ? `${grantsSuspended} active trust grant(s) for this class were suspended. ` +
            'Actions of this class that were running unattended now stop at the approval ' +
            'gate and wait for you.'
          : 'No trust grants were active for this class, so nothing that was running ' +
            'unattended has stopped. The class is simply no longer eligible for one.',
      ifIgnored:
        'Nothing gets worse — this is the safe direction. Work of this class queues for ' +
        'your approval instead of proceeding on its own, so the cost of ignoring this is ' +
        'delay, not damage. The class re-promotes on its own once its record recovers.',
      url: this.deepLink(),
      kind: 'demotion',
      raisedAt: now.toISOString(),
    });
  }

  /**
   * Push first, webhook second — the same seam and the same order the daily
   * brief and `EscalationDispatcher` use, so a deployment configured for one is
   * configured for all three.
   *
   * No escalation row and no receipt. Receipts exist to prove somebody was TOLD
   * about a stall; a rung change is not a stall, and minting an `Escalation`
   * to ride the delivery path would inflate the escalation lifecycle and the
   * latency percentiles computed over it — success metric 1 would start
   * counting promotions. `DailyBriefService` makes the identical argument.
   *
   * Delivery failing does not undo the rung change. The row is written first
   * and says what happened, so a promotion nobody was told about is still
   * visible where an operator can find it — the distinction #58 insists on
   * between "we tried to tell you" and "we never noticed".
   */
  private async deliver(payload: NotificationPayload): Promise<boolean> {
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
      this.logger.warn(`Promotion ladder push failed: ${message(error)}`);
    }

    if (!anyAccepted && this.fallback.isConfigured()) {
      try {
        const outcome = await this.fallback.send(
          {
            id: 'promotion-ladder',
            endpoint: '',
            keys: { p256dh: '', auth: '' },
          },
          payload,
        );
        anyAccepted = anyAccepted || outcome.accepted;
      } catch (error) {
        this.logger.warn(`Promotion ladder webhook failed: ${message(error)}`);
      }
    }

    if (!anyAccepted) {
      this.logger.warn(
        `Nobody was told about "${payload.title}": no transport accepted it. The rung ` +
          'change is still recorded on promotion_states.',
      );
    }

    return anyAccepted;
  }

  /**
   * Where the notification taps through to.
   *
   * The cockpit root, not `/trust`: #101 owns the trust and promotion screens
   * and they do not exist yet, and a "one tap from a phone" that lands on a
   * 404 is worse than one that lands somewhere real. Point this at the
   * promotion view when #101 ships.
   */
  private deepLink(): string {
    return `${this.config.get<string>('appUrl') ?? ''}/`;
  }
}

// ---------------------------------------------------------------------------
// Row -> view
// ---------------------------------------------------------------------------

/** The columns the view is built from. Structural, so a test can supply one. */
export interface PromotionStateRow {
  actionClass: string;
  rung: PromotionRung;
  changedAt: Date;
  changeReason: PromotionChangeReason | null;
  changeDetail: string | null;
  evidenceJson: unknown;
  promotedAt: Date | null;
  demotedAt: Date | null;
  demotionCount: number;
}

function toView(row: PromotionStateRow): PromotionStateView {
  return {
    actionClass: row.actionClass,
    rung: row.rung,
    eligible: isAutonomyEligible(row.actionClass),
    changedAt: row.changedAt.toISOString(),
    changeReason: row.changeReason,
    changeDetail: row.changeDetail,
    // Cast rather than re-validated. It is our own frozen write, and a
    // validator here would be a second definition of `ClassEvidence` that
    // could reject a historical row written before a field was added — which
    // would lose the evidence the row exists to preserve.
    evidence: (row.evidenceJson as ClassEvidence | null) ?? null,
    promotedAt: row.promotedAt?.toISOString() ?? null,
    demotedAt: row.demotedAt?.toISOString() ?? null,
    demotionCount: row.demotionCount,
  };
}

/** A class the ladder has never written a row for. Rung 1, no evidence. */
function defaultView(actionClass: string): PromotionStateView {
  return {
    actionClass,
    rung: 'observe',
    eligible: isAutonomyEligible(actionClass),
    // The epoch, deliberately, rather than "now". "Changed just now" would be
    // a claim about an event that never happened.
    changedAt: new Date(0).toISOString(),
    changeReason: null,
    changeDetail:
      'The promotion ladder has not evaluated this class yet. No evidence, no rung ' +
      'change, nothing promoted.',
    evidence: null,
    promotedAt: null,
    demotedAt: null,
    demotionCount: 0,
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Re-exported so #101 and the specs can render the thresholds a hold detail
 * refers to without importing two modules to describe one decision.
 */
export {
  DEMOTION_MIN_SAMPLE,
  DEMOTION_RATE,
  MIN_SAMPLE,
  PROMOTION_RATE,
  REGRESSION_WINDOW_DAYS,
  pct,
};
