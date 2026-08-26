import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';

import type { HardCeiling } from '../../budget/hard-spend-ceiling';
import { OperatorSettingsService } from '../../settings/operator-settings/operator-settings.service';

/**
 * The supervisor's own hard spend ceiling (#261, #345, ADR-0017, ADR-0018 §6).
 *
 * ## Why this is not `OPIFEX_HARD_SPEND_CEILING_USD`
 *
 * `budget/hard-spend-ceiling.ts` is dispatch's ceiling — what the factory may
 * spend on runs. Folding supervisor spend into it was considered and rejected,
 * because it would recreate at the dollar layer the loop ADR-0015 spent a
 * whole document escaping at the credential layer: the supervisor would go
 * quiet once workers had spent close to the shared figure, which is exactly
 * the moment the one component whose job is noticing and explaining unusual
 * spend needs to be running. A supervisor absent because the factory spent the
 * budget is absent precisely when things are going wrong.
 *
 * So: a second ceiling, its own variable, its own tally, and a separate class
 * — `HardSpendCeilingService` keeps meaning exactly one thing everywhere it
 * appears, and a reader never has to ask "which ceiling".
 *
 * ## The guarantee is access control now, not absence
 *
 * This header used to say that `process.env` was read once, in the
 * constructor, into a `readonly` field with no setter anywhere in the class,
 * and that raising the ceiling therefore took an operator changing the
 * environment and restarting the process. That is no longer true, and ADR-0018
 * §6 is where the reversal is argued rather than here — the same argument, in
 * the same words, for both ceilings, so this file cross-references it instead
 * of restating half of it and drifting from the other half.
 *
 * The short version: the guarantee moved from **structural** (no setter exists
 * anywhere in the process, so there is nothing inside it to compromise) to
 * **access-controlled** (a setter exists — `PATCH /api/operator-settings` —
 * and the agent provably cannot reach it). That is a real downgrade, and it is
 * only defensible because the agent subprocess inherits no credential to
 * authenticate with (#334) and this write path refuses any credential that
 * cannot prove a human was present (#346). Either one missing invalidates the
 * decision rather than merely weakening it. VISION §8's "a limit an agent can
 * raise is not a limit" is unchanged and still holds: no trust grant, no
 * promoted action class and no agent-reachable path moves this number, and
 * `autonomy/never-trustable.ts` refuses a `budget-config-write` effect
 * whatever the class registry says. Every change is filed in `audit_events` by
 * the write path that makes it — which the old design could not offer, because
 * there was nothing to record.
 *
 * ## Unset refuses, and that is a behaviour change with a name
 *
 * ADR-0016 removed the only other thing that ever stood the supervisor down
 * for a spend-adjacent reason, and #261 exists because nothing in the running
 * system bounds supervisor spend at all today: `SUPERVISOR_ENABLED=true` plus
 * a model key is currently sufficient for an hourly cron to spend without
 * limit. "Unset means unlimited" is therefore not a neutral default here — it
 * is that bug, restated as a default. A deployment running a supervisor today
 * with no ceiling configured stops running one the moment this ships, and
 * stays stopped until `SUPERVISOR_HARD_SPEND_CEILING_USD` is set — or, since
 * #345, until an admin sets it from the Control Center. That is the hole being
 * closed, not a regression to soften, and `announce()` below is what makes
 * sure the operator can see it happen rather than infer it from silence.
 */

/**
 * The environment variable the supervisor's ceiling falls back to.
 *
 * No longer "the only name that sets it": since #345 it is the middle layer of
 * `default -> env -> database row`, and a row written from the Control Center
 * wins over it. It is still the only *variable*, and a deployment that sets it
 * and never opens the Control Center behaves exactly as it did before.
 */
export const SUPERVISOR_SPEND_CEILING_ENV = 'SUPERVISOR_HARD_SPEND_CEILING_USD';

/** The variable the window falls back to, on the same three-layer terms. */
export const SUPERVISOR_SPEND_CEILING_WINDOW_ENV =
  'SUPERVISOR_HARD_SPEND_CEILING_WINDOW_DAYS';

/** The managed keys this ceiling resolves through. */
export const SUPERVISOR_SPEND_CEILING_KEYS = [
  'supervisor.hardSpendCeilingUsd',
  'supervisor.hardSpendCeilingWindowDays',
] as const;

