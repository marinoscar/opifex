/**
 * The repository enablement ladder (#350, epic #332).
 *
 * `apps/api/src/repositories/dto/repository.dto.ts` documents the four
 * per-repository flags as a deliberate PROGRESSION, not four unrelated
 * checkboxes:
 *
 *   observeEnabled → mirrorLabelsEnabled → specFeedbackEnabled → dispatchEnabled
 *
 * The ordering is the whole point. VISION §12's observation week has to end
 * one repository at a time — a global switch is the unsafe way to do it — and
 * in stages: read first, then write a label, then write prose to a human, then
 * run. Rendering them as an unordered set of switches would lose the one thing
 * their design was for, which is why this module exists at all rather than the
 * component looping over four booleans.
 *
 * ## Out of order warns, and does not block
 *
 * `ladderWarnings` reports a rung that is on while something below it is off;
 * `warningsIntroducedBy` narrows that to the rungs a pending save is turning
 * on. The section warns on the second set before writing and then writes
 * anyway if the operator says so. Refusing would be worse: the API accepts
 * these combinations, an operator may have a reason (dispatch into a
 * repository whose labels are managed elsewhere), and a UI that refuses is a
 * UI they route around with curl — which is the exact situation #350 exists
 * to end.
 *
 * ## Pure, for the same reason `config/readiness.ts` is
 *
 * The interesting cases — dispatch on with observe off, a ceiling of `0`, a
 * ceiling above the API's own maximum — are then testable without a React tree
 * or a server, and the component is left with nothing to decide.
 */

/** The four flags, by their `UpdateRepositoryDto` names. */
export type LadderRungKey =
  | 'observeEnabled'
  | 'mirrorLabelsEnabled'
  | 'specFeedbackEnabled'
  | 'dispatchEnabled';

export interface LadderRung {
  key: LadderRungKey;
  /** 1-based, and this is the order the operator climbs them in. */
  ordinal: number;
  title: string;
  /** What turning it ON permits. Stated as a capability, not as a label. */
  permits: string;
  /**
   * Why this is its own rung rather than folded into the one below it. Drawn
   * from the DTO's own reasoning, because a switch whose separateness is
   * unexplained gets flipped as a set.
   */
  separateBecause: string;
  /** Whether Opifex WRITES anywhere outside itself once this is on. */
  writesToGitHub: boolean;
  /** The rung directly beneath. Null for the first. */
  requires: LadderRungKey | null;
}

export const LADDER_RUNGS: readonly LadderRung[] = [
  {
    key: 'observeEnabled',
    ordinal: 1,
    title: 'Observe',
    permits:
      'The reconciler reads this repository on each tick — issues, labels and ' +
      'pull requests — and projects eligible issues into work orders.',
    separateBecause:
      'Reading is the only rung that changes nothing in the repository. ' +
      'Everything above it writes somewhere.',
    writesToGitHub: false,
    requires: null,
  },
  {
    key: 'mirrorLabelsEnabled',
    ordinal: 2,
    title: 'Mirror labels',
    permits:
      'Opifex may write `factory/*` labels back onto issues here, so the ' +
      'state it computed is visible in GitHub itself.',
    separateBecause:
      'Not folded into dispatch, so the first WRITE and the first RUN are ' +
      'not the same flag flip. Proving the write path before anything ' +
      'executes is what doing labels first is for.',
    writesToGitHub: true,
    requires: 'observeEnabled',
  },
  {
    key: 'specFeedbackEnabled',
    ordinal: 3,
    title: 'Spec feedback',
    permits:
      'Opifex may comment on an issue to explain why its spec was rejected ' +
      '(#155) — unsolicited prose, addressed to a human, on their issue.',
    separateBecause:
      'A mirror label restates a status the operator already asked to see. ' +
      'This is a different kind of write, so turning on labels is not a ' +
      'request to start giving people feedback.',
    writesToGitHub: true,
    requires: 'mirrorLabelsEnabled',
  },
  {
    key: 'dispatchEnabled',
    ordinal: 4,
    title: 'Dispatch',
    permits:
      'Work orders for this repository may be sent to a runner: a branch, a ' +
      'Claude Code session, commits and a pull request. This is where money ' +
      'is spent.',
    separateBecause:
      'Per-repository dispatch is how the observation week ends — one ' +
      'repository at a time. A single global switch would leave no other way.',
    writesToGitHub: true,
    requires: 'specFeedbackEnabled',
  },
];

