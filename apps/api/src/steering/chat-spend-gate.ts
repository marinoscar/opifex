/**
 * May the steering chat spend anything right now? (#425, epic #419.)
 *
 * ## The finding
 *
 * It may not, and today it never may. This file exists so that the reason is
 * a decision written down in one place with a name, rather than an omission
 * nobody notices.
 *
 * #423 shipped `chat.model.*` and said so explicitly in the settings registry:
 * *"Note what is NOT here: a chat spend ceiling. The supervisor has one and
 * refuses to run without it (#261), and the chat will need the same treatment
 * once #425 gives it a caller that can spend."* This issue is that caller. It
 * therefore had to either supply the ceiling or refuse, and the one thing it
 * could not do is run a metered consumer with no bound.
 *
 * ## Why the ceiling is not supplied here
 *
 * A spend ceiling is a CUMULATIVE bound over a window (ADR-0017), not a bound
 * on one call. `chat.model.defaultMaxTokens` caps a single answer and is
 * therefore not a ceiling at all — an operator can send a thousand
 * instructions, and a thousand bounded answers is an unbounded bill.
 *
 * Enforcing a cumulative bound needs a durable tally of what has been spent,
 * and the chat has nowhere to keep one:
 *
 *  - `SupervisorInvocation` is not available. `supervisor-spend-ledger.service
 *    .ts` reads that table and nothing else, and `schema.prisma` states on the
 *    column itself that supervisor cost is separate from run cost *"by
 *    construction — a different table entirely"*. Writing chat rows into it
 *    would merge two consumers' spend inside the one table whose whole point
 *    is that it is not merged with another.
 *  - A new table is a schema change, which #425 does not carry.
 *  - A process-local counter is not a ceiling. It resets on restart, and a
 *    limit that a `docker compose restart` clears is a limit an operator will
 *    believe in and not have.
 *
 * ## So the model path REFUSES, and says which of the two it is
 *
 * `SteeringService` reports an instruction it could not parse as
 * `needs-interpretation` and states, as data, both why no model was asked
 * (this) and whether one could have answered if asked (`modelReadiness`). The
 * two are reported together on purpose: an operator who configures
 * `chat.model.name` to fix the second would otherwise find nothing changed and
 * have no way to discover the first.
 *
 * This is a REFUSAL, not a silent no-op, and it is the only reason the model
 * is not invoked. When a chat spend ledger and ceiling exist, this function is
 * the single place that starts admitting — nothing else in the steering path
 * decides whether a model may be called.
 */

export type ChatSpendRefusal = 'no-chat-spend-ledger';

export type ChatSpendVerdict =
  | { admit: true; ceilingUsd: number; windowDays: number; reason: string }
  | { admit: false; refusal: ChatSpendRefusal; reason: string };

/** The sentence an operator reads. Exported so a test pins the wording. */
export const NO_CHAT_SPEND_CEILING_REASON =
  'The steering chat has no spend ceiling, so no model was asked. A ceiling ' +
  'is a cumulative bound over a window and needs a durable tally of what has ' +
  'been spent; the chat has none, and CHAT_MODEL_DEFAULT_MAX_TOKENS bounds ' +
  'one answer rather than the bill. Running a metered consumer unbounded is ' +
  'the failure #261 exists to prevent, so the model path refuses instead of ' +
  'defaulting to unlimited. Instructions that name issue numbers explicitly ' +
  '(`#419`, `only work on #1, #2 and #3`) are parsed in code and are ' +
  'unaffected.';

/**
 * Whether the chat may make a metered model call.
 *
 * Takes no arguments TODAY and that is the honest signature: the verdict is
 * not a function of anything currently observable, because the ledger that
 * would make it one does not exist. It is a function rather than a constant so
 * that the call site reads as a gate — the shape `assessQuota` and
 * `assessSupervisorSpend` already have — and so that supplying the ledger
 * later changes this file and no other.
 */
export function assessChatSpend(): ChatSpendVerdict {
  return {
    admit: false,
    refusal: 'no-chat-spend-ledger',
    reason: NO_CHAT_SPEND_CEILING_REASON,
  };
}
