import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { TrustGrantEndReason, TrustGrantStatus } from '@prisma/client';

import type { DecimalLike } from '../common/decimal';
import { PrismaService } from '../prisma/prisma.service';
import {
  isActionClass,
  isAutonomyEligible,
} from '../supervisor/action-classes';
import { evaluateAutoRevoke } from './auto-revoke';
import {
  defaultGrantAttributes,
  NEAR_BUDGET_HEADROOM_FRACTION,
  NEAR_EXPIRY_WINDOW_MS,
} from './defaults';
import { narrowerOf } from './renewal';
import { TrustGrantNotRenewableException } from './trust-grant-not-renewable.exception';
import type {
  AuthorizationResult,
  CreateTrustGrantInput,
  ListTrustGrantsQuery,
  RecordUsageResult,
  RenewTrustGrantResult,
  TrustGrantView,
  UsageRecord,
} from './trust-grant.types';

/**
 * Trust grants (#96, epic #22) — the mechanism behind VISION §8's
 * "Always approve this class".
 *
 * > "Don't ask me anymore" never produces a permanent global grant. Every
 * > grant carries four attributes, attached automatically: scope, expiry,
 * > budget ceiling, auto-revoke.
 *
 * ## What this class is, and is not
 *
 * It is the AUTHORITY on whether something may run unattended, and the
 * bookkeeping that keeps that answer honest. It is not an executor: nothing
 * here dispatches, writes to GitHub, or reaches a runner, and `TrustModule`
 * imports only `PrismaModule` so that stays true by the shape of the module
 * graph rather than by anyone's restraint — the same argument
 * `SupervisorModule` makes about itself.
 *
 * The never-trustable list in VISION §8 is enforced at EXECUTION time by #95,
 * separately and unconditionally. What is enforced here is narrower and
 * complementary: a class the registry marks `autonomyEligible: false` can
 * never receive a grant in the first place. Two independent gates, because a
 * safety property that exists in exactly one place is one refactor from
 * existing in none.
 */
@Injectable()
export class TrustGrantService {
  private readonly logger = new Logger(TrustGrantService.name);

  constructor(private readonly prisma: PrismaService) {}

  // -------------------------------------------------------------------------
  // Creation
  // -------------------------------------------------------------------------

  /**
   * Write a grant, having checked that it is one the system may hold.
   *
   * Every rejection below is a `BadRequestException` with a sentence naming
   * what was wrong, not a boolean — the caller is a human tapping a button,
   * and "invalid grant" is not something anyone can act on.
   */
  async create(
    input: CreateTrustGrantInput,
    now: Date = new Date(),
  ): Promise<TrustGrantView> {
    // Validated against the registry at the boundary, per ADR-0011. An
    // unknown class here is worse than an unknown class in the decision log:
    // there it opens a stray measurement bin, here it would create an
    // authorization for a scope nothing can ever match, which reads as
    // "trust granted" on every screen that lists it.
    if (!isActionClass(input.actionClass)) {
      throw new BadRequestException(
        `Unknown action class "${input.actionClass}". The taxonomy is ` +
          'apps/api/src/supervisor/action-classes.ts (ADR-0011).',
      );
    }

    // VISION §7 ranks quarantine decisions last and annotates them "probably
    // never"; VISION §8 puts clearing quarantine on the never-trustable list
    // outright. `autonomyEligible: false` in the registry carries that, and
    // this is where it is enforced FOR GRANTS. #95 enforces the never-trustable
    // list again at execution time — deliberately not the same check, because
    // a grant that cannot be created and an action that cannot be executed
    // fail at different moments and must both hold.
    if (!isAutonomyEligible(input.actionClass)) {
      throw new BadRequestException(
        `Action class "${input.actionClass}" is not autonomy-eligible and can ` +
          'never receive a trust grant (VISION §7, §8). Proposals of this ' +
          'class always require a human decision.',
      );
    }

    // Expiry is not decoration. A grant that is already expired at creation
    // would authorize nothing and still appear in every list as trust that
    // was granted, which is the most misleading row this table can hold.
    if (input.expiresAt.getTime() <= now.getTime()) {
      throw new BadRequestException(
        `A trust grant must expire in the future: expiresAt ` +
          `${input.expiresAt.toISOString()} is not after ${now.toISOString()}.`,
      );
    }

    // A grant with no ceiling is not a narrower grant, it is a blank check.
    // Non-finite is refused with the same sentence: `NaN > ceiling` is false,
    // so a NaN ceiling would silently authorize everything forever.
    if (
      !Number.isFinite(input.budgetCeilingUsd) ||
      input.budgetCeilingUsd <= 0
    ) {
      throw new BadRequestException(
        `budgetCeilingUsd must be a finite number greater than 0, got ` +
          `${String(input.budgetCeilingUsd)}. VISION §8: "the grant dies at a ` +
          'cumulative spend" — a grant with no ceiling never dies.',
      );
    }

    if (
      !Number.isFinite(input.maxFailureRate) ||
      input.maxFailureRate < 0 ||
      input.maxFailureRate > 1
    ) {
      throw new BadRequestException(
        `maxFailureRate must be a finite number in [0, 1], got ` +
          `${String(input.maxFailureRate)}.`,
      );
    }

    if (
      !Number.isFinite(input.maxCostPerActionUsd) ||
      input.maxCostPerActionUsd <= 0
    ) {
      throw new BadRequestException(
        `maxCostPerActionUsd must be a finite number greater than 0, got ` +
          `${String(input.maxCostPerActionUsd)}.`,
      );
    }

    // Not in the brief's list, checked anyway: a negative or fractional
    // sample-size floor would make the two rate rules fire on the first
    // action, silently undoing the guard the column exists to provide.
    if (input.minActionsBeforeAutoRevoke !== undefined) {
      const min = input.minActionsBeforeAutoRevoke;
      if (!Number.isInteger(min) || min < 1) {
        throw new BadRequestException(
          `minActionsBeforeAutoRevoke must be an integer of at least 1, got ` +
            `${String(min)}.`,
        );
      }
    }

    // Checked before the insert rather than left to the foreign key, so the
    // caller gets a 404 naming the repository instead of a 500 naming a
    // constraint. The scope half of VISION §8 is meaningless if the
    // repository half does not resolve.
    const repository = await this.prisma.repository.findUnique({
      where: { id: input.repositoryId },
      select: { id: true },
    });
    if (!repository) {
      throw new NotFoundException(
        `No repository with id ${input.repositoryId}. A trust grant is scoped ` +
          'to an action class in a repository — never to the agent as a whole.',
      );
    }

    const row = await this.prisma.trustGrant.create({
      data: {
        actionClass: input.actionClass,
        repositoryId: input.repositoryId,
        grantedById: input.grantedById,
        expiresAt: input.expiresAt,
        budgetCeilingUsd: input.budgetCeilingUsd,
        maxFailureRate: input.maxFailureRate,
        maxCostPerActionUsd: input.maxCostPerActionUsd,
        ...(input.minActionsBeforeAutoRevoke === undefined
          ? {}
          : { minActionsBeforeAutoRevoke: input.minActionsBeforeAutoRevoke }),
        grantedFromProposalId: input.grantedFromProposalId ?? null,
        renewedFromId: input.renewedFromId ?? null,
        note: input.note ?? null,
      },
    });

    this.logger.log(
      `Trust grant ${row.id} created: ${input.actionClass} in repository ` +
        `${input.repositoryId}, expires ${input.expiresAt.toISOString()}, ` +
        `ceiling $${input.budgetCeilingUsd}.`,
    );

    return toTrustGrantView(row, now);
  }

