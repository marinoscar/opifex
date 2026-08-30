/**
 * How a steering turn READS (#426, epic #419).
 *
 * The chat surface is a translator with a confirmation step in the middle, and
 * this module is the confirmation step's wording. It is a pure module for the
 * reason `config/queueSteering.ts` is one: the sentences an operator reads
 * before writing labels to somebody else's backlog are the feature, and
 * sentences that live in a pure function can be asserted directly instead of
 * through a render.
 *
 * ## The diff is the content; the prose is a caption on it
 *
 * A reply saying "sure, those three are ready now" while seventeen issues
 * quietly lose `factory:ready` is worse than no chat at all — #426 says so in
 * as many words, and it is the failure this file is organised against. So:
 *
 *  - Removals are never folded into additions, never summarised into a clause,
 *    and never rendered as the quiet half of a pair. `add` and `remove` stay
 *    two fields from the API's DTO to the chip on screen.
 *  - The blast radius is stated BEFORE the operations, from
 *    `blastRadius` — data the API computes, not a count this file re-derives
 *    from a list it might be filtering.
 *  - `named` splits the operations into what was ASKED FOR and what that
 *    IMPLIES, because seventeen collateral un-readies rendered identically to
 *    three named readies is the same hiding done with a list instead of a
 *    sentence.
 *
 * ## Nothing here applies anything
 *
 * There is no path in this module or the components over it from an
 * instruction to a write. Propose renders; a human presses a second button.
 * An exception for "obviously simple" instructions is how a confirmation step
 * becomes decoration, and a chat that can write without one is the second
 * controller epic #419 exists to not build.
 *
 * ## One vocabulary for the kill switch
 *
 * `WRITES_DISABLED_FACT` is imported from `queueSteering.ts` rather than
 * restated. Two screens describing `github.writesEnabled` in two different
 * sentences is how an operator learns that "recorded, not performed" means
 * something different depending on where they read it.
 */

import { WRITES_DISABLED_FACT } from './queueSteering';
import type {
  AppliedOperation,
  LabelDrift,
  SkippedOperation,
  SteeringApplyResult,
  SteeringOperation,
  SteeringProposal,
} from '../types/steering';

/**
 * The proposal TTL, mirroring `PROPOSAL_TTL_MINUTES` in the API's steering DTO.
 *
 * Duplicated here only to say when a proposal is about to go stale BEFORE the
 * apply fails; the authority is still the server, which answers 409 and is the
 * only thing that decides. `__tests__/config/settingKeyDrift.test.ts` reads the
 * API's source and pins the two together.
 */
export const PROPOSAL_TTL_MINUTES = 30;

/** Under this many minutes left, the expiry is said out loud rather than shown. */
const EXPIRY_WARNING_MINUTES = 5;

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

// ---------------------------------------------------------------------------
// The instruction, before it is sent
// ---------------------------------------------------------------------------

/** `instruction` is `min(1).max(2000)` on the wire; the box says so first. */
export const INSTRUCTION_MAX_LENGTH = 2000;

/**
 * What the deterministic parser can do without a model, said where an operator
 * is deciding what to type rather than after their sentence has failed.
 */
export const INSTRUCTION_EXAMPLES = [
  'only work on #1, #2 and #3',
  'hold #14',
  'work on epic #419 and hold everything else',
] as const;

// ---------------------------------------------------------------------------
// Expiry — said before it happens, not discovered on apply
// ---------------------------------------------------------------------------

export interface ExpiryNotice {
  expired: boolean;
  /** Negative once expired. Whole minutes, rounded down. */
  minutesRemaining: number;
  /** Whether to say it loudly: nearly stale, or already. */
  urgent: boolean;
  text: string;
}

/**
 * How long this proposal has left.
 *
 * `now` is a parameter rather than a `Date.now()` inside, so the sentence is
 * testable without faking a clock — and so a component that re-renders is the
 * only thing that decides when this is recomputed.
 */