/** The four flags of one repository, as the ladder reads them. */
export type LadderState = Record<LadderRungKey, boolean>;

export interface LadderWarning {
  rung: LadderRung;
  /** The rungs beneath it that are off, lowest first. */
  missing: LadderRung[];
  /** The sentence shown to the operator. */
  message: string;
}

function rung(key: LadderRungKey): LadderRung {
  // Non-null by construction: `LADDER_RUNGS` covers every `LadderRungKey`, and
  // `rungsBelow`'s test asserts it rather than trusting the type.
  return LADDER_RUNGS.find((entry) => entry.key === key) as LadderRung;
}

/** Every rung below this one, lowest first. */
export function rungsBelow(key: LadderRungKey): LadderRung[] {
  return LADDER_RUNGS.filter((entry) => entry.ordinal < rung(key).ordinal);
}

/**
 * Every rung that is on with something below it off.
 *
 * ALL the rungs below, not only the one directly beneath: dispatch with
 * observation off is the combination worth naming loudest, and a check that
 * only looked one step down would pass it silently as long as spec feedback
 * happened to be on.
 */
export function ladderWarnings(state: LadderState): LadderWarning[] {
  return LADDER_RUNGS.filter((entry) => state[entry.key])
    .map((entry) => {
      const missing = rungsBelow(entry.key).filter(
        (below) => !state[below.key],
      );
      return { rung: entry, missing, message: describe(entry, missing) };
    })
    .filter((warning) => warning.missing.length > 0);
}

/**
 * Only the rungs THIS save turns on out of order.
 *
 * A repository already sitting in an out-of-order state is worth showing on
 * screen — `ladderWarnings` does that — but re-asking about it every time the
 * operator edits an unrelated field would train them to click through the
 * dialog, which is how a confirmation stops being one.
 */
export function warningsIntroducedBy(
  stored: LadderState,
  draft: LadderState,
): LadderWarning[] {
  return ladderWarnings(draft).filter(
    (warning) => !stored[warning.rung.key] && draft[warning.rung.key],
  );
}

function describe(entry: LadderRung, missing: LadderRung[]): string {
  const names = missing.map((below) => below.title.toLowerCase());
  const list =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

  return (
    `${entry.title} is on with ${list} off. The API accepts this, so it is ` +
    'a warning rather than a refusal — but the ladder is ordered because ' +
    'each rung is meant to be proven before the one above it.'
  );
}

/** Are any rungs on at all? Used to say what a repository is allowed today. */
export function highestEnabledRung(state: LadderState): LadderRung | null {
  const enabled = LADDER_RUNGS.filter((entry) => state[entry.key]);
  return enabled.length > 0 ? enabled[enabled.length - 1] : null;
}

/**
 * The API's own bounds on `budgetCeilingUsd`, checked here so an invalid
 * ceiling is a field error rather than a 400 the operator has to interpret.
 *
 * Empty means CLEAR — `null` on the wire, "no per-repository ceiling" in
 * words. That is deliberately not the same as `0`, which the API rejects
 * (`positive()`) and which would otherwise read as "never spend anything"
 * while actually meaning the request failed.
 */
export const BUDGET_CEILING_MAX_USD = 10000;

export type BudgetCeilingParse =
  { ok: true; value: number | null } | { ok: false; error: string };

export function parseBudgetCeiling(input: string): BudgetCeilingParse {
  const trimmed = input.trim();
  if (trimmed === '') return { ok: true, value: null };

  const value = Number(trimmed);
  if (!Number.isFinite(value)) {
    return { ok: false, error: 'Enter an amount in USD, or leave it empty.' };
  }
  if (value <= 0) {
    return {
      ok: false,
      error:
        'The ceiling must be greater than zero. Clear the field to remove ' +
        'the per-repository ceiling instead.',
    };
  }
  if (value > BUDGET_CEILING_MAX_USD) {
    return {
      ok: false,
      error: `The API caps a per-run ceiling at $${BUDGET_CEILING_MAX_USD}.`,
    };
  }

  return { ok: true, value };
}

/**
 * Has the ceiling changed?
 *
 * The stored value is a STRING (a Postgres `DECIMAL`, kept as text so a spend
 * ceiling is never rounded through a JS number) and the draft is a number, so
 * `'50.00'` and `50` are the same ceiling and must not produce a PATCH.
 */
export function ceilingChanged(
  stored: string | null,
  draft: number | null,
): boolean {
  if (stored === null) return draft !== null;
  if (draft === null) return true;
  return Number(stored) !== draft;
}
