import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

import { GitHubWriteService } from '../github/write/github-write.service';
import { INPUT_LABELS } from '../github/labels/factory-labels';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Hold and release, as a UI over the INPUT LABELS (#116).
 *
 * ## This is not a second state machine
 *
 * VISION §3.3 makes labels "a bidirectional edge, never the state machine", and
 * that is the whole shape of this service: it writes the input labels on the
 * GitHub issue and stops. Nothing here touches Opifex's own queue state.
 *
 * ## A release is two writes, and they are not symmetric with a hold
 *
 * Release adds `factory:ready` AND removes `factory:hold`; hold adds
 * `factory:hold` and leaves the ready label alone. The reasoning — and why
 * only one of those directions needs a removal — is on {@link LABEL_PLAN},
 * which is where the plan is declared. Because a release is two writes, half
 * of it can land: see the `incomplete` outcome, which raises rather than
 * answering 202 (#432).
 *
 * The effect arrives on the next reconciler tick, exactly as it would if the
 * operator had typed the label into GitHub themselves — which is the property
 * VISION §4 promises ("you can always fix the factory by editing GitHub") and
 * which an API that mutated queue state directly would quietly break. A work
 * order held through this endpoint and one held by hand are then the same
 * thing, rather than two paths that can disagree.
 *
 * ## Clearing quarantine is deliberately absent
 *
 * #116 excludes it and #49 says why: `factory:clear-quarantine` must be applied
 * by a human on GitHub, where the applier's identity is native and verifiable
 * from the issue timeline. Proxying it through this API would launder the actor
 * — every clear would look like it came from the Opifex token, and VISION §8's
 * rule that an agent cannot clear its own quarantine would become unenforceable
 * exactly where it matters most.
 */
@Injectable()
export class QueueSteeringService {
  private readonly logger = new Logger(QueueSteeringService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly writes: GitHubWriteService,
  ) {}

  /** Add `factory:hold`. Leaves `factory:ready` alone — see {@link LABEL_PLAN}. */
  hold(workOrderId: string, actorUserId: string) {
    return this.steer(workOrderId, actorUserId, 'hold');
  }

  /** Add `factory:ready` and remove `factory:hold`. Both, or it is not a release. */
  release(workOrderId: string, actorUserId: string) {
    return this.steer(workOrderId, actorUserId, 'release');
  }

  private async steer(
    workOrderId: string,
    actorUserId: string,
    intent: 'hold' | 'release',
  ): Promise<SteerResult> {
    const workOrder = await this.prisma.workOrder.findFirst({
      // By id OR identity: the identity is what a human recognises and what a
      // commit trailer carries, and requiring the row id would make the URL
      // unusable from anything but the cockpit.
      where: {
        OR: [{ id: workOrderId }, { identity: workOrderId }],
      },
      select: {
        id: true,
        identity: true,
        issueNumber: true,
        repository: { select: { owner: true, name: true } },
      },
    });

    if (!workOrder) {
      throw new NotFoundException(`Work order ${workOrderId} not found`);
    }

    const label = intent === 'hold' ? INPUT_LABELS.HOLD : INPUT_LABELS.READY;
    const plan = LABEL_PLAN[intent];
    const repo = {
      owner: workOrder.repository.owner,
      name: workOrder.repository.name,
    };

    const writes: SteerWrite[] = [];
    let failed = false;

    for (const step of plan) {
      try {
        const result =
          step.operation === 'add'
            ? await this.writes.addLabel(
                repo,
                workOrder.issueNumber,
                step.label,
              )
            : await this.writes.removeLabel(
                repo,
                workOrder.issueNumber,
                step.label,
              );
        writes.push({
          label: step.label,
          operation: step.operation,
          performed: result.performed,
          noop: result.noop,
        });
      } catch (error) {
        // Recorded, then the loop stops: a plan whose first write did not land
        // must not have its second attempted, or a release could remove the
        // hold without ever having written `factory:ready`.
        failed = true;
        writes.push({
          label: step.label,
          operation: step.operation,
          performed: false,
          noop: false,
          error: error instanceof Error ? error.message : String(error),
        });
        break;
      }
    }

    const performed = writes.filter((write) => write.performed).length;
    const outcome: SteerOutcome = failed
      ? 'incomplete'
      : performed === plan.length
        ? 'written'
        : performed === 0
          ? // Every write suppressed by the kill switch. Not a failure: the
            // request was accepted and recorded, and `labelWritten: false`
            // says exactly what did not happen.
            'suppressed'
          : // Some suppressed and some not, which only the kill switch being
            // flipped mid-request can produce (`guardedWrite` reads it per
            // call, #341). Rare, and still a half-applied steer.
            'incomplete';

    // Audited BEFORE the caller is told anything, and audited whether or not
    // the writes reached GitHub: "who asked for this and when" is the fact
    // worth keeping, and a request that failed is exactly the one somebody
    // will later need to find. That now includes the half-applied case, which
    // is the one an operator will be hunting for after a release that raised.
    await this.prisma.auditEvent.create({
      data: {
        actorUserId,
        action: `queue.${intent}`,
        targetType: 'work_order',
        targetId: workOrder.id,
        meta: {
          identity: workOrder.identity,
          repository: `${repo.owner}/${repo.name}`,
          issueNumber: workOrder.issueNumber,
          label,
          labelWritten: outcome === 'written',
          outcome,
          writes,
        } as never,
      },
    });

    this.logger.log(
      `${intent} ${workOrder.identity} (${outcome}): ` +
        `${describePlan(writes, plan)} on ` +
        `${repo.owner}/${repo.name}#${workOrder.issueNumber}`,
    );

    if (outcome === 'incomplete') {
      // The whole point of the fix. A steer that did not fully land leaves the
      // issue in a state the reconciler will read differently from what the
      // operator asked for, and answering 202 here would rebuild #432 one
      // level up: every layer reporting success over a work order that stays
      // held. The caller gets an error, and `apps/web` already renders that as
      // a refusal with the API's own message.
      throw new ServiceUnavailableException(
        incompleteMessage(intent, workOrder.identity, writes, plan),
      );
    }

    return {
      workOrderId: workOrder.id,
      identity: workOrder.identity,
      label,
      writes,
      // The two facts kept apart, because #116 requires it: the UI's
      // pending-until-next-tick state is only honest if the response does not
      // pretend the label has taken effect.
      //
      // It now means EVERY write in the plan reached GitHub, not just the
      // first. A release whose removal was suppressed while its add landed is
      // not a written release — the work order would still be held.
      labelWritten: outcome === 'written',
      reconciled: false,
      effect:
        'The label is the request. It takes effect on the next reconciler tick.',
    };
  }
}

/**
 * One label write, and the order they are made in.
 *
 * ## Why release is TWO writes (#432)
 *
 * `factory:ready` alone does not release anything. `issue-projection.ts` reads
 * the hold as `inputLabels.includes(INPUT_LABELS.HOLD)` and
 * `WorkOrderProjectionService.reconcileHold` reads the row from the same
 * field, so an issue carrying BOTH labels is held — the hold outranks the
 * ready, deliberately, and `issue-projection.spec.ts` pins it. A release that
 * only added `factory:ready` therefore wrote a label that changed nothing,
 * while answering 202 with `labelWritten: true` because a label genuinely was
 * written. The removal is what makes the release a release.
 *
 * ## Why hold is NOT symmetric
 *
 * A hold adds `factory:hold` and leaves `factory:ready` alone, matching
 * `SteeringService.namedOperation` (#425), which made the same call.
 *
 * The two labels are not contradictory — they compose, and the composition is
 * meaningful: `factory:ready` says the issue is AUTHORIZED to be worked,
 * `factory:hold` says it is PAUSED. #297's `factory/label-ignored` reports
 * contradictions between labels that cannot both be true (two `tier:` values);
 * these two can, and the projection defines their precedence rather than
 * flagging them.
 *
 * Removing the ready would also do active harm. An issue that has no work
 * order yet projects as `not-marked-ready` without it — so the hold would make
 * it vanish from the queue instead of appearing as held, which is exactly the
 * "an operator cannot tell a paused issue from one the factory could not read"
 * failure `issue-projection.ts` cites for recording holds rather than refusing
 * them. And a release could then only guess at the state it was restoring.
 *
 * ## Why the add comes before the removal
 *
 * Both orders leave the same end state; they differ in what a half-applied
 * release leaves behind. Add-then-remove fails CLOSED: the issue carries both
 * labels, the hold still outranks, and the work order stays held. The reverse
 * fails open — the hold gone and no ready written — and `reconcileHold` reads
 * only the hold, so the work order would be re-queued and eventually
 * dispatched by a release the API reported as failed. A failure that spends
 * money is worse than a failure that changes nothing.
 */
interface LabelStep {
  operation: 'add' | 'remove';
  label: string;
}

const LABEL_PLAN: Record<'hold' | 'release', readonly LabelStep[]> = {
  hold: [{ operation: 'add', label: INPUT_LABELS.HOLD }],
  release: [
    { operation: 'add', label: INPUT_LABELS.READY },
    { operation: 'remove', label: INPUT_LABELS.HOLD },
  ],
};

function verb(write: { operation: 'add' | 'remove' }): string {
  return write.operation === 'add' ? 'added' : 'removed';
}

function describePlan(
  writes: SteerWrite[],
  plan: readonly LabelStep[],
): string {
  const parts = writes.map(
    (write) =>
      `${write.label} ${write.performed ? verb(write) : `NOT ${verb(write)}`}`,
  );
  for (const step of plan.slice(writes.length)) {
    parts.push(`${step.label} not attempted`);
  }
  return parts.join(', ');
}

/**
 * What the operator is told when a steer half-landed.
 *
 * Names each write and what became of it, then the consequence — because
 * "release failed" leaves the operator unable to tell whether anything reached
 * GitHub, and the answer decides whether they retry or investigate. Retrying
 * is always safe here: adding a label already present is a 200 from GitHub,
 * and removing one already absent is a `noop` rather than an error.
 */
function incompleteMessage(
  intent: 'hold' | 'release',
  identity: string,
  writes: SteerWrite[],
  plan: readonly LabelStep[],
): string {
  const landed = writes.filter((write) => write.performed);
  const stillHeld =
    intent === 'release' &&
    !writes.some((w) => w.operation === 'remove' && w.performed);

  return (
    `The ${intent} of ${identity} did not complete: ${describePlan(writes, plan)}. ` +
    (landed.length === 0
      ? 'Nothing reached GitHub, so the work order is unchanged. '
      : stillHeld
        ? `The issue still carries ${INPUT_LABELS.HOLD}, which outranks ` +
          `${INPUT_LABELS.READY}, so the work order remains held. `
        : 'The work order may be in a state neither the request nor the previous one describes. ') +
    'Retrying is safe: every label write here is idempotent.'
  );
}

/** Where one steer got to. */
export type SteerOutcome =
  /** Every write in the plan reached GitHub. */
  | 'written'
  /** Every write was suppressed by the kill switch. Accepted, not applied. */
  | 'suppressed'
  /** Some write did not land. The steer must NOT be reported as a success. */
  | 'incomplete';

/** One label write attempted by a steer. */
export interface SteerWrite {
  label: string;
  operation: 'add' | 'remove';
  /**
   * True when the write reached GitHub. False when the kill switch suppressed
   * it, and false when it threw — in that last case read it as "not known to
   * have landed" rather than "certainly did not", which is why `error` is
   * carried beside it.
   */
  performed: boolean;
  /** True when the write was already true — a label already present or absent. */
  noop: boolean;
  /** Present only when the write threw. */
  error?: string;
}

export interface SteerResult {
  workOrderId: string;
  identity: string;
  /**
   * The label the intent is named for: `factory:hold` for a hold,
   * `factory:ready` for a release. A release also REMOVES `factory:hold`; see
   * `writes` for every label the steer touched.
   */
  label: string;
  /** Every label write the steer made, in the order it made them. */
  writes: SteerWrite[];
  /**
   * Whether the steer fully reached GitHub. False when writes are off.
   *
   * Never true for a partly-applied steer — that raises instead, so a caller
   * cannot read this as success over a work order that did not move (#432).
   */
  labelWritten: boolean;
  /** Always false here. Reconciliation is a later tick's job, never this call's. */
  reconciled: boolean;
  effect: string;
}