export function expiryNotice(expiresAt: string, now: Date): ExpiryNotice {
  const remainingMs = new Date(expiresAt).getTime() - now.getTime();
  const minutesRemaining = Math.floor(remainingMs / 60_000);

  if (remainingMs <= 0) {
    return {
      expired: true,
      minutesRemaining,
      urgent: true,
      text:
        `This proposal is older than ${PROPOSAL_TTL_MINUTES} minutes and can no ` +
        'longer be applied. Ask for it again: the backlog it was computed ' +
        'against has had that long to move.',
    };
  }

  return {
    expired: false,
    minutesRemaining,
    urgent: minutesRemaining < EXPIRY_WARNING_MINUTES,
    text:
      `This proposal expires in ${plural(minutesRemaining, 'minute')}. It was ` +
      'computed against the backlog as it stood, so after that it has to be ' +
      'asked for again rather than applied late.',
  };
}

// ---------------------------------------------------------------------------
// How the instruction was read
// ---------------------------------------------------------------------------

export interface InterpretationNotice {
  /** Information, not a fault. See below. */
  severity: 'info';
  title: string;
  /** The paragraphs, in reading order. Each rendered as its own line. */
  body: string[];
  /** What the operator can do about it, right now, with today's deployment. */
  remedy: string;
}

/**
 * What to say about an instruction the parser could not read.
 *
 * Null on the deterministic path: there is nothing to explain when the parse
 * worked, and a "we understood you" banner over a diff the operator can read
 * for themselves is noise.
 *
 * ## Why `severity: 'info'`
 *
 * `needs-interpretation` is the ORDINARY answer for prose today. The model
 * path is refused on purpose — the steering chat has no spend ceiling, and
 * `chat-spend-gate.ts` refuses rather than running a metered consumer with no
 * cumulative bound — so "just the auth epic" not resolving is the system
 * working as designed. Colouring it as an error would teach an operator to
 * read a real failure as more of the same, and would describe a deliberate
 * refusal as a fault.
 *
 * ## Why the two reasons are told apart
 *
 * "No model is configured" and "a model is configured and the spend gate
 * refused" call for completely different actions — one is a Control Center
 * field, the other is an unbuilt ledger — and they are reported together for
 * the reason `chat-spend-gate.ts` gives: an operator who configures
 * `chat.model.name` to fix the second would otherwise find nothing changed and
 * have no way to discover the first.
 */
export function interpretationNotice(
  proposal: SteeringProposal,
): InterpretationNotice | null {
  const { interpretation } = proposal;
  if (interpretation.method === 'deterministic') return null;

  const body: string[] = [
    interpretation.ambiguity ??
      'The instruction could not be read without interpretation.',
  ];

  const { spend, model } = interpretation;

  if (spend !== null && !spend.admitted) {
    // Verbatim: it is the API's own sentence and names the reason a model was
    // not asked, which is a decision rather than a fault of this deployment.
    body.push(`No model was asked. ${spend.reason}`);
  }

  if (model !== null && !model.available) {
    body.push(
      'No chat model is configured on this deployment either' +
        (model.unavailableReason ? `: ${model.unavailableReason}` : '.'),
    );
  } else if (model !== null) {
    body.push(
      `A chat model is configured (${model.provider} / ${model.model}) and ` +
        'could have answered. It was not asked: the refusal above is what ' +
        'stopped it, not the configuration.',
    );
  }

  return {
    severity: 'info',
    title: 'This needs interpretation, so nothing was proposed for it',
    body,
    remedy:
      'Name the issues explicitly and no model is needed at all — ' +
      '`only work on #1, #2 and #3`, `hold #14`, `work on epic #419 and hold ' +
      'everything else`. Those are parsed in code, which is why they work on ' +
      'a deployment with no chat model at all.',
  };
}

/** The unresolved references that are NOT the "we could not read it" one. */
export function resolutionFailures(proposal: SteeringProposal) {
  return proposal.unresolved.filter(
    (entry) => entry.reason !== 'needs-interpretation',
  );
}

