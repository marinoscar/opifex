import { getActionClass } from '../supervisor/action-classes';

/**
 * What happens to an approval nobody answers (#97, ADR-0014).
 *
 * VISION §8 gives three rules — "Reversible → auto-approve on timeout, logged;
 * Irreversible → park and escalate, never auto-approve; Spends money → deny on
 * timeout" — and ADR-0014's whole contribution is the observation that those
 * three are neither disjoint nor complete. `re-dispatch` is
 * `reversible-with-effort` AND `spendsMoney: true`, so it matches two of them;
 * `reversible-with-effort` on its own matches none. A timeout is the DEFAULT
 * behaviour of the approval system rather than an edge case — it is what
 * happens at 2am, the exact scenario VISION §8 is written about — so an
 * ambiguous rule set is not a documentation problem, it is a safety one.
 *
 * ADR-0014 resolves it with a TOTAL ORDER over the classification that already
 * exists. #97 is explicit that the engine must "consume the existing
 * reversibility classification rather than defining a second one", and VISION
 * §3.5's claim that sorting by reversibility "reduces interruption volume by
 * roughly an order of magnitude without reducing safety" only holds if one
 * classification is used consistently. So there is no new axis here: this file
 * reads `reversibility` and `spendsMoney` off `ACTION_CLASSES` and nothing
 * else.
 *
 * ## Pure, and deliberately so
 *
 * No injection, no configuration, no clock. `now` is a parameter, in the same
 * style as `silent-detection.ts`, `run-deadline.ts` and `defaults.ts`: a
 * function that reads the clock cannot be pinned to its boundary in a test,
 * and the boundary is the whole behaviour.
 */

/** The three dispositions, matching the `ApprovalTimeoutPolicy` Prisma enum. */
export type TimeoutPolicy = 'auto_approve' | 'deny' | 'park_and_escalate';

/**
 * Four hours: how long a request waits before its timeout resolves it.
 *
 * The number is anchored on VISION §1's origin story, which is where the only
 * concrete duration in the vision appears — *"An agent hits a rate limit at
 * 2pm. I find out at 6pm. Four hours dead."* Four hours is the interval this
 * project was founded to stop being surprised by, so it is the longest a
 * question may sit unanswered before the system stops waiting and acts on the
 * policy it already told the operator about.
 *
 * It is bounded on both sides by arguments that point in opposite directions:
 *
 * - **Shorter loses the batching.** VISION §8's goal is "not fewer decisions"
 *   but "decisions batched and moved off the critical path". A window that
 *   fires while the operator is at lunch turns every approval back into an
 *   interruption, because the only way to keep control of the outcome is to
 *   answer immediately — which is precisely the friction that produces blanket
 *   trust "chosen while annoyed rather than while thinking".
 * - **Longer outlives the situation.** Beyond a night's sleep, the world the
 *   request was raised about has moved: the run finished, the quota window
 *   reset, the issue was closed by hand. Resolving it then is acting on a
 *   snapshot nobody would recognise, and `supersede` exists because that is a
 *   real and separate outcome.
 *
 * ## Why this is a constant in code and not configuration
 *
 * ADR-0014 disqualifies per-class configurable timeouts: "a safety default
 * that can be set per class is a policy, not a guarantee, and the per-class
 * knob is exactly what a tired operator turns at 2am." A single global knob is
 * the same argument with fewer dials — the 2am edit is `TIMEOUT_WINDOW=30d`
 * rather than one class at a time, and the mechanism is gone with no diff, no
 * review, and nothing in the audit trail saying it used to be four hours.
 * `defaults.ts` makes exactly this argument about grant expiry, and it applies
 * here unchanged. Changing this should be a pull request against this file.
 */
export const TIMEOUT_WINDOW_MS = 4 * 60 * 60 * 1000;