  // -------------------------------------------------------------------------
  // Authorization
  // -------------------------------------------------------------------------

  /**
   * May this action run without asking? (#96's central question.)
   *
   * ## The timestamp is the authority, not the status column
   *
   * The query below filters on `expiresAt > now` as a WHERE clause. It does
   * NOT rely on `status` to tell it whether the grant has expired, because
   * `status` is only as fresh as the last run of `sweepExpired` — and a sweep
   * that has not run yet, or that failed, would leave a lapsed grant sitting
   * at `status: 'active'` and authorizing work. #96's third acceptance
   * criterion is that an expired grant stops authorizing IMMEDIATELY, with no
   * grace period, and a grace period you get by accident is still a grace
   * period.
   *
   * So: the `status` column is for the audit trail and the UI. The timestamp
   * is the authority.
   *
   * `status: 'active'` is still in the WHERE, for the other two end states.
   * That is not the same trust: `revoked` and `suspended` are written at the
   * instant the decision is made, by the human or by `recordUsage`, so the
   * column is exactly as fresh as the fact. Only expiry is a fact that becomes
   * true while nobody is writing to the row, which is why only expiry needs
   * the timestamp check.
   */
  async authorize(
    actionClass: string,
    repositoryId: string,
    projectedCostUsd: number,
    now: Date = new Date(),
  ): Promise<AuthorizationResult> {
    // First, and before any query: a class the registry rules out can never be
    // authorized, whatever the table says. An unknown class lands here too —
    // `isAutonomyEligible` returns false for one, so a typo in a class name is
    // a refusal rather than a promotion path.
    if (!isAutonomyEligible(actionClass)) {
      return {
        authorized: false,
        reason: 'class-ineligible',
        detail:
          `Action class "${actionClass}" is not autonomy-eligible ` +
          '(VISION §7, §8), so no grant can authorize it. 0 grants were ' +
          'considered.',
      };
    }

    // An unknown cost is NOT a zero cost. `NaN > ceiling` is false, so letting
    // a non-finite figure through would make the ceiling check pass for every
    // action whose cost nobody could compute — the one way this refusal could
    // fail in the flattering direction. Mirrors #65's ceiling behaviour and
    // `spend-ledger.service.ts`, which treats a NaN conversion as unreported
    // rather than as a number. Refused before the query, because no grant
    // could rescue it.
    if (!Number.isFinite(projectedCostUsd) || projectedCostUsd < 0) {
      return {
        authorized: false,
        reason: 'budget-exhausted',
        detail:
          `Projected cost ${String(projectedCostUsd)} is not a usable figure ` +
          '(must be finite and at least 0). An unknown cost is not a zero ' +
          'cost, so it cannot be checked against a budget ceiling.',
      };
    }

    const candidates = await this.prisma.trustGrant.findMany({
      where: {
        actionClass,
        repositoryId,
        status: 'active',
        expiresAt: { gt: now },
      },
    });

    if (candidates.length === 0) {
      return this.diagnoseNoGrant(actionClass, repositoryId, now);
    }

    // Overlapping grants are LEGITIMATE — a renewal issued before the old one
    // lapsed is exactly this shape, and the schema deliberately carries no
    // unique constraint that would forbid it. So the choice among them has to
    // be deterministic, or two identical requests a millisecond apart would
    // charge different grants and the spend would be smeared across rows
    // nobody can reconcile.
    //
    // Most remaining headroom first, so the grant with room to work is the one
    // used and the nearly-exhausted one is left to expire quietly. Ties broken
    // by the later expiry (the grant that will still be there tomorrow), then
    // by id, so the order is total.
    const ranked = candidates
      .map((row) => {
        const ceiling = decimalToNumber(row.budgetCeilingUsd);
        const spent = decimalToNumber(row.spentUsd);
        const headroom = ceiling - spent;
        return {
          row,
          ceiling,
          spent,
          // A row whose Decimal columns could not be read sorts LAST rather
          // than unpredictably: NaN in a comparator makes a sort order
          // arbitrary, and arbitrary is the one thing this ranking may not be.
          sortKey: Number.isFinite(headroom) ? headroom : -Infinity,
        };
      })
      .sort(
        (a, b) =>
          b.sortKey - a.sortKey ||
          b.row.expiresAt.getTime() - a.row.expiresAt.getTime() ||
          a.row.id.localeCompare(b.row.id),
      );

    const best = ranked[0]!;

    // Fails closed on an unreadable figure, for the reason above.
    if (!Number.isFinite(best.ceiling) || !Number.isFinite(best.spent)) {
      return {
        authorized: false,
        reason: 'budget-exhausted',
        detail:
          `Grant ${best.row.id} has budget figures that could not be read as ` +
          'numbers, so its ceiling cannot be checked. Refusing rather than ' +
          'assuming headroom.',
      };
    }

    // `>`, not `>=`: a $25 ceiling authorizes spending UP TO $25. The same
    // boundary `budget-overrun.ts` uses for a work order, so the two do not
    // disagree by a cent about what a ceiling means.
    const projectedTotal = best.spent + projectedCostUsd;
    if (projectedTotal > best.ceiling) {
      return {
        authorized: false,
        reason: 'budget-exhausted',
        detail:
          `Grant ${best.row.id} has spent $${best.spent.toFixed(2)} of its ` +
          `$${best.ceiling.toFixed(2)} ceiling; the projected ` +
          `$${projectedCostUsd.toFixed(2)} would take it to ` +
          `$${projectedTotal.toFixed(2)}, over the ceiling by ` +
          `$${(projectedTotal - best.ceiling).toFixed(2)}.`,
      };
    }

    return { authorized: true, grant: toTrustGrantView(best.row, now) };
  }