/**
 * The default window: ONE day, where dispatch's ceiling defaults to thirty.
 *
 * Thirty is right for what dispatch measures. Runner spend is bursty and
 * irregular — nothing for days, then several dollars in an afternoon — and a
 * rolling month is what an operator means by "I will spend at most this much".
 *
 * The supervisor's spend is close to the opposite shape. `SupervisorTask` runs
 * `EVERY_HOUR` and every registered proposer runs once per tick regardless of
 * how busy the factory is (ADR-0016's finding), so per-tick cost is small and
 * near-constant, set almost entirely by which model `SUPERVISOR_MODEL_NAME`
 * names. A month-long window is the wrong instrument for that in both
 * directions at once:
 *
 * - **Slow to catch.** A config change to a materially more expensive model —
 *   Opus is fifteen to twenty times Haiku's rate in `MODEL_RATES` — would run
 *   at twenty-four ticks a day for potentially weeks before a monthly figure
 *   caught a monthly ceiling sized for the old rate.
 * - **Slow to recover.** Once tripped, a thirty-day ceiling leaves the
 *   supervisor dark for up to a month, which is the "absent when things are
 *   going wrong" failure this ceiling exists to avoid, self-inflicted.
 *
 * One day catches a pricing regression within roughly twenty-four ticks and
 * recovers as the window rolls, with no operator intervention. Anyone who
 * genuinely wants a monthly figure sets the window variable; a deployment that
 * has not thought about it should not be forced into the slower answer.
 */
export const DEFAULT_SUPERVISOR_CEILING_WINDOW_DAYS = 1;

/**
 * Parse the supervisor's ceiling out of an environment.
 *
 * ## Why this duplicates `parseHardCeiling` instead of parameterizing it
 *
 * ADR-0017 leaves the choice to the implementer and requires only that the
 * malformed / absent / fail-closed rules be identical in BEHAVIOUR. Two things
 * decided it toward a sibling function:
 *
 * 1. The same ADR states that `hard-spend-ceiling.ts` is "unmodified" by this
 *    decision. Parameterizing means editing the file that holds the dispatch
 *    ceiling in order to ship the supervisor's — and then a future change to
 *    one ceiling's parsing silently changes the other's, which is precisely
 *    the coupling the rest of this decision is about not creating.
 * 2. `budget/hard-spend-ceiling.ts` says in its own header that it is
 *    dispatch's. A shared parser would make it half the supervisor's too.
 *
 * The honest cost of duplication is drift, so it is pinned rather than hoped
 * for: `supervisor-spend-ceiling.spec.ts` runs both parsers over one table of
 * inputs and asserts they agree, so a change to either that is not made to
 * both fails a test rather than going unnoticed.
 *
 * The `HardCeiling` TYPE is reused rather than twinned — a structurally
 * identical interface with a different name buys nothing and costs a reader
 * the question of how the two differ. The import direction is supervisor →
 * budget, which the #94 governing test permits: it forbids the hot path from
 * importing the supervisor, and says nothing about the reverse.
 */
export function parseSupervisorCeiling(env: NodeJS.ProcessEnv): HardCeiling {
  const raw = env[SUPERVISOR_SPEND_CEILING_ENV];
  const rawWindow = env[SUPERVISOR_SPEND_CEILING_WINDOW_ENV];

  const windowDays = positiveIntOr(
    rawWindow,
    DEFAULT_SUPERVISOR_CEILING_WINDOW_DAYS,
  );

  if (raw === undefined || raw.trim() === '') {
    return { limitUsd: null, windowDays, malformed: null };
  }

  const parsed = Number(raw);
  // `Number('')` and `Number('  ')` are both 0, which is why the empty case is
  // handled above: a ceiling of zero says "spend nothing", which is a real
  // instruction and must not be reachable by leaving the variable blank.
  if (!Number.isFinite(parsed) || parsed < 0) {
    return { limitUsd: null, windowDays, malformed: raw };
  }

  return { limitUsd: parsed, windowDays, malformed: null };
}

