/**
 * The action-class taxonomy (#91, ADR-0011).
 *
 * VISION §7: trust is "granted per **action class**, on evidence, never in
 * bulk", and §14 calls the class "the unit at which autonomy is granted — never
 * 'the agent' as a whole". So this file is the partition key for every approval
 * rate the promotion ladder will ever compute.
 *
 * ONE registry, imported by everything. The decision log (#90) validates
 * against it, the proposers (#92, #109, #110, #111) tag their output with it,
 * and the future trust-grant model (#22, #99) reads the same list. A Prisma
 * enum, a union type here, and a table in the docs would each drift from the
 * other two, and the drift shows up as an approval rate computed over a class
 * that no longer means what the grant thinks it means.
 *
 * The column that stores a class is a plain string validated at the boundary,
 * not a database enum — ADR-0010 makes an enum addition a MAJOR schema bump,
 * and adding an action class is an ordinary event. `RunnerNeed` is the same
 * shape for the same reason.
 */

/**
 * How hard it is to undo the effect, per VISION §3.5.
 *
 * A property of the CLASS, not of an instance. If two proposals of the same
 * class differ in how reversible they are, the class is too wide and should be
 * split — that is the granularity rule ADR-0011 settled.
 */
export type ActionReversibility =
  /** Undone by a single opposite action, with nothing left behind. */
  | 'reversible'
  /** Undoable, but it leaves a trace or costs work someone has to do. */
  | 'reversible-with-effort'
  /** Cannot be undone. Nothing in this taxonomy is autonomy-eligible here. */
  | 'irreversible';

/** One action class: what is proposed, and what would change if approved. */
export interface ActionClass {
  /** The partition key. `kebab-case`, stable, never renamed once measured. */
  readonly id: ActionClassId;
  /** Short human label for the cockpit and the daily brief. */
  readonly title: string;
  /**
   * What a proposal of this class actually asks for — a sentence, not a
   * category label. #91's first acceptance criterion: "each class has a precise
   * definition, not a category label."
   */
  readonly definition: string;
  /** What changes outside the control plane if a human approves. */
  readonly effect: string;
  readonly reversibility: ActionReversibility;
  /**
   * Whether this class may EVER be promoted to auto-execution.
   *
   * `false` carries VISION §7's "quarantine decisions (probably never)" in the
   * registry rather than in someone's memory. It is a declaration, not an
   * enforcement mechanism: execution is prevented structurally by the
   * supervisor module having no executor to reach (#90), and this flag stops a
   * promotion path from granting a class the vision already ruled out.
   */
  readonly autonomyEligible: boolean;
  /**
   * Whether Phase 6 ships something that produces proposals of this class.
   *
   * Recorded because #90's approval-rate measurement is biased without it: a
   * class with no producer looks identical to one that is always proposed
   * correctly, and both read as "no evidence". Being explicit here is what
   * lets the ladder distinguish "not yet measured" from "never proposed".
   */
  readonly hasProposer: boolean;
  /**
   * Whether this class's APPROVED EFFECT spends money.
   *
   * Not "does a proposal of this class cost anything" — every class costs the
   * supervisor's own model invocation, so that reading would be `true`
   * everywhere and would carry no information. This flags the classes whose
   * effect, once a human approves it, causes a runner or model invocation with
   * a cost beyond the invocation that proposed it.
   *
   * Recorded because VISION §8's timeout policy has three buckets, and only two
   * of them are about reversibility: "reversible -> auto-approve on timeout;
   * irreversible -> park and escalate; spends money -> deny on timeout". A
   * class can be perfectly reversible and still belong in the third bucket, so
   * `reversibility` alone cannot decide what silence means (#95, #98).
   */
  readonly spendsMoney: boolean;
}

/**
 * The closed union of class ids.
 *
 * Exhaustively switched on in the proposers, so adding a member is a
 * compile-time event everywhere it matters.
 */
export type ActionClassId =
  | 'run-diagnosis'
  | 're-dispatch'
  | 'decomposition'
  | 'issue-shaping'
  | 'spec-quality-feedback'
  | 'daily-brief'
  | 'quarantine-decision';

/**
 * The registry.
 *
 * Ordered by VISION §7's expected promotion order where that applies —
 * re-dispatch, decomposition, issue shaping, quarantine — with the classes the
 * vision does not rank placed by blast radius. The order is presentational; the
 * `id` is the identity.
 */