  /**
   * Why nothing authorized this, in the operator's terms.
   *
   * Only reached when the authorizing query found nothing, and it exists
   * solely so `no-grant` and `expired` stay distinguishable — see
   * `AuthorizationDenial`. Collapsing them would make VISION §8's "silence
   * revokes" indistinguishable from "you never granted this", which is the
   * difference between a mechanism working and a mechanism looking broken.
   */
  private async diagnoseNoGrant(
    actionClass: string,
    repositoryId: string,
    now: Date,
  ): Promise<AuthorizationResult> {
    const previous = await this.prisma.trustGrant.findMany({
      where: { actionClass, repositoryId },
      orderBy: [{ expiresAt: 'desc' }, { id: 'desc' }],
      take: 1,
    });

    const row = previous[0];
    if (!row) {
      return {
        authorized: false,
        reason: 'no-grant',
        detail:
          `No trust grant has ever been issued for "${actionClass}" in ` +
          `repository ${repositoryId} (0 grants found). This action needs a ` +
          'human decision.',
      };
    }

    // An `active` row whose expiry has passed is EXPIRED, whatever the column
    // says — the sweep simply has not caught up. Reporting its stale status
    // would be the same mistake `authorize` refuses to make above.
    const lapsed = row.expiresAt.getTime() <= now.getTime();
    const effective: TrustGrantStatus =
      row.status === 'active' && lapsed ? 'expired' : row.status;

    if (effective === 'expired') {
      const agoMs = now.getTime() - row.expiresAt.getTime();
      return {
        authorized: false,
        reason: 'expired',
        detail:
          `Trust grant ${row.id} for "${actionClass}" expired ` +
          `${describeDuration(agoMs)} ago at ` +
          `${row.expiresAt.toISOString()} and was not renewed. VISION §8: ` +
          'renewal is one tap; silence revokes.',
      };
    }

    if (effective === 'revoked') {
      return {
        authorized: false,
        reason: 'revoked',
        detail:
          `Trust grant ${row.id} for "${actionClass}" was revoked by a human ` +
          `at ${row.endedAt?.toISOString() ?? 'an unrecorded time'}. ` +
          `${row.endDetail ?? 'No detail was recorded.'} Nothing reactivates ` +
          'a revoked grant; a new grant is required.',
      };
    }

    return {
      authorized: false,
      reason: 'suspended',
      detail:
        `Trust grant ${row.id} for "${actionClass}" was suspended at ` +
        `${row.endedAt?.toISOString() ?? 'an unrecorded time'} ` +
        `(${row.endReason ?? 'reason not recorded'}). ` +
        `${row.endDetail ?? 'No detail was recorded.'}`,
    };
  }

  // -------------------------------------------------------------------------
  // Usage
  // -------------------------------------------------------------------------

