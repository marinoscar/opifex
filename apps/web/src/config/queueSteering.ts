/**
 * How a BULK steer is reported (#421).
 *
 * The queue screen could hold and release one row at a time, so "only work on
 * these three" meant opening seventeen issues and editing a label on each —
 * which nobody does, which is how a backlog stops being steered at all. The
 * fix is a selection and two buttons over the operations that already exist:
 * no new state, no second control surface, the same `factory:hold` and
 * `factory:ready` labels written one work order at a time.
 *
 * This module is the presentation half, kept out of the component for the same
 * reason `config/availableRepositories.ts` is — the wording is the feature, and
 * wording that lives in a pure function can be asserted directly.
 *
 * ## Three outcomes, not two
 *
 * A steer can be **written**, **suppressed** or **refused**, and collapsing the
 * middle one into either of its neighbours is the single worst thing this
 * screen could do.
 *
 * `POST /queue/:id/hold` answers **`202 Accepted`**
 * (`queue.controller.ts`: `@HttpCode(HttpStatus.ACCEPTED)`) with
 * `labelWritten: false` when `github.writesEnabled` is off: the request
 * succeeded, the audit event was recorded, and **no label reached GitHub**, so
 * no reconciler tick will ever act on it.
 *
 * The status cannot tell those apart, and is not asked to. 202 is the same 202
 * either way — it says the request was accepted, which is true of a suppressed
 * write as much as of a written one, and it deliberately says nothing about the
 * label or the tick. Treating that 202 as success would put "3 work orders
 * marked ready" on screen when nothing was written — the exact failure this
 * codebase is organised against — and treating it as an error would be wrong
 * the other way, since the request WAS accepted and nothing is broken. So the
 * whole decision rests on `labelWritten`, and the suppressed case is its own
 * outcome with its own sentence and its own remedy.
 *
 * ## Partial application is the ORDINARY result
 *
 * Fifteen label writes are sometimes eleven successes and four refusals.
 * Nothing here rolls anything back, nothing here reports a mixed result as a
 * finished one, and the count in every headline is out of the total attempted.
 * The eleven that landed are what the operator asked for.
 *
 * ## Hold and release are not symmetric
 *
 * Releasing a HELD work order re-stamps `queuedAt`
 * (`work-order-projection.service.ts`: `{ status: 'queued', queuedAt: new
 * Date() }`), so it re-enters at the BACK of the queue rather than at the
 * position it left from. A hold, by contrast, nulls `queuedAt` and the row
 * stays visible. Any wording that implied a release restores a position would
 * be a promise the projection does not keep.
 *
 * ## Release does not clear a quarantine
 *
 * `factory:clear-quarantine` must be applied by a human on GitHub, where the
 * applier's identity is native and verifiable (VISION §8, #49). Writing
 * `factory:ready` to a quarantined work order does not unstick it, and a bulk
 * release must not read as though a hundred of them could be freed at once.
 */

import type { QueueSteerResult } from '../services/api';

export type SteerIntent = 'hold' | 'release';

/** Why one steer was refused. `status` is how the refusals are told apart. */
export interface SteerFailure {
  /** The HTTP status, or null when the request never got one. */
  status: number | null;
  /** The API's own message, rendered verbatim. */
  detail: string;
}

/**
 * What happened to ONE work order.
 *
 * The unit of the answer is the work order, because that is the unit the
 * operator selected in. There is deliberately no shape here for "the batch
 * failed": a batch is a list of what each row did.
 */
export type SteerOutcome =
  | { kind: 'written'; workOrderId: string; identity: string; label: string }
  | { kind: 'suppressed'; workOrderId: string; identity: string; label: string }
  | {
      kind: 'refused';
      workOrderId: string;
      identity: string;
      failure: SteerFailure;
    };

/**
 * One API answer, classified.
 *
 * `labelWritten` is the whole decision, and it is read from the response rather
 * than inferred from the HTTP status. A suppressed write is a `202`, exactly
 * like a written one; the status is not a discriminator and never was.
 *
 * `workOrderId` is the id that was SENT, not `result.workOrderId`. The queue
 * gives each row its identity (`queue.service.ts` sets `workOrder.id` from
 * `row.identity`) and the steer endpoints accept either that or the database
 * row id, which is what they answer with. The selection is keyed on what the
 * rows are keyed on, so the sent id is the one that has to come back — taking
 * the response's would leave every steered row selected forever.
 */
export function classifyResult(
  workOrderId: string,
  result: QueueSteerResult,
): SteerOutcome {
  return {
    kind: result.labelWritten ? 'written' : 'suppressed',
    workOrderId,
    identity: result.identity,
    label: result.label,
  };
}