function positiveIntOr(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Holds the supervisor's ceiling, and re-reads it whenever an operator moves
 * it.
 *
 * The same shape as `HardSpendCeilingService`, deliberately, and for the same
 * reasons its class doc gives at length: `refresh()` is the only mutator, it
 * takes no argument so that nothing holding this instance can name a number,
 * and it is called from three places — the constructor (so a boot log states
 * the ceiling even when only the environment layer answers), `onModuleInit`
 * (because providers are constructed before the resolver loads its overlay),
 * and the change listener (which is what makes a live edit take effect).
 */
@Injectable()
export class SupervisorSpendCeilingService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(SupervisorSpendCeilingService.name);

  /** Mutable since #345 — see the class doc. `value` hands out a copy. */
  private ceiling: HardCeiling;

  /** Detaches the settings listener. Undefined before init, after destroy. */
  private unsubscribe: (() => void) | undefined;

  // The `@Optional() env: NodeJS.ProcessEnv` parameter this class used to take
  // is gone. It existed so a spec could hand this class an environment without
  // mutating the process's; `makeOperatorSettings({ env })` does that now, and
  // does it for the whole resolution chain rather than for one layer of it.
  constructor(private readonly settings: OperatorSettingsService) {
    this.ceiling = this.read();
    this.announce();

    this.unsubscribe = this.settings.onChange((change) => {
      if (change.keys.some((key) => keyOfThisCeiling(key))) this.refresh();
    });
  }

  onModuleInit(): void {
    this.refresh();
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /** The ceiling in force. A copy, so a caller cannot mutate the held value. */
  get value(): HardCeiling {
    return { ...this.ceiling };
  }

  /** Take whatever the resolver now says, and announce it if it moved. */
  refresh(): HardCeiling {
    const next = this.read();
    const moved =
      next.limitUsd !== this.ceiling.limitUsd ||
      next.windowDays !== this.ceiling.windowDays ||
      next.malformed !== this.ceiling.malformed;

    this.ceiling = next;
    if (moved) this.announce();

    return this.value;
  }

  /**
   * The resolver's answer, run through the same parser as the environment's.
   *
   * Handed to `parseSupervisorCeiling` in the shape it already takes rather
   * than interpreted here, so that the malformed / absent / fail-closed rules
   * have exactly one implementation on both layers — which is also what keeps
   * the parity assertion against `parseHardCeiling` meaningful.
   */
  private read(): HardCeiling {
    return parseSupervisorCeiling({
      [SUPERVISOR_SPEND_CEILING_ENV]: this.settings.get(
        'supervisor.hardSpendCeilingUsd',
      ),
      [SUPERVISOR_SPEND_CEILING_WINDOW_ENV]: String(
        this.settings.get('supervisor.hardSpendCeilingWindowDays'),
      ),
    });
  }

  /**
   * Say what the ceiling is, at boot and on every change, including when there
   * isn't one.
   *
   * Three cases, mirroring `HardSpendCeilingService.announce()`: malformed is
   * an ERROR, because it is the case where somebody believed they had set a
   * ceiling; unset is a WARNING that names the variable and what its absence
   * will do, because that absence now stops the supervisor and an operator
   * must not have to infer that from an empty decision log; configured is a
   * log line stating the figure, because a safety limit nobody can see the
   * state of is one an operator will assume is working.
   *
   * Silent unless the supervisor is enabled, and that is now read through the
   * resolver like everything else rather than off a raw environment variable —
   * a deployment that never turned the supervisor on does not need a reminder
   * to configure a ceiling for a feature it is not running, and a boot warning
   * about a setting nobody chose teaches operators to skim warnings.
   */
  private announce(): void {
    if (!this.settings.get('supervisor.enabled')) return;

    const { limitUsd, windowDays, malformed } = this.ceiling;

    if (malformed !== null) {
      this.logger.error(
        `${SUPERVISOR_SPEND_CEILING_ENV} is set to ${JSON.stringify(malformed)}, which is ` +
          `not a non-negative number. Treating it as UNSET — the supervisor will refuse to ` +
          `run until it is corrected.`,
      );
      return;
    }

    if (limitUsd === null) {
      this.logger.warn(
        `${SUPERVISOR_SPEND_CEILING_ENV} is not set, so the supervisor will not run: every ` +
          `tick will record a skipped_budget row instead. Set it to the most you are willing ` +
          `to spend on supervision per ${windowDays} day(s). This is separate from ` +
          `OPIFEX_HARD_SPEND_CEILING_USD, which bounds what dispatch spends on runs.`,
      );
      return;
    }

    this.logger.log(
      `Supervisor spend ceiling: $${limitUsd} per ${windowDays} day(s). Separate from the ` +
        `dispatch ceiling, and it cannot be raised by any trust grant, promoted action class ` +
        `or agent-reachable path — only by a signed-in admin, interactively, on the record ` +
        `(ADR-0018 §6).`,
    );
  }
}

/** Whether a changed managed key is one of this ceiling's two. */
function keyOfThisCeiling(key: string): boolean {
  return (SUPERVISOR_SPEND_CEILING_KEYS as readonly string[]).includes(key);
}
