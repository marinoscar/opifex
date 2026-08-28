import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';

import { OperatorSettingsService } from '../settings/operator-settings/operator-settings.service';

/**
 * The hard global spend ceiling (#65, #345, ADR-0018 §6).
 *
 * ## The guarantee is access control, not absence — and that is a downgrade
 *
 * This file used to say the opposite, and the change is worth stating plainly
 * rather than quietly editing away. Until #345 the ceiling was read from
 * `process.env` once, in the constructor, into `readonly` fields with no
 * setter anywhere in the class, and the guarantee that followed was
 * structural: there was genuinely no code path from anything inside the
 * process — an autonomous proposer, a fully promoted trust grant, a bug — to
 * this number. A structural guarantee has no failure mode inside the process,
 * because there is nothing inside it to compromise.
 *
 * ADR-0018 §6 replaces it with a guarantee that is different in kind, not
 * degree. A setter exists now: `PATCH /api/operator-settings`, RBAC-gated the
 * same way the rest of the settings surface is. The claim is no longer "no
 * setter exists" but **"a setter exists and the agent provably cannot reach
 * it"**, and that claim has a failure mode the old one did not — something
 * that is not a deliberate human admin action reaching the write path at all.
 * Two independent barriers close it, and BOTH are preconditions rather than
 * defence in depth, because either one missing invalidates the decision:
 *
 * - **`runners/process/child-environment.ts` (#334).** The agent subprocess
 *   inherits an allowlisted environment, so it holds no credential to
 *   authenticate with. If an agent's own execution environment could reach an
 *   admin's session, this ceiling would not be access-controlled — it would be
 *   unlocked.
 * - **`auth/guards/interactive-session.guard.ts` (#346).** The settings write
 *   path refuses any credential that cannot prove a human was present. A
 *   personal access token authenticates as the user who created it and is
 *   built for non-interactive clients; an Admin-scoped PAT reaching this
 *   endpoint would be indistinguishable in the audit log from that admin
 *   acting deliberately.
 *
 * VISION §8 was amended for this and not ignored: "modifying CI workflows or
 * the policy table" is still absolutely never-trustable, while modifying
 * budget configuration is never-trustable *outside an interactive, RBAC-gated
 * admin action*. No trust grant raises this ceiling, no promoted action class
 * reaches the write, and `autonomy/never-trustable.ts` names the write itself
 * as a forbidden `budget-config-write` effect — so a promotion mistake or a
 * future executor wired incorrectly is refused by the guard regardless of what
 * the class registry says.
 *
 * ## What is still true
 *
 * Every ceiling change is written to `audit_events` by the write path that
 * makes it (`operator_settings:set` / `:clear`, with the key and the before
 * and after), which the old design could not offer because there was nothing
 * to record.
 *
 * It still does **not** guarantee that an agent with write access to this
 * repository could not edit this file. Nothing in the application layer can
 * guarantee that, and claiming otherwise would be the "appearance of
 * guardrails and none of the substance" VISION §8 warns about. The defence
 * there is that the factory's token must not carry workflow-write, that this
 * file's changes are visible in a diff, and that the ceiling is enforced in
 * the process that holds the money rather than in the one being budgeted.
 *
 * ## Unset means dispatch is refused, not that spending is unlimited
 *
 * This is now the ONLY thing that stops a fresh install spending. ADR-0019
 * (#439) flipped `DISPATCH_ENABLED`, the runner and GitHub writes to on and
 * deliberately left this unset, moving the protection from four proxies for
 * the hazard onto the hazard itself — money. A ceiling cannot be satisfied by
 * accident: it is a number somebody has to choose. Running without naming one
 * is exactly the failure mode #65 exists to prevent — "an unsupervised agent with no spend ceiling is
 * the failure mode that turns a productivity tool into a bill." So an unset
 * ceiling does not mean "unlimited"; it means the gate has nothing to check
 * against, and an unbounded action that cannot be checked does not proceed
 * (VISION §3.5 gates on reversibility, and spend is not reversible).
 */

/**
 * The environment variable the ceiling falls back to.
 *
 * No longer "the only name that sets the ceiling": since #345 it is the middle
 * layer of `default -> env -> database row`, and a row written from the
 * Control Center wins over it. It is still the only *variable* — nothing else
 * in the environment moves this number — and a deployment that sets it and
 * never opens the Control Center behaves exactly as it did before.
 */
export const HARD_SPEND_CEILING_ENV = 'OPIFEX_HARD_SPEND_CEILING_USD';

/** The variable the window falls back to, on the same three-layer terms. */
export const HARD_SPEND_CEILING_WINDOW_ENV =
  'OPIFEX_HARD_SPEND_CEILING_WINDOW_DAYS';