  /**
   * Charge one authorized action against a grant, then re-check auto-revoke.
   *
   * ## One atomic update, never read-modify-write
   *
   * The three counters move with Prisma's `increment`, which becomes
   * `SET spent_usd = spent_usd + $1` in the database. Reading the row,
   * adding in JavaScript and writing it back would look identical in a test
   * and lose a charge whenever two auto-executions land in the same
   * millisecond — and the charge that gets lost is the one that would have
   * crossed the ceiling, because that is the busy case. A budget ceiling that
   * leaks under concurrency is not a ceiling.
   *
   * The auto-revoke evaluation is a SECOND step on purpose. It reads the row
   * as the increment left it, so the decision is made on the post-charge
   * totals rather than on what the caller believed they would be.
   */
  async recordUsage(
    grantId: string,
    usage: UsageRecord,
    now: Date = new Date(),
  ): Promise<RecordUsageResult> {
    // Refused rather than clamped. A NaN charge would be written into a
    // Decimal column and poison every subsequent ceiling comparison; a
    // negative charge would REFUND the grant, which is a way to make a
    // budget ceiling unreachable.
    if (!Number.isFinite(usage.costUsd) || usage.costUsd < 0) {
      throw new BadRequestException(
        `costUsd must be a finite number of at least 0, got ` +
          `${String(usage.costUsd)}.`,
      );
    }

    let row;
    try {
      row = await this.prisma.trustGrant.update({
        where: { id: grantId },
        data: {
          spentUsd: { increment: usage.costUsd },
          actionsAuthorized: { increment: 1 },
          // Always an increment, of 0 or 1, so the shape of this call does not
          // depend on the outcome of the action.
          actionsFailed: { increment: usage.failed ? 1 : 0 },
        },
      });
    } catch (error) {
      if ((error as { code?: string }).code === 'P2025') {
        throw new NotFoundException(`No trust grant with id ${grantId}`);
      }
      throw error;
    }

    const verdict = evaluateAutoRevoke(
      {
        spentUsd: decimalToNumber(row.spentUsd),
        budgetCeilingUsd: decimalToNumber(row.budgetCeilingUsd),
        actionsAuthorized: row.actionsAuthorized,
        actionsFailed: row.actionsFailed,
        maxFailureRate: decimalToNumber(row.maxFailureRate),
        maxCostPerActionUsd: decimalToNumber(row.maxCostPerActionUsd),
        minActionsBeforeAutoRevoke: row.minActionsBeforeAutoRevoke,
        expiresAt: row.expiresAt,
      },
      now,
    );

    if (!verdict) {
      return {
        grant: toTrustGrantView(row, now),
        suspended: false,
        reason: null,
        detail: null,
      };
    }

    const suspended = await this.suspend(
      grantId,
      verdict.reason,
      verdict.detail,
      now,
    );

    if (suspended) {
      // Warn, not log: this is the moment a grant stopped authorizing work
      // that was running unattended, and it belongs in whatever an operator
      // reads when they ask why the factory went quiet.
      this.logger.warn(`Trust grant ${grantId} suspended. ${verdict.detail}`);
    }

    return {
      grant: toTrustGrantView(
        {
          ...row,
          ...(suspended ? endedFields(verdict, now, 'suspended') : {}),
        },
        now,
      ),
      suspended,
      reason: verdict.reason,
      detail: verdict.detail,
    };
  }

  // -------------------------------------------------------------------------
  // Renewal
  // -------------------------------------------------------------------------