// ---------------------------------------------------------------------------
// The diff
// ---------------------------------------------------------------------------

/** An operation that would write something. The rest change nothing. */
export function isChanging(operation: SteeringOperation): boolean {
  return operation.add.length > 0 || operation.remove.length > 0;
}

export interface PartitionedOperations {
  /** Issues the operator named, that will change. */
  named: SteeringOperation[];
  /** Issues the instruction did NOT name, that will change anyway. */
  collateral: SteeringOperation[];
  /** Named or not, already in the state asked for. Shown, never counted. */
  unchanged: SteeringOperation[];
}

/**
 * Split the operations the way the confirmation has to read them.
 *
 * The collateral set is the reason this feature has a confirmation step at
 * all: an "only" clause takes `factory:ready` off issues nobody typed, and a
 * flat list would put those seventeen in among the three that were asked for.
 */
export function partitionOperations(
  operations: readonly SteeringOperation[],
): PartitionedOperations {
  const changing = operations.filter(isChanging);
  return {
    named: changing.filter((operation) => operation.named),
    collateral: changing.filter((operation) => !operation.named),
    unchanged: operations.filter((operation) => !isChanging(operation)),
  };
}

export interface BlastRadiusHeadline {
  severity: 'info' | 'warning';
  title: string;
  body: string[];
}

/**
 * The sentence over the diff, from the API's own counts.
 *
 * `blastRadius` is read rather than recomputed from `operations`, deliberately:
 * the API computes it over the whole proposal and this screen may be showing a
 * narrowed selection, and a headline derived from what is currently ticked
 * would shrink as the operator un-ticks things — turning the statement of what
 * the instruction MEANS into a running total of what is left.
 */
export function blastRadiusHeadline(
  proposal: SteeringProposal,
): BlastRadiusHeadline {
  const radius = proposal.blastRadius;

  if (radius.issuesAffected === 0) {
    return {
      severity: 'info',
      title: 'Nothing would change',
      body: [radius.summary],
    };
  }

  const body = [radius.summary];

  if (radius.collateral > 0) {
    body.push(
      `${plural(radius.collateral, 'issue')} the instruction did not name ` +
        'would change anyway. They are listed separately below, under ' +
        'collateral.',
    );
  }

  if (radius.destructive) {
    body.push(
      `${plural(radius.labelsRemoved, 'label')} would be REMOVED. Removing ` +
        'factory:ready discards intent somebody set deliberately, and no ' +
        'label is written until this is confirmed.',
    );
  }

  return {
    severity: radius.destructive ? 'warning' : 'info',
    // Additions and removals in one sentence, in that order, always both
    // present — a headline that named only what it adds is exactly the reply
    // #426 calls worse than no chat at all.
    title:
      `${plural(radius.issuesAffected, 'issue')} affected: ` +
      `${plural(radius.labelsAdded, 'label')} added, ` +
      `${plural(radius.labelsRemoved, 'label')} removed`,
    body,
  };
}

/** One line under an issue, saying why it is in the diff at all. */
export function operationSummary(operation: SteeringOperation): string {
  return operation.reason;
}

// ---------------------------------------------------------------------------
// The result
// ---------------------------------------------------------------------------

/**
 * What happened to ONE issue.
 *
 * The kinds are `queueSteering.ts`'s where they mean the same thing —
 * `written` and `suppressed` are the same two facts about the same kill
 * switch — plus the two a bulk steer has no equivalent for: an operation that
 * needed no write, and one the server skipped because the issue moved under
 * the proposal.
 */
export type SteeringOutcome =
  | { kind: 'written'; ref: string; operation: AppliedOperation }
  | { kind: 'suppressed'; ref: string; operation: AppliedOperation }
  | { kind: 'unchanged'; ref: string; operation: AppliedOperation }
  | { kind: 'skipped'; ref: string; skipped: SkippedOperation };