/**
 * ADR-0014's total order, top-down, first match wins.
 *
 * The order is the decision. Both branches of rules 1 and 2 execute nothing,
 * so the safety property is identical either way — only the DISPOSITION
 * differs, escalate-and-keep-open versus deny-and-close. Irreversibility ranks
 * above spend because VISION §8 attaches escalation to the irreversible case
 * by name, and denying an irreversible action would close it silently: nobody
 * is told about the case most worth telling them about. Money not spent
 * because of a timeout is recoverable by asking again tomorrow; an
 * irreversible action nobody was told about is not recoverable by anything.
 *
 * Rule 3 — `reversible-with-effort` denies — is the one VISION does not make,
 * and is therefore the one most likely to be "fixed" later. It is deliberate:
 * denying costs a re-ask, auto-approving costs cleanup somebody has to do, and
 * reading the middle band into VISION §8's "reversible" bucket would widen a
 * rule the vision wrote narrowly. The widening would be invisible, because it
 * shows up only in what happened overnight.
 *
 * ## The parameter is `string`, not `ActionClassId`
 *
 * Widened on purpose. The conservative default below only exists if an
 * unrecognised value can actually reach this function, and typing the
 * parameter as the closed union would make the unknown case unreachable except
 * through a cast — which is to say, reachable in production and untestable in
 * a spec. `isActionClass`, `isAutonomyEligible` and `spendsMoney` all take
 * `string` for the same reason. Every `ActionClassId` is still accepted.
 */
export function resolveTimeoutPolicy(actionClass: string): TimeoutPolicy {
  const registered = getActionClass(actionClass);

  // Rule 0, in effect: an UNKNOWN class parks. Never `auto_approve`, and the
  // asymmetry is the point — defaulting the other way would make a typo in a
  // class name an auto-approval path, which is exactly the failure ADR-0011
  // disqualified free-form class strings for and the one `isAutonomyEligible`
  // already refuses to make. Parking rather than denying because an
  // unrecognised class reaching the gate is an operational fault worth a
  // human's attention, and `deny` would close it silently.
  if (registered === undefined) {
    return 'park_and_escalate';
  }

  // 1. Irreversible → park and escalate. Never auto-approved, under any grant
  //    or any timeout (VISION §8). Checked before the grant is consulted at
  //    all, so a grant cannot weaken it — a grant scopes WHICH classes are
  //    eligible, and these are never in that set.
  if (registered.reversibility === 'irreversible') {
    return 'park_and_escalate';
  }

  // 2. Spends money → deny on timeout. VISION §8's third rule, verbatim.
  if (registered.spendsMoney) {
    return 'deny';
  }

  // 3. Reversible with effort → deny on timeout. ADR-0014's addition; see the
  //    doc comment above for why it is not folded into rule 4.
  if (registered.reversibility === 'reversible-with-effort') {
    return 'deny';
  }

  // 4. Reversible → auto-approve on timeout, recorded. Under this order that
  //    is only ever `run-diagnosis`, `spec-quality-feedback` and
  //    `daily-brief` — the three classes that change nothing outside the
  //    decision log. Which is ADR-0014's headline consequence: the timeout is
  //    NOT the autonomy mechanism, the trust grant is. Someone reading #97
  //    alone will expect the opposite, and will be tempted to "fix" this
  //    function to make autonomy work. That would undo the safety property
  //    rather than create autonomy; create a grant instead.
  if (registered.reversibility === 'reversible') {
    return 'auto_approve';
  }

  // Exhaustive over `ActionReversibility` today. A fourth value added to that
  // union lands here, and lands on the conservative side rather than falling
  // through to `auto_approve` — the compiler flags it at build time via the
  // `never` assignment, and if that is somehow bypassed the runtime answer is
  // still the safe one.
  const unreachable: never = registered.reversibility;
  void unreachable;
  return 'park_and_escalate';
}

/**
 * When a request under this policy resolves itself, or `null` for never.
 *
 * ## The null IS the guarantee
 *
 * `park_and_escalate` returns `null`, and that null is VISION §8's "never
 * auto-approve" expressed in DATA rather than in a branch someone can reorder.
 * The column it is written to is nullable for exactly this reason (see
 * `ApprovalRequest.timeoutAt`): there is no timer to fire, no sweeper query
 * that could select the row, and no timestamp anywhere that a bug iterating
 * "everything with a due timeout" could accidentally match. A guarantee
 * carried by an `if` survives only as long as nobody reorders the `if`; a
 * guarantee carried by the absence of a row is not something a later edit can
 * quietly undo.
 *
 * `ApprovalGateService.sweepTimeouts` asserts on this anyway, and says so —
 * the assertion documents the invariant rather than enforcing it, because the
 * query already cannot return such a row.
 */
export function timeoutAtFor(policy: TimeoutPolicy, now: Date): Date | null {
  if (policy === 'park_and_escalate') {
    return null;
  }

  return new Date(now.getTime() + TIMEOUT_WINDOW_MS);
}
