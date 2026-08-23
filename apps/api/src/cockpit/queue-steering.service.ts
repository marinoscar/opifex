import { Injectable, Logger, NotFoundException } from '@nestjs/common';

import { GitHubWriteService } from '../github/write/github-write.service';
import { INPUT_LABELS } from '../github/labels/factory-labels';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Hold and release, as a UI over the INPUT LABELS (#116).
 *
 * ## This is not a second state machine
 *
 * VISION §3.3 makes labels "a bidirectional edge, never the state machine", and
 * that is the whole shape of this service: it writes `factory:hold` or
 * `factory:ready` to the GitHub issue and stops. Nothing here touches Opifex's
 * own queue state.
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

  hold(workOrderId: string, actorUserId: string) {
    return this.steer(workOrderId, actorUserId, 'hold');
  }

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
    const repo = {
      owner: workOrder.repository.owner,
      name: workOrder.repository.name,
    };

    const write = await this.writes.addLabel(
      repo,
      workOrder.issueNumber,
      label,
    );

    // Audited BEFORE the caller is told anything, and audited whether or not
    // the write reached GitHub: "who asked for this and when" is the fact worth
    // keeping, and a request that failed is exactly the one somebody will later
    // need to find.
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
          labelWritten: write.performed,
        } as never,
      },
    });

    this.logger.log(
      `${intent} ${workOrder.identity}: ${label} ${
        write.performed ? 'written to' : 'NOT written to'
      } ${repo.owner}/${repo.name}#${workOrder.issueNumber}`,
    );

    return {
      workOrderId: workOrder.id,
      identity: workOrder.identity,
      label,
      // The two facts kept apart, because #116 requires it: the UI's
      // pending-until-next-tick state is only honest if the response does not
      // pretend the label has taken effect.
      labelWritten: write.performed,
      reconciled: false,
      effect:
        'The label is the request. It takes effect on the next reconciler tick.',
    };
  }
}

export interface SteerResult {
  workOrderId: string;
  identity: string;
  label: string;
  /** Whether the label actually reached GitHub. False when writes are off. */
  labelWritten: boolean;
  /** Always false here. Reconciliation is a later tick's job, never this call's. */
  reconciled: boolean;
  effect: string;
}