export const ACTION_CLASSES: readonly ActionClass[] = Object.freeze([
  Object.freeze({
    id: 'run-diagnosis',
    title: 'Run failure diagnosis',
    definition:
      'Narrate the probable root cause of a run that failed, was killed, or went silent, and name what would plausibly fix it.',
    effect:
      'Nothing outside the decision log. When surfaced on a run summary it is attributed as a hypothesis, never as a determined cause.',
    reversibility: 'reversible',
    autonomyEligible: true,
    hasProposer: true,
    // Narration. The only cost is the invocation that produced it.
    spendsMoney: false,
  }),
  Object.freeze({
    id: 're-dispatch',
    title: 'Re-dispatch after transient failure',
    definition:
      'Abandon a work order whose run failed for a cause judged transient and re-run it as a new attempt, per VISION §3.4.',
    effect:
      'A new work order row at attempt n+1, a new branch, and a runner invocation that spends quota.',
    reversibility: 'reversible-with-effort',
    autonomyEligible: true,
    hasProposer: false,
    // A runner invocation at attempt n+1, on the same quota the factory
    // is competing for.
    spendsMoney: true,
  }),
  Object.freeze({
    id: 'decomposition',
    title: 'Decomposition of an oversized work order',
    definition:
      'Split a work order that timed out, looped, or failed repeatedly into two or more smaller child issues, each with its own testable acceptance criteria.',
    effect:
      'Once promoted, new GitHub issues — created only through the gated issue-creation adapter, never directly.',
    reversibility: 'reversible-with-effort',
    autonomyEligible: true,
    hasProposer: true,
    // Child issues become dispatchable work orders, each with a runner
    // invocation behind it.
    spendsMoney: true,
  }),
  Object.freeze({
    id: 'issue-shaping',
    title: 'Issue shaping',
    definition:
      'Rewrite an under-specified issue into template-conformant form with testable acceptance criteria derived from its problem statement.',
    effect: 'Once promoted, an edit to the body of an existing GitHub issue.',
    reversibility: 'reversible-with-effort',
    autonomyEligible: true,
    hasProposer: true,
    // The edit itself is free; the reshaped issue is what gets dispatched,
    // and a shaped issue exists in order to be run.
    spendsMoney: true,
  }),
  Object.freeze({
    id: 'spec-quality-feedback',
    title: 'Spec-quality feedback',
    definition:
      'Correlate specification characteristics with run outcomes and report which issue shapes produced first-pass acceptance and which produced rework.',
    effect:
      'Nothing outside the decision log and the daily brief. It never blocks dispatch — the deterministic gate in #62 does that.',
    reversibility: 'reversible',
    autonomyEligible: true,
    hasProposer: true,
    spendsMoney: false,
  }),
  Object.freeze({
    id: 'daily-brief',
    title: 'Daily brief',
    definition:
      'Rank the last day of factory activity by what most needs an operator, and say why each item is ranked where it is.',
    effect:
      'A notification sent through the existing transport. No state changes.',
    reversibility: 'reversible',
    autonomyEligible: true,
    hasProposer: true,
    spendsMoney: false,
  }),
  Object.freeze({
    id: 'quarantine-decision',
    title: 'Quarantine decision',
    definition:
      'Place a work order in quarantine, or release one from it, on a judgement about whether a human still needs to look.',
    effect:
      'A work order stops being dispatchable, or resumes being dispatchable without a human having looked.',
    reversibility: 'reversible-with-effort',
    // VISION §7 ranks this last in the promotion order and annotates it
    // "probably never"; VISION §8 puts clearing quarantine on the
    // never-trustable list outright. The ineligibility is the vision's, not a
    // conservative reading of it.
    autonomyEligible: false,
    hasProposer: false,
    // Releasing a work order makes it dispatchable again rather than
    // dispatching it; the deterministic dispatcher decides that, and it is
    // the dispatch that spends.
    spendsMoney: false,
  }),
]);

/** Every class id, in registry order. The list validation and the API read. */
export const ACTION_CLASS_IDS: readonly ActionClassId[] = Object.freeze(
  ACTION_CLASSES.map((c) => c.id),
);

const BY_ID = new Map<string, ActionClass>(
  ACTION_CLASSES.map((c) => [c.id, c]),
);

/**
 * The boundary check.
 *
 * A narrowing predicate rather than a throw, so callers decide what an unknown
 * class means: the decision log rejects it, a read path rendering historical
 * rows may prefer to show it as-is.
 */
export function isActionClass(value: unknown): value is ActionClassId {
  return typeof value === 'string' && BY_ID.has(value);
}

/** The registry entry for an id, or `undefined` if nothing is registered. */
export function getActionClass(id: string): ActionClass | undefined {
  return BY_ID.get(id);
}

/**
 * Whether this class may ever be auto-executed.
 *
 * An UNKNOWN class is not eligible. Defaulting the other way would make a typo
 * in a class name a promotion path, which is the exact failure ADR-0011
 * disqualified free-form strings for.
 */
export function isAutonomyEligible(id: string): boolean {
  return BY_ID.get(id)?.autonomyEligible === true;
}

/**
 * Whether this class's approved effect spends money (VISION §8).
 *
 * An UNKNOWN class does not, matching `isAutonomyEligible`'s convention of
 * refusing to infer anything about an id it does not recognise. The two
 * defaults point the same way for the same reason: the caller that gets
 * `false` here is a timeout policy choosing between "deny" and "escalate", and
 * an unknown class should not be routed by a guess about its cost. It should
 * fail the `isActionClass` check at the boundary long before it reaches this.
 */
export function spendsMoney(id: string): boolean {
  return BY_ID.get(id)?.spendsMoney === true;
}