export function classifyApplied(operation: AppliedOperation): SteeringOutcome {
  const performed = operation.writes.filter((write) => write.performed);

  if (performed.length === 0 && operation.writes.length > 0) {
    // `github-write.service.ts` answers `performed: false, noop: false` when
    // the kill switch is off. Nothing reached GitHub.
    return { kind: 'suppressed', ref: operation.ref, operation };
  }

  if (performed.every((write) => write.noop)) {
    return { kind: 'unchanged', ref: operation.ref, operation };
  }

  return { kind: 'written', ref: operation.ref, operation };
}

/**
 * Every issue in the answer, applied and skipped alike, in one list.
 *
 * Skipped operations are NOT a separate report to be scrolled to. An operator
 * reading what happened to nineteen issues needs the twentieth that did not,
 * in the same list and in the same shape.
 */
export function applyOutcomes(result: SteeringApplyResult): SteeringOutcome[] {
  return [
    ...result.applied.map(classifyApplied),
    ...result.skipped.map((skipped): SteeringOutcome => ({
      kind: 'skipped',
      ref: skipped.ref,
      skipped,
    })),
  ];
}

/** `factory:ready added, factory:hold removed` — both halves, always. */
export function labelChangeLine(add: string[], remove: string[]): string {
  const parts: string[] = [];
  if (add.length > 0) parts.push(`${add.join(', ')} added`);
  if (remove.length > 0) parts.push(`${remove.join(', ')} removed`);
  return parts.length > 0 ? parts.join(', ') : 'no label change';
}

/** How one drifted label moved, in the operator's terms. */
export function driftLine(drift: LabelDrift): string {
  if (drift.wasPresent && !drift.isPresent) {
    return `${drift.label} was on the issue when this was proposed and is not now.`;
  }
  if (!drift.wasPresent && drift.isPresent) {
    return `${drift.label} was added to the issue after this was proposed.`;
  }
  return `${drift.label} changed after this was proposed.`;
}

/** The line under one issue in the result. */
export function outcomeLine(outcome: SteeringOutcome): string {
  if (outcome.kind === 'skipped') {
    return outcome.skipped.detail;
  }

  const changes = labelChangeLine(
    outcome.operation.add,
    outcome.operation.remove,
  );

  if (outcome.kind === 'suppressed') {
    return `${changes} — not written. ${WRITES_DISABLED_FACT}`;
  }

  if (outcome.kind === 'unchanged') {
    return (
      `${changes} — the issue was already in that state, so nothing was ` +
      'written for it.'
    );
  }

  return `${changes} — written. The next reconciler tick acts on it.`;
}

export interface ApplyHeadline {
  severity: 'success' | 'info' | 'warning' | 'error';
  title: string;
  body: string;
}

/**
 * The headline over a finished apply.
 *
 * Every count is out of what was REQUESTED, so a partial application cannot be
 * read as a whole one — `queueSteering.ts`'s rule, and for the same reason:
 * eleven that landed are what the operator asked for and are not undone
 * because the twelfth drifted.
 *
 * The suppressed case is checked first and taken on its own terms. A run in
 * which every request answered 202 and no label was written is not a success,
 * and it is not a failure either.
 */
export function applyHeadline(result: SteeringApplyResult): ApplyHeadline {
  const { summary } = result;
  const requested = summary.operationsRequested;

  if (summary.labelWrites > 0 && summary.labelWritesPerformed === 0) {
    return {
      severity: 'warning',
      title:
        `Nothing was written for any of the ${plural(requested, 'operation')}: ` +
        'GitHub writes are disabled',
      body:
        `${WRITES_DISABLED_FACT} The proposal is still on screen: enable ` +
        'github.writesEnabled and confirm again while it is valid, or apply ' +
        'the labels on GitHub by hand.',
    };
  }

  if (summary.operationsApplied === 0) {
    return {
      severity: 'error',
      title: `Nothing was applied — 0 of ${requested} operations`,
      body:
        'Every operation is listed below with the reason it was skipped. ' +
        'Nothing was written, and nothing about the proposal was lost — an ' +
        'issue skipped for drift is one whose labels moved since this was ' +
        'proposed, so ask again to see the current picture.',
    };
  }

  if (summary.operationsSkipped > 0) {
    return {
      severity: 'warning',
      title:
        `${summary.operationsApplied} of ${requested} operations applied — ` +
        `${summary.operationsSkipped} skipped`,
      body:
        `${result.effect} The ${summary.operationsApplied} that landed stay ` +
        'landed: they are what was asked for, and undoing them to make this ' +
        'answer tidy would throw them away. Each skipped issue is below with ' +
        'its own reason.',
    };
  }

  return {
    severity: 'success',
    title:
      `${plural(summary.operationsApplied, 'operation')} applied — ` +
      `${plural(summary.labelWritesPerformed, 'label write')} performed`,
    body: `${result.effect} Nothing on the queue changes until that tick runs.`,
  };
}

