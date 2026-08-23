import { Injectable, Logger } from '@nestjs/common';

/**
 * The hard global spend ceiling (#65).
 *
 * ## Why this does not go through `ConfigService`
 *
 * Every other setting in this codebase is read through `ConfigService`, and
 * this one deliberately is not. VISION §8 puts the hard ceiling on the **never
 * trustable** list: spend above it cannot be authorized by any trust grant,
 * ever, and "a limit an agent can raise is not a limit."
 *
 * `ConfigService` has a public `set()`. Any code holding the injected instance
 * can raise a value that came from `configuration.ts` at runtime, and nothing
 * would record that it happened. `system_settings` is worse — it is a JSONB
 * row an Admin can `PATCH` over HTTP, which is precisely a trust grant
 * reaching the limit. So the ceiling is read from `process.env` here, once, in
 * the constructor, into `readonly` fields with no setter anywhere in the
 * class.
 *
 * ## What this does and does not guarantee, stated exactly
 *
 * It guarantees there is **no runtime path** to a higher ceiling: no endpoint,
 * no setting, no database row, no `ConfigService.set`, no trust grant. Raising
 * it requires an operator changing the environment and restarting the process
 * — an act outside the running system, which is the whole point.
 *
 * It does **not** guarantee that an agent with write access to this repository
 * could not edit this file. Nothing in the application layer can guarantee
 * that, and claiming otherwise would be the "appearance of guardrails and none
 * of the substance" VISION §8 warns about. The defence there is that the
 * factory's token must not carry workflow-write, that this file's changes are
 * visible in a diff, and that the ceiling is enforced in the process that
 * holds the money rather than in the one being budgeted.
 *
 * ## Unset means dispatch is refused, not that spending is unlimited
 *
 * `DISPATCH_ENABLED` already defaults off, so nothing spends money until an
 * operator opts in. Opting in without naming a ceiling is exactly the failure
 * mode #65 exists to prevent — "an unsupervised agent with no spend ceiling is
 * the failure mode that turns a productivity tool into a bill." So an unset
 * ceiling does not mean "unlimited"; it means the gate has nothing to check
 * against, and an unbounded action that cannot be checked does not proceed
 * (VISION §3.5 gates on reversibility, and spend is not reversible).
 */

/** The only name that sets the ceiling. Nothing else may. */
export const HARD_SPEND_CEILING_ENV = 'OPIFEX_HARD_SPEND_CEILING_USD';

/** The only name that sets the window the ceiling is measured over. */
export const HARD_SPEND_CEILING_WINDOW_ENV = 'OPIFEX_HARD_SPEND_CEILING_WINDOW_DAYS';

/**
 * The default window: thirty days.
 *
 * A ceiling with no window is a lifetime cap, which stops the factory
 * permanently the first time it is reached and can never be recovered from
 * except by raising the limit — turning the safety mechanism into pressure to
 * disable it. A rolling window makes the ceiling a rate, which is what an
 * operator actually means by "I will spend at most this much."
 */
export const DEFAULT_CEILING_WINDOW_DAYS = 30;

/**
 * The parsed ceiling, as a value.
 *
 * Separate from the service so the parsing rules can be tested exhaustively
 * without a Nest container, and so the service has exactly one job: hold it.
 */
export interface HardCeiling {
  /** Dollars. Null means no ceiling was set, which blocks rather than permits. */
  readonly limitUsd: number | null;
  /** The rolling window the ceiling applies over. */
  readonly windowDays: number;
  /** Set but unusable — surfaced so a typo is never read as "no ceiling". */
  readonly malformed: string | null;
}

/**
 * Parse the ceiling out of an environment.
 *
 * A malformed value is NOT treated as absent. `OPIFEX_HARD_SPEND_CEILING_USD=50O`
 * (letter O) and a missing variable produce the same `limitUsd: null`, and if
 * both silently meant "no ceiling" the operator who typed the typo would
 * believe they had set one. `malformed` carries the offending text so the gate
 * can say which of the two happened.
 */
export function parseHardCeiling(env: NodeJS.ProcessEnv): HardCeiling {
  const raw = env[HARD_SPEND_CEILING_ENV];
  const rawWindow = env[HARD_SPEND_CEILING_WINDOW_ENV];

  const windowDays = positiveIntOr(rawWindow, DEFAULT_CEILING_WINDOW_DAYS);

  if (raw === undefined || raw.trim() === '') {
    return { limitUsd: null, windowDays, malformed: null };
  }

  const parsed = Number(raw);
  // `Number('')` is 0 and `Number('  ')` is 0, which is why the empty case is
  // handled above: a ceiling of zero is a meaningful instruction ("spend
  // nothing") and must not be reachable by accident from an empty string.
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
 * Holds the ceiling for the lifetime of the process.
 *
 * No setter, no mutable field, and `process.env` is read exactly once — in the
 * constructor — so that even mutating `process.env` after boot cannot move it.
 */
@Injectable()
export class HardSpendCeilingService {
  private readonly logger = new Logger(HardSpendCeilingService.name);

  private readonly ceiling: HardCeiling;

  constructor() {
    this.ceiling = parseHardCeiling(process.env);
    this.announce();
  }

  /** The ceiling in force. A copy, so a caller cannot mutate the held value. */
  get value(): HardCeiling {
    return { ...this.ceiling };
  }

  /**
   * Say at boot what the ceiling is, including when there isn't one.
   *
   * A safety limit nobody can see the state of is one an operator will assume
   * is working. The malformed case is an error rather than a warning because
   * it is the case where somebody believed they had set a ceiling.
   */
  private announce(): void {
    const { limitUsd, windowDays, malformed } = this.ceiling;

    if (malformed !== null) {
      this.logger.error(
        `${HARD_SPEND_CEILING_ENV} is set to ${JSON.stringify(malformed)}, which is not a ` +
          `non-negative number. Treating it as UNSET — dispatch will refuse to spend until ` +
          `it is corrected.`,
      );
      return;
    }

    if (limitUsd === null) {
      this.logger.warn(
        `${HARD_SPEND_CEILING_ENV} is not set. Dispatch will refuse to spend. Set it to the ` +
          `most you are willing to spend per ${windowDays} days.`,
      );
      return;
    }

    this.logger.log(
      `Hard spend ceiling: $${limitUsd} per ${windowDays} days. This cannot be raised at ` +
        `runtime by any setting, endpoint or trust grant.`,
    );
  }
}