export function writtenOutcomes(
  outcomes: readonly SteerOutcome[],
): SteerOutcome[] {
  return outcomes.filter((outcome) => outcome.kind === 'written');
}

export function suppressedOutcomes(
  outcomes: readonly SteerOutcome[],
): SteerOutcome[] {
  return outcomes.filter((outcome) => outcome.kind === 'suppressed');
}

export function refusedOutcomes(
  outcomes: readonly SteerOutcome[],
): SteerOutcome[] {
  return outcomes.filter((outcome) => outcome.kind === 'refused');
}

/**
 * The work orders that should STAY selected after a run.
 *
 * Everything whose label did not reach GitHub — the refusals and the
 * suppressed writes alike. A retry then re-sends exactly what has not worked
 * yet, and re-sending a label that already landed is impossible. The
 * suppressed ones belong here for the plainest of reasons: nothing was
 * written, so there is nothing to retry *except* them once writes are back on.
 */
export function unappliedIds(outcomes: readonly SteerOutcome[]): string[] {
  return outcomes
    .filter((outcome) => outcome.kind !== 'written')
    .map((outcome) => outcome.workOrderId);
}

/** `mark ready` / `hold`, in the operator's words rather than the endpoint's. */
export function intentVerb(intent: SteerIntent): string {
  return intent === 'hold' ? 'hold' : 'mark ready';
}

/** The label the intent writes. */
export function intentLabel(intent: SteerIntent): string {
  return intent === 'hold' ? 'factory:hold' : 'factory:ready';
}

// ---------------------------------------------------------------------------
// Refusals — real states, told apart by status
// ---------------------------------------------------------------------------

export interface SteerRefusal {
  /** The heading. Names the situation, never "Error". */
  title: string;
  /** What to do about it. The API's own detail is rendered verbatim beside it. */
  remedy: string;
}

/**
 * The API's documented refusals.
 *
 * A row offered a moment ago can be refused now: the queue is polled, and a
 * work order can leave it between the render and the click. Presenting that as
 * impossible would leave the operator with a silent failure.
 */
export function steerRefusal(
  status: number | null,
  identity: string,
): SteerRefusal {
  if (status === 404) {
    return {
      title: `${identity} is no longer a work order the API knows`,
      remedy:
        'The queue is polled, so a row can leave it between being drawn and ' +
        'being clicked — dispatched, closed, or re-projected under a new ' +
        'identity. Nothing was written for it. The refreshed queue below is ' +
        'the current one.',
    };
  }

  if (status === 403) {
    return {
      title: 'This account may not steer the queue',
      remedy:
        'Hold and release need workorders:write, which is a different ' +
        'permission from the one that reads the queue. This is a fact about ' +
        'the account, not about the work order.',
    };
  }

  if (status === 401) {
    return {
      title: 'The session was not accepted',
      remedy:
        'The access token was refused and could not be refreshed. Sign in ' +
        'again; nothing was written.',
    };
  }

  return {
    title: `${identity} could not be steered`,
    remedy:
      'The API refused the write and its own answer is below. No label was ' +
      'written for this work order, and the ones around it were still ' +
      'attempted.',
  };
}

/**
 * The remedies for a run's refusals, deduplicated, in first-seen order.
 *
 * A remedy is a fact about the KIND of refusal, never about which work order
 * hit it, so six 403s earn one sentence rather than six copies of it.
 */
export function refusalRemedies(outcomes: readonly SteerOutcome[]): string[] {
  const seen = new Set<string>();

  for (const outcome of refusedOutcomes(outcomes)) {
    if (outcome.kind !== 'refused') continue;
    seen.add(steerRefusal(outcome.failure.status, outcome.identity).remedy);
  }

  return [...seen];
}

// ---------------------------------------------------------------------------
// The per-row line, and the headline over the whole run
// ---------------------------------------------------------------------------

/** What one row of the report says under the work order's name. */
export function outcomeLine(
  outcome: SteerOutcome,
  intent: SteerIntent,
): string {
  if (outcome.kind === 'written') {
    // The release arm carries the asymmetry, because this is the line the
    // operator reads immediately after asking for one. `queuedAt` is
    // re-stamped when a hold lifts, so the work order rejoins at the back.
    return intent === 'hold'
      ? `${outcome.label} written. The next reconciler tick holds it and it ` +
          'loses its queue time; nothing is held yet.'
      : `${outcome.label} written. The next reconciler tick queues it at the ` +
          'BACK of the queue, not at the position it held before; nothing is ' +
          'ready yet.';
  }

  if (outcome.kind === 'suppressed') {
    return (
      'Not written. The request was accepted and recorded, and ' +
      `${outcome.label} never reached GitHub because writes are disabled on ` +
      `this deployment — no tick will ${intentVerb(intent)} it.`
    );
  }

  const refusal = steerRefusal(outcome.failure.status, outcome.identity);
  return `${refusal.title}. ${outcome.failure.detail}`;
}