  /**
   * One tap: end this grant and issue its successor (#115, VISION §8).
   *
   * > Expiry — days or session. Renewal is one tap; silence revokes.
   *
   * #96 delivered the second clause structurally. Without this method the
   * first never arrives, and expiry becomes pure friction: every grant dies on
   * schedule, the operator re-approves from scratch each time, and the
   * pressure VISION §8 opens by warning about — "operators grant blanket trust
   * out of friction, not conviction" — comes back through the only door left
   * open, which is somebody quietly editing `DEFAULT_GRANT_EXPIRY_DAYS`
   * upwards.
   *
   * ## Renewal creates NO GRACE PERIOD
   *
   * A grant whose `expiresAt` has passed is refused, at one millisecond past.
   * This is the single most important line in the method and the easiest one
   * to argue away — the operator is right there, they clearly want the grant,
   * the prompt only went out yesterday. Allowing it would make expiry
   * negotiable: "silence revokes" would become "silence revokes unless
   * somebody notices in time", and every lapsed grant could be resurrected
   * with a tap by whoever is annoyed that the factory stopped. At that point
   * expiry has stopped being a mechanism.
   *
   * A lapsed grant is not un-renewable in the sense of un-restorable. It is a
   * NEW DECISION, made through `create` with the attributes recorded as
   * somebody's choice, which is exactly the accountability the expiry existed
   * to force.
   *
   * ## The successor's terms
   *
   * Same scope, always: `actionClass` and `repositoryId` are read off the OLD
   * ROW and there is no code path here that takes either from a caller. #115:
   * "No renewal path can extend scope." A `renew` that accepted attributes
   * would be `create` with a nicer name and a worse audit trail.
   *
   * Attributes come fresh from `defaultGrantAttributes(now)`, narrowed by the
   * old grant's own — see `narrowerOf` for why copying forward would launder a
   * one-time generous decision into a permanent one.
   *
   * The budget counters start at ZERO, deliberately. Carrying `spentUsd`
   * forward would mean a grant that had done its job could never be renewed
   * usefully, which just moves the friction; and a renewal IS a fresh
   * decision, taken by a named human who has just been shown what the previous
   * period cost. The record is not lost — it is on the old row, and the chain
   * walks to it through `renewedFromId`.
   *
   * `grantedById` is the RENEWING actor, not the original granter. The person
   * tapping renew is the one taking responsibility for the next fourteen days,
   * and attributing it to whoever granted it first would make the chain read
   * as one person's ongoing decision when it is several people's successive
   * ones.
   *
   * `grantedFromProposalId` is NOT carried forward. This grant was created by
   * a renewal, not by that proposal's approval; the proposal is still reachable
   * by walking `renewedFromId` back to the grant it did create, and copying it
   * would make every link in the chain claim to be the thing the proposal
   * produced.
   *
   * ## One transaction
   *
   * The successor is written first and the old grant is then ended with
   * `updateMany ... where status: 'active'`. If that update matches nothing —
   * a human revoked it, or a second renewal won — the whole transaction rolls
   * back and NOTHING was created. The alternative ordering (end first, then
   * create) has a window in which the old grant is dead and the new one does
   * not exist, and a crash in that window leaves the scope silently
   * unauthorized with no row saying why.
   */
  async renew(
    grantId: string,
    actorUserId: string,
    note: string | null = null,
    now: Date = new Date(),
  ): Promise<RenewTrustGrantResult> {
    const result = await this.prisma.$transaction(async (tx) => {
      const old = await tx.trustGrant.findUnique({ where: { id: grantId } });
      if (!old) {
        throw new NotFoundException(`No trust grant with id ${grantId}`);
      }

      // Checked FIRST, before the lifecycle checks, because it is the one
      // refusal that is not about this grant at all. The registry may have
      // changed since the grant was written — #99 demotes classes, and VISION
      // §8's never-trustable list can grow — and a class that may no longer
      // receive a grant must not receive one through a path named "renew".
      // `TrustGrantService.create` enforces the same rule at the same strength
      // one method up; two gates, because a safety property that exists in
      // exactly one place is one refactor from existing in none.
      if (!isAutonomyEligible(old.actionClass)) {
        throw new TrustGrantNotRenewableException(
          'class-ineligible',
          `Trust grant ${old.id} cannot be renewed: action class ` +
            `"${old.actionClass}" is no longer autonomy-eligible (VISION §7, ` +
            '§8), so no grant may authorize it. This grant will stop ' +
            `authorizing at ${old.expiresAt.toISOString()} and nothing will ` +
            'replace it. Proposals of this class now require a human decision ' +
            'every time.',
          summarise(old),
        );
      }

      // The timestamp before the column, exactly as `authorize` does it. A
      // still-`active` row whose expiry has passed is EXPIRED — the sweep has
      // simply not reached it — and renewing it because a bookkeeping job is
      // late would be a grace period obtained by accident, which is still a
      // grace period.
      if (old.status === 'active' && old.expiresAt.getTime() <= now.getTime()) {
        throw new TrustGrantNotRenewableException(
          'expired',
          `Trust grant ${old.id} expired at ${old.expiresAt.toISOString()}, ` +
            `${describeDuration(now.getTime() - old.expiresAt.getTime())} ` +
            'ago, and cannot be renewed. VISION §8: renewal is one tap; ' +
            'silence revokes — and the silence already took effect. Renewal ' +
            'creates no grace period, deliberately: a lapsed grant that could ' +
            'be revived by whoever noticed first would make expiry advisory. ' +
            'Create a new grant instead, which records what you chose now ' +
            'rather than re-applying what somebody chose a fortnight ago.',
          summarise(old),
        );
      }

      if (old.status !== 'active') {
        throw notRenewableForStatus(old, now);
      }

      const attributes = narrowerOf(
        {
          createdAt: old.createdAt,
          expiresAt: old.expiresAt,
          budgetCeilingUsd: decimalToNumber(old.budgetCeilingUsd),
          maxFailureRate: decimalToNumber(old.maxFailureRate),
          maxCostPerActionUsd: decimalToNumber(old.maxCostPerActionUsd),
          minActionsBeforeAutoRevoke: old.minActionsBeforeAutoRevoke,
        },
        defaultGrantAttributes(now),
        now,
      );

      const created = await tx.trustGrant.create({
        data: {
          // Scope, off the old row. There is no input to take it from, and
          // that absence is the enforcement of "no renewal path can extend
          // scope" — a `where` clause could be relaxed, a missing parameter
          // cannot be.
          actionClass: old.actionClass,
          repositoryId: old.repositoryId,
          grantedById: actorUserId,
          expiresAt: attributes.expiresAt,
          budgetCeilingUsd: attributes.budgetCeilingUsd,
          maxFailureRate: attributes.maxFailureRate,
          maxCostPerActionUsd: attributes.maxCostPerActionUsd,
          minActionsBeforeAutoRevoke: attributes.minActionsBeforeAutoRevoke,
          renewedFromId: old.id,
          note,
        },
      });

      const endDetail =
        `Superseded by renewal grant ${created.id}, issued at ` +
        `${now.toISOString()} and expiring ` +
        `${created.expiresAt.toISOString()}. This grant authorized ` +
        `${old.actionsAuthorized} action(s) and spent ` +
        `$${decimalToNumber(old.spentUsd).toFixed(2)} of its ` +
        `$${decimalToNumber(old.budgetCeilingUsd).toFixed(2)} ceiling. The ` +
        "successor's attributes were taken fresh from the defaults and " +
        "narrowed by this grant's own, never widened (#115).";

      const ended = await tx.trustGrant.updateMany({
        // `status: 'active'` again, not just the id. Between the read above
        // and this write a human may have revoked the grant, or a second
        // renewal may have won the race. Either way this transaction must not
        // proceed — and because the successor is created BEFORE this line, a
        // zero count rolls the whole thing back and leaves no orphan.
        where: { id: old.id, status: 'active' },
        data: {
          // `revoked`, because a human ended it and the end is terminal —
          // the two things `TrustGrantStatus.revoked` means. There is no
          // `superseded` status and adding one would be a schema change for a
          // distinction `endReason` already carries exactly.
          status: 'revoked',
          endedAt: now,
          endReason: 'superseded_by_renewal',
          endDetail,
          // The renewing human. #96's column comment anticipated an AUTOMATIC
          // supersession with nobody deciding; #115's renewal is a person
          // tapping a button under `trust:grant`, so there is a who, and a
          // `revoked` row with no actor would be the inconsistency instead.
          // `endReason` keeps it distinguishable from `manual_revocation`.
          revokedById: actorUserId,
        },
      });

      if (ended.count === 0) {
        throw new TrustGrantNotRenewableException(
          'revoked',
          `Trust grant ${old.id} stopped being active while it was being ` +
            'renewed — a revocation or another renewal landed first. Nothing ' +
            'was created: the successor was rolled back with this ' +
            'transaction. Re-read the grant to see what happened to it.',
          summarise(old),
        );
      }

      return {
        renewed: toTrustGrantView(created, now),
        ended: toTrustGrantView(
          {
            ...old,
            status: 'revoked' as TrustGrantStatus,
            endedAt: now,
            endReason: 'superseded_by_renewal' as TrustGrantEndReason,
            endDetail,
            revokedById: actorUserId,
          },
          now,
        ),
      };
    });

    this.logger.log(
      `Trust grant ${grantId} renewed by user ${actorUserId} as ` +
        `${result.renewed.id}: ${result.renewed.actionClass} in repository ` +
        `${result.renewed.repositoryId}, expires ` +
        `${result.renewed.expiresAt}, ceiling ` +
        `$${result.renewed.budgetCeilingUsd}.`,
    );

    return result;
  }