/** The managed keys this ceiling resolves through. */
export const HARD_SPEND_CEILING_KEYS = [
  'dispatch.hardSpendCeilingUsd',
  'dispatch.hardSpendCeilingWindowDays',
] as const;

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
 * Holds the ceiling in force, and re-reads it whenever the operator moves it.
 *
 * ## The setter, and why it takes no argument
 *
 * `refresh()` is the only way this number moves, and it is fed by
 * `OperatorSettingsService` rather than by its caller. That is not a stylistic
 * choice about signatures: a public `set(usd: number)` would be exactly the
 * `ConfigService.set()` hazard this file's header used to be written against —
 * any code holding the injected instance could raise the ceiling, and nothing
 * would record that it happened. With no parameter, the only thing that can
 * change the answer is a value that came through the resolver, which means it
 * came through the write path, which means it was written by an authenticated,
 * interactive human and filed in `audit_events`.
 *
 * ## Three places it is called, and why each is needed
 *
 * The constructor reads and announces, so a boot log states the ceiling even
 * when the database is unreachable and only the environment layer answers.
 * `onModuleInit` reads again, because provider construction happens before
 * `OperatorSettingsService` has loaded the overlay — without this a stored
 * override would not reach the boot announcement. The change listener reads on
 * every announced change, which is what makes a raised ceiling permit more
 * spend, and a lowered one permit less, without a restart.
 */
@Injectable()
export class HardSpendCeilingService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HardSpendCeilingService.name);

  /**
   * The ceiling in force. Mutable since #345 — see the class doc — and
   * private, with `value` handing out a copy, so the only path to it remains
   * {@link refresh}.
   */
  private ceiling: HardCeiling;

  /** Detaches the settings listener. Undefined before init, after destroy. */
  private unsubscribe: (() => void) | undefined;

  constructor(private readonly settings: OperatorSettingsService) {
    this.ceiling = this.read();
    this.announce();

    this.unsubscribe = this.settings.onChange((change) => {
      if (change.keys.some((key) => keyOfThisCeiling(key))) this.refresh();
    });
  }

  /**
   * Re-read once the overlay has loaded.
   *
   * Silent when nothing moved, so an ordinary boot announces once rather than
   * twice — and loud when the stored ceiling differs from the environment's,
   * which is the case an operator most needs to see stated.
   */
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

  /**
   * Take whatever the resolver now says, and announce it if it moved.
   *
   * Public because the module lifecycle and the change listener both call it,
   * and because a spec proving a ceiling change takes effect should drive the
   * same entry point the running system does. It accepts no value; see the
   * class doc.
   */
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
   * The resolved values are handed to `parseHardCeiling` in the shape it
   * already takes, rather than being interpreted here, so there is exactly one
   * implementation of "unset", "malformed" and the window fallback in this
   * file. A second reading of those rules on the settings path is how the
   * distinction between a mistyped ceiling and an absent one would quietly
   * stop being true on one of the two paths.
   */
  private read(): HardCeiling {
    return parseHardCeiling({
      [HARD_SPEND_CEILING_ENV]: this.settings.get(
        'dispatch.hardSpendCeilingUsd',
      ),
      [HARD_SPEND_CEILING_WINDOW_ENV]: String(
        this.settings.get('dispatch.hardSpendCeilingWindowDays'),
      ),
    });
  }

  /**
   * Say what the ceiling is, at boot and on every change, including when there
   * isn't one.
   *
   * A safety limit nobody can see the state of is one an operator will assume
   * is working. The malformed case is an error rather than a warning because
   * it is the case where somebody believed they had set a ceiling.
   *
   * Since #345 this also fires when an operator moves the ceiling from the
   * Control Center, which is the log line that makes a live change visible to
   * anyone reading the process's output rather than the audit table.
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
        `No hard spend ceiling is set, so dispatch will refuse every work order. Since ` +
          `ADR-0019 this is the ONLY thing stopping this deployment: the runner, dispatch ` +
          `and GitHub writes all ship enabled, so the factory is ready and will start ` +
          `spending as soon as a ceiling exists. Set the most you are willing to spend ` +
          `per ${windowDays} days from the Control Center, or with ` +
          `${HARD_SPEND_CEILING_ENV}.`,
      );
      return;
    }

    this.logger.log(
      `Hard spend ceiling: $${limitUsd} per ${windowDays} days. It cannot be raised by any ` +
        `trust grant, promoted action class or agent-reachable path — only by a signed-in ` +
        `admin, interactively, on the record (ADR-0018 §6).`,
    );
  }
}

/** Whether a changed managed key is one of this ceiling's two. */
function keyOfThisCeiling(key: string): boolean {
  return (HARD_SPEND_CEILING_KEYS as readonly string[]).includes(key);
}