// ---------------------------------------------------------------------------
// Refusals of the apply call itself
// ---------------------------------------------------------------------------

export interface ApplyRefusal {
  /** Names the situation. Never "Error". */
  title: string;
  remedy: string;
  /** True for the one refusal that is answered by asking again. */
  stale: boolean;
}

/**
 * The API's documented refusals of `POST /steering/proposals/apply`.
 *
 * The 409 is the one that matters and it is NOT a failure: a proposal is a
 * picture of a backlog at a moment, and thirty minutes later it is a picture
 * of a backlog that has had thirty minutes to move. It reads as "ask again",
 * with the instruction kept so asking again is one press.
 */
export function applyRefusal(
  status: number | null,
  detail: string,
): ApplyRefusal {
  if (status === 409) {
    return {
      title: 'This proposal is stale — nothing was written',
      remedy:
        `A proposal may be applied for ${PROPOSAL_TTL_MINUTES} minutes. This ` +
        'one is older, so the API refused it rather than writing labels ' +
        'against a picture of the backlog that has had longer than that to ' +
        'move. Propose the same instruction again and the diff will be ' +
        'computed against what is there now.',
      stale: true,
    };
  }

  if (status === 403) {
    return {
      title: 'This account may not apply a steering proposal',
      remedy:
        'Applying needs workorders:write and an interactive session. A ' +
        'personal access token or a device-flow token is refused here on ' +
        'purpose: a confirmation a script can send is not a confirmation. ' +
        `The API's own answer: ${detail}`,
      stale: false,
    };
  }

  if (status === 401) {
    return {
      title: 'The session was not accepted',
      remedy:
        'The access token was refused and could not be refreshed. Sign in ' +
        'again; nothing was written.',
      stale: false,
    };
  }

  return {
    title: 'The proposal was not applied',
    remedy: `No label was written. The API's own answer: ${detail}`,
    stale: false,
  };
}

/** The refusals of PROPOSE, which writes nothing whatever happens. */
export function proposeRefusal(
  status: number | null,
  detail: string,
): ApplyRefusal {
  if (status === 404) {
    return {
      // A repository OR a project since ADR-0020: `requireRegistered` and the
      // project lookup answer the same status for the same kind of mistake —
      // a request naming something Opifex does not know about. The API's own
      // sentence below says which one, so this title stops at the shape.
      title: 'That scope is not something Opifex knows about',
      remedy:
        'Steering only reaches repositories Opifex observes, and only ' +
        'projects that exist. If the scope picker offered it a moment ago, ' +
        'it has been retired or deleted since — reload the screen to see ' +
        `what is really there. The API's own answer: ${detail}`,
      stale: false,
    };
  }

  if (status === 403) {
    return {
      title: 'This account may not propose a steer',
      remedy:
        'Proposing needs workorders:write — the same permission hold and ' +
        'release need, because a proposal reads a whole backlog to compute a ' +
        'blast radius and is of no use to somebody who could not apply it. ' +
        'Nothing was written.',
      stale: false,
    };
  }

  return {
    title: 'No proposal could be computed',
    remedy: `Nothing was written. The API's own answer: ${detail}`,
    stale: false,
  };
}