  /**
   * Claim the right to send this grant's renewal prompt. Once, ever.
   *
   * Returns whether THIS call won. A conditional `updateMany` rather than a
   * read-then-write, so two workers — or the same hourly cron overlapping
   * itself after a slow run — produce one notification rather than two. The
   * read-then-write version passes every test and duplicates in production,
   * which is the shape of bug this whole codebase writes `updateMany` guards
   * to avoid.
   *
   * The claim is taken BEFORE the send, not after. That trade is deliberate
   * and it is the less obvious direction: claiming first means a send that
   * fails outright burns the grant's one prompt. Claiming after would mean an
   * hourly cron re-notifying about the same grant for the whole 48-hour
   * window, which is up to 48 identical interruptions — precisely what VISION
   * §8 is trying to remove, and the fastest way to teach an operator to swipe
   * trust notifications away without reading them. A missed prompt still has a
   * backstop: the grant appears in the daily digest's `expiring-with-budget-
   * left` anomaly, and the default outcome of never being prompted is that the
   * grant lapses, which is the safe direction by construction.
   *
   * `status: 'active'` is in the WHERE because a grant that ended between the
   * `expiringSoon` read and this write should not be prompted about.
   */
  async claimRenewalPrompt(
    grantId: string,
    now: Date = new Date(),
  ): Promise<boolean> {
    const result = await this.prisma.trustGrant.updateMany({
      where: { id: grantId, status: 'active', renewalPromptedAt: null },
      data: { renewalPromptedAt: now },
    });

    return result.count > 0;
  }

  // -------------------------------------------------------------------------
  // Ending a grant
  // -------------------------------------------------------------------------

  /**
   * The SYSTEM ends a grant, on evidence.
   *
   * `updateMany` filtered on `status: 'active'` rather than `update` by id, so
   * this is a NO-OP and not an error on a grant that has already ended. A
   * sweep and a human revoking the same grant in the same second is an
   * ordinary race, not a fault, and whichever loses should return quietly
   * rather than raise an exception that some caller then has to decide to
   * ignore. Returns whether this call was the one that ended it.
   *
   * Reversible by a human who disagrees with the evidence — that is what
   * separates `suspended` from `revoked` in the schema.
   */
  async suspend(
    grantId: string,
    reason: TrustGrantEndReason,
    detail: string,
    now: Date = new Date(),
  ): Promise<boolean> {
    const result = await this.prisma.trustGrant.updateMany({
      where: { id: grantId, status: 'active' },
      data: {
        status: 'suspended',
        endedAt: now,
        endReason: reason,
        endDetail: detail,
      },
    });

    return result.count > 0;
  }

  /**
   * A HUMAN ends a grant, immediately.
   *
   * Terminal: nothing reactivates a revoked grant, and an operator who wants
   * trust back issues a new one. That asymmetry with `suspend` is the point —
   * a suspension is the system's opinion on evidence, a revocation is a
   * decision, and a decision that the system could quietly undo is not one.
   *
   * Same `updateMany` no-op behaviour as `suspend`, for the same race.
   *
   * The revoking actor is recorded in `revokedById`, not in `endDetail`
   * prose: a provenance edge that only exists in a sentence is a hole in the
   * graph VISION §5 argues is undetectable after the fact. `endDetail` still
   * carries the timestamp and any note, but not the actor, so the two
   * cannot drift apart on who did it.
   */
  async revoke(
    grantId: string,
    actorUserId: string,
    note: string | null = null,
    now: Date = new Date(),
  ): Promise<boolean> {
    const detail =
      `Revoked at ${now.toISOString()}.` + (note ? ` ${note}` : '');

    const result = await this.prisma.trustGrant.updateMany({
      where: { id: grantId, status: 'active' },
      data: {
        status: 'revoked',
        endedAt: now,
        endReason: 'manual_revocation',
        endDetail: detail,
        revokedById: actorUserId,
      },
    });

    if (result.count > 0) {
      this.logger.log(
        `Trust grant ${grantId} revoked by user ${actorUserId}. ${detail}`,
      );
    }

    return result.count > 0;
  }