export interface BulkPresentation {
  severity: 'success' | 'info' | 'warning' | 'error';
  title: string;
  body: string;
}

/** The one sentence every written steer is owed: the label is the request. */
const NEXT_TICK =
  'The label is the request; the reconciler acts on it on the next tick. ' +
  'Nothing on this screen changes until that tick has run.';

/**
 * The fact itself, with nothing about the queue in it.
 *
 * Split out so the steering chat (#426) states the SAME fact in the SAME
 * words rather than inventing a second sentence for one kill switch — the
 * thing `steering.dto.ts` calls "a second vocabulary for recorded, not
 * performed". What follows it below is the queue's own remedy, which is about
 * a selection the chat does not have.
 */
export const WRITES_DISABLED_FACT =
  'GitHub writes are disabled on this deployment, so the intent was recorded ' +
  'and no label was written. No reconciler tick will act on it.';

/** Said whenever anything at all was suppressed. Never softened. */
const WRITES_DISABLED =
  `${WRITES_DISABLED_FACT} These work ` +
  'orders are still selected: enable github.writesEnabled and try again, or ' +
  'apply the label on GitHub by hand.';

/**
 * The headline over a finished run.
 *
 * Every count is out of the total attempted, so a partial application cannot
 * be read as a whole one. The suppressed case is checked FIRST and taken on
 * its own terms: a run in which every request answered 202 and no label was
 * written is not a success, and it is not a refusal either.
 */
export function bulkPresentation(
  outcomes: readonly SteerOutcome[],
  intent: SteerIntent,
): BulkPresentation | null {
  if (outcomes.length === 0) return null;

  const written = writtenOutcomes(outcomes).length;
  const suppressed = suppressedOutcomes(outcomes).length;
  const refused = refusedOutcomes(outcomes).length;
  const total = outcomes.length;
  const verb = intentVerb(intent);

  if (suppressed === total) {
    return {
      severity: 'warning',
      title:
        total === 1
          ? 'Nothing was written: GitHub writes are disabled'
          : `Nothing was written for any of the ${total}: GitHub writes are disabled`,
      body: WRITES_DISABLED,
    };
  }

  if (written === total) {
    return {
      severity: 'success',
      title:
        total === 1
          ? `1 work order: ${intentLabel(intent)} written`
          : `${total} work orders: ${intentLabel(intent)} written to each`,
      body: NEXT_TICK,
    };
  }

  if (written === 0) {
    return {
      severity: 'error',
      title: `Nothing was ${intent === 'hold' ? 'held' : 'marked ready'} — 0 of ${total} written`,
      body:
        (suppressed > 0 ? `${WRITES_DISABLED} ` : '') +
        'Every request that was refused is listed below with the API’s own ' +
        'reason. They are all still selected, so nothing has to be picked ' +
        'again to try once the reason is dealt with.',
    };
  }

  // The mixed case, and the reason the headline is a fraction: `written` alone
  // would read as the whole answer.
  const unwritten: string[] = [];
  if (refused > 0) unwritten.push(`${refused} refused`);
  if (suppressed > 0) unwritten.push(`${suppressed} not written`);

  return {
    severity: 'warning',
    title: `${written} of ${total} written — ${unwritten.join(', ')}`,
    body:
      `${NEXT_TICK} The ${written} that landed stay landed: they are what ` +
      'was asked for, and undoing them to make this answer tidy would throw ' +
      'them away. Each of the others is below with its own reason, and only ' +
      `those are still selected, so trying to ${verb} again cannot re-send a ` +
      'label that already worked.' +
      (suppressed > 0 ? ` ${WRITES_DISABLED}` : ''),
  };
}

// ---------------------------------------------------------------------------
// The two things a release must not be allowed to imply
// ---------------------------------------------------------------------------

/**
 * Shown beside the mark-ready control, always — not only after a run.
 *
 * Both halves are properties of releasing rather than of any particular run,
 * and both are things an operator would otherwise learn by being surprised.
 */
export const RELEASE_CAVEATS = [
  'A released work order goes to the BACK of the queue. Lifting a hold ' +
    're-stamps its queue time, so it re-enters behind everything currently ' +
    'waiting rather than returning to the position it had.',
  'This does not clear a quarantine. factory:clear-quarantine has to be ' +
    'applied by a human on GitHub, where the actor is verifiable, and no ' +
    'number of ready labels will unstick a quarantined work order.',
] as const;

/** Shown beside the hold control. */
export const HOLD_CAVEAT =
  'A held work order keeps its place on this screen and loses its queue ' +
  'time, so releasing it later sends it to the back rather than back to here.';