  /**
   * Mark lapsed grants as expired. BOOKKEEPING ONLY.
   *
   * This sweep enforces nothing. `authorize` already refuses a grant past its
   * `expiresAt` on the timestamp, with no grace period and without consulting
   * `status` — so a sweep that is late, or that never runs, cannot let an
   * expired grant authorize anything. What it does is make the audit trail and
   * the cockpit agree with reality: a row still reading `active` a week after
   * it lapsed is a lie on a screen, even though it is a harmless one in the
   * authorization path.
   *
   * Nobody should later mistake this for the enforcement. If this method were
   * deleted, grants would still stop authorizing exactly on time.
   *
   * Rows are updated one at a time rather than in a single `updateMany`
   * because `endDetail` names WHEN EACH GRANT LAPSED, which a bulk update
   * cannot express. The set is small by construction — only grants that
   * lapsed since the previous sweep — and the sentence is what an operator
   * reads on the digest, which is worth more than the round trips.
   */
  async sweepExpired(now: Date = new Date()): Promise<number> {
    const lapsed = await this.prisma.trustGrant.findMany({
      where: { status: 'active', expiresAt: { lte: now } },
      select: { id: true, expiresAt: true, actionClass: true },
    });

    let count = 0;
    for (const grant of lapsed) {
      const result = await this.prisma.trustGrant.updateMany({
        // `status: 'active'` again, not just the id: a human may have revoked
        // this grant between the read above and this write, and their decision
        // outranks the sweep's bookkeeping.
        where: { id: grant.id, status: 'active' },
        data: {
          status: 'expired',
          endedAt: now,
          endReason: 'expired',
          endDetail:
            `Expired: the grant lapsed at ${grant.expiresAt.toISOString()} ` +
            `(${describeDuration(now.getTime() - grant.expiresAt.getTime())} ` +
            'ago) with no renewal issued before it. VISION §8: renewal is one ' +
            'tap; silence revokes.',
        },
      });
      count += result.count;
    }

    if (count > 0) {
      this.logger.log(`Expiry sweep marked ${count} trust grant(s) expired.`);
    }

    return count;
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /**
   * Grants, filtered.
   *
   * Revoked, expired and suspended grants stay listable — #96's last
   * acceptance criterion. A grant that disappears when it dies takes its
   * evidence with it, and the evidence is what #99's promotion ladder and
   * VISION §8's daily digest are made of: "what ran under trust, what it cost,
   * what it changed."
   */
  async list(
    query: ListTrustGrantsQuery = {},
    now: Date = new Date(),
  ): Promise<TrustGrantView[]> {
    const rows = await this.prisma.trustGrant.findMany({
      where: {
        ...(query.repositoryId ? { repositoryId: query.repositoryId } : {}),
        ...(query.actionClass ? { actionClass: query.actionClass } : {}),
        ...(query.status
          ? { status: query.status }
          : query.includeEnded
            ? {}
            : { status: 'active' as TrustGrantStatus }),
      },
      // Newest first with an id tie-break, so paging cannot show the same row
      // twice or skip one when two grants share a millisecond.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });

    return rows.map((row) => toTrustGrantView(row, now));
  }

  /** One grant, or a 404. */
  async get(id: string, now: Date = new Date()): Promise<TrustGrantView> {
    const row = await this.prisma.trustGrant.findUnique({ where: { id } });
    if (!row) {
      throw new NotFoundException(`No trust grant with id ${id}`);
    }
    return toTrustGrantView(row, now);
  }

  /**
   * Grants about to lapse, soonest first — the input to #115's renewal prompt.
   *
   * Only grants that are still authorizing: one that has ALREADY lapsed is not
   * "expiring soon", it is gone, and putting it in a renewal prompt would
   * imply the tap keeps something alive that has already stopped working.
   *
   * Soonest first because the prompt is a list a tired person reads from the
   * top, and the one that dies tonight is the one that matters.
   */
  async expiringSoon(
    withinMs: number,
    now: Date = new Date(),
  ): Promise<TrustGrantView[]> {
    if (!Number.isFinite(withinMs) || withinMs < 0) {
      throw new BadRequestException(
        `withinMs must be a finite number of at least 0, got ${String(withinMs)}.`,
      );
    }

    const rows = await this.prisma.trustGrant.findMany({
      where: {
        status: 'active',
        expiresAt: { gt: now, lte: new Date(now.getTime() + withinMs) },
      },
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
    });

    return rows.map((row) => toTrustGrantView(row, now));
  }
}

// ---------------------------------------------------------------------------
// Row -> view
// ---------------------------------------------------------------------------

/** The columns the view is built from. Structural, so a test can supply one. */
export interface TrustGrantRow {
  id: string;
  actionClass: string;
  repositoryId: string;
  expiresAt: Date;
  budgetCeilingUsd: DecimalLike | number;
  spentUsd: DecimalLike | number;
  actionsAuthorized: number;
  actionsFailed: number;
  maxFailureRate: DecimalLike | number;
  maxCostPerActionUsd: DecimalLike | number;
  minActionsBeforeAutoRevoke: number;
  status: TrustGrantStatus;
  endedAt: Date | null;
  endReason: TrustGrantEndReason | null;
  endDetail: string | null;
  revokedById: string | null;
  note: string | null;
  grantedById: string;
  grantedFromProposalId: string | null;
  renewedFromId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A grant row as the API renders it, with the derived figures computed once.
 *
 * `now` is a parameter rather than a call to `new Date()` so a view rendered
 * inside `authorize` and the decision `authorize` made are computed against
 * the SAME instant. Two clock reads a few milliseconds apart is how a grant
 * ends up authorized and reported as expired in the same response.
 */
export function toTrustGrantView(
  row: TrustGrantRow,
  now: Date,
): TrustGrantView {
  const budgetCeilingUsd = decimalToNumber(row.budgetCeilingUsd);
  const spentUsd = decimalToNumber(row.spentUsd);
  const remainingBudgetUsd = Math.max(0, budgetCeilingUsd - spentUsd);
  const budgetHeadroomFraction =
    budgetCeilingUsd > 0
      ? Math.min(1, Math.max(0, remainingBudgetUsd / budgetCeilingUsd))
      : 0;
  const msUntilExpiry = row.expiresAt.getTime() - now.getTime();

  return {
    id: row.id,
    actionClass: row.actionClass,
    repositoryId: row.repositoryId,
    expiresAt: row.expiresAt.toISOString(),
    budgetCeilingUsd,
    spentUsd,
    actionsAuthorized: row.actionsAuthorized,
    actionsFailed: row.actionsFailed,
    maxFailureRate: decimalToNumber(row.maxFailureRate),
    maxCostPerActionUsd: decimalToNumber(row.maxCostPerActionUsd),
    minActionsBeforeAutoRevoke: row.minActionsBeforeAutoRevoke,
    status: row.status,
    endedAt: row.endedAt?.toISOString() ?? null,
    endReason: row.endReason,
    endDetail: row.endDetail,
    revokedById: row.revokedById,
    note: row.note,
    grantedById: row.grantedById,
    grantedFromProposalId: row.grantedFromProposalId,
    renewedFromId: row.renewedFromId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    remainingBudgetUsd,
    budgetHeadroomFraction,
    msUntilExpiry,
    // Null, not zero, when nothing has been authorized: 0/0 is "no evidence",
    // and a 0% failure rate is a claim the data does not support.
    failureRate:
      row.actionsAuthorized > 0
        ? row.actionsFailed / row.actionsAuthorized
        : null,
    nearExpiry:
      row.status === 'active' &&
      msUntilExpiry > 0 &&
      msUntilExpiry <= NEAR_EXPIRY_WINDOW_MS,
    nearBudget:
      row.status === 'active' &&
      budgetHeadroomFraction <= NEAR_BUDGET_HEADROOM_FRACTION,
  };
}

// ---------------------------------------------------------------------------

/**
 * A NOT NULL `Decimal` column as a number.
 *
 * Wraps `toNumberOrNull`'s conversion and adds one thing it deliberately does
 * not do: report a non-finite result as `NaN` rather than as a number, so the
 * callers above can fail closed. `spend-ledger.service.ts` makes the same
 * argument at length — a silent `NaN` inside a spend ceiling makes every
 * comparison false, which is the one direction in which a ceiling must never
 * fail.
 */
function decimalToNumber(value: DecimalLike | number): number {
  const converted = typeof value === 'number' ? value : value.toNumber();
  return Number.isFinite(converted) ? converted : Number.NaN;
}

/** The `status`/`endedAt`/`endReason`/`endDetail` quartet, written together. */
function endedFields(
  verdict: { reason: TrustGrantEndReason; detail: string },
  now: Date,
  status: TrustGrantStatus,
): Pick<TrustGrantRow, 'status' | 'endedAt' | 'endReason' | 'endDetail'> {
  return {
    status,
    endedAt: now,
    endReason: verdict.reason,
    endDetail: verdict.detail,
  };
}

/** The fields `TrustGrantNotRenewableException` reports back. */
function summarise(row: {
  id: string;
  actionClass: string;
  status: TrustGrantStatus;
  expiresAt: Date;
  endedAt: Date | null;
  endReason: TrustGrantEndReason | null;
  endDetail: string | null;
}) {
  return {
    grantId: row.id,
    actionClass: row.actionClass,
    status: row.status,
    expiresAt: row.expiresAt,
    endedAt: row.endedAt,
    endReason: row.endReason,
    endDetail: row.endDetail,
  };
}

/**
 * The refusal for a grant that has already ended, by HOW it ended.
 *
 * `revoked` and `suspended` are kept apart for the reason `AuthorizationDenial`
 * keeps them apart: a revocation is somebody's decision and renewing over it
 * would silently undo a human's call, while a suspension is the system's
 * reading of evidence that the operator may legitimately disagree with. The
 * next move differs, so the sentence differs.
 *
 * A row already swept to `expired` lands on the same reason as a lapsed
 * `active` row — one fact, one reason, whatever the bookkeeping says.
 */
function notRenewableForStatus(
  row: {
    id: string;
    actionClass: string;
    status: TrustGrantStatus;
    expiresAt: Date;
    endedAt: Date | null;
    endReason: TrustGrantEndReason | null;
    endDetail: string | null;
  },
  now: Date,
): TrustGrantNotRenewableException {
  const when = row.endedAt?.toISOString() ?? 'an unrecorded time';

  if (row.status === 'expired') {
    return new TrustGrantNotRenewableException(
      'expired',
      `Trust grant ${row.id} expired at ${row.expiresAt.toISOString()}, ` +
        `${describeDuration(now.getTime() - row.expiresAt.getTime())} ago, ` +
        'and cannot be renewed. VISION §8: renewal is one tap; silence ' +
        'revokes — and the silence already took effect. Renewal creates no ' +
        'grace period. Create a new grant instead, which records what you ' +
        'chose now rather than re-applying what somebody chose a fortnight ago.',
      summarise(row),
    );
  }

  if (row.status === 'revoked') {
    return new TrustGrantNotRenewableException(
      'revoked',
      `Trust grant ${row.id} was revoked at ${when} and cannot be renewed. ` +
        `${row.endDetail ?? 'No detail was recorded.'} A revocation is a ` +
        'decision, and nothing reactivates a revoked grant — renewing over ' +
        "one would silently undo somebody's call. Create a new grant if you " +
        'disagree with it, so that the new decision is recorded as yours.',
      summarise(row),
    );
  }

  return new TrustGrantNotRenewableException(
    'suspended',
    `Trust grant ${row.id} was suspended at ${when} ` +
      `(${row.endReason ?? 'reason not recorded'}) and cannot be renewed. ` +
      `${row.endDetail ?? 'No detail was recorded.'} A suspension is the ` +
      'system reading the evidence, not a human decision, so you may well ' +
      'disagree with it — but say so by creating a new grant, which records ' +
      'that you looked at those numbers and granted trust anyway. Renewing ' +
      'would erase that the evidence was ever raised.',
    summarise(row),
  );
}

/**
 * A duration as a phrase, for the sentences an operator reads.
 *
 * Coarse on purpose: "3 days" is what makes a lapsed grant legible, and
 * "3 days, 4 hours and 12 minutes" is what makes the sentence get skipped.
 */
function describeDuration(ms: number): string {
  const abs = Math.abs(ms);
  const minutes = Math.floor(abs / 60000);
  if (minutes < 1) return 'less than a minute';
  if (minutes < 60) return plural(minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return plural(hours, 'hour');
  return plural(Math.floor(hours / 24), 'day');
}

function plural(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? '' : 's'}`;
}
