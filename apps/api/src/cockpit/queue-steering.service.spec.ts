import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';

import { GitHubWriteService } from '../github/write/github-write.service';
import { PrismaService } from '../prisma/prisma.service';
import { QueueSteeringService } from './queue-steering.service';

/**
 * Hold and release (#116).
 *
 * The claims worth testing are not "it called addLabel" — they are the ones
 * that keep this a UI over the input labels rather than a second state machine:
 * nothing writes queue state, the response never claims the effect has landed,
 * and there is no way to clear a quarantine through it.
 */
describe('QueueSteeringService', () => {
  let findFirst: jest.Mock;
  let auditCreate: jest.Mock;
  let addLabel: jest.Mock;
  let removeLabel: jest.Mock;
  let workOrderUpdate: jest.Mock;
  let service: QueueSteeringService;

  const ROW = {
    id: 'wo-uuid',
    identity: 'wo_opifex_312_a3f91c2_a1',
    issueNumber: 312,
    repository: { owner: 'acme', name: 'app' },
  };

  beforeEach(() => {
    findFirst = jest.fn().mockResolvedValue(ROW);
    auditCreate = jest.fn().mockResolvedValue({});
    workOrderUpdate = jest.fn().mockResolvedValue({});
    addLabel = jest.fn().mockResolvedValue({ performed: true, noop: false });
    removeLabel = jest.fn().mockResolvedValue({ performed: true, noop: false });

    service = new QueueSteeringService(
      {
        workOrder: { findFirst, update: workOrderUpdate },
        auditEvent: { create: auditCreate },
      } as unknown as PrismaService,
      { addLabel, removeLabel } as unknown as GitHubWriteService,
    );
    jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
  });

  describe('it writes a label and nothing else', () => {
    it('holds by applying factory:hold to the issue', async () => {
      await service.hold('wo-uuid', 'user-1');

      expect(addLabel).toHaveBeenCalledWith(
        { owner: 'acme', name: 'app' },
        312,
        'factory:hold',
      );
    });

    it('releases by applying factory:ready', async () => {
      await service.release('wo-uuid', 'user-1');

      expect(addLabel.mock.calls[0][2]).toBe('factory:ready');
    });

    it('never touches Opifex queue state', async () => {
      // VISION §3.3: labels are "a bidirectional edge, never the state
      // machine". An API that mutated queue state directly would break VISION
      // §4's promise that you can always fix the factory by editing GitHub —
      // a work order held here and one held by hand would stop being the same
      // thing.
      await service.hold('wo-uuid', 'user-1');

      expect(workOrderUpdate).not.toHaveBeenCalled();
    });

    it('exposes no way to clear a quarantine', () => {
      // #49: `factory:clear-quarantine` must be applied by a human on GitHub,
      // where the applier's identity is native. Proxying it would launder the
      // actor — every clear would look like the Opifex token — and VISION §8's
      // rule that an agent cannot clear its own quarantine would stop being
      // enforceable.
      const methods = Object.getOwnPropertyNames(
        Object.getPrototypeOf(service),
      );
      expect(methods).not.toContain('clearQuarantine');
      expect(JSON.stringify(methods)).not.toContain('quarantine');
    });
  });

  /**
   * #432: release did not release.
   *
   * `factory:ready` alone changed nothing — `issue-projection.ts` reads the
   * hold from `factory:hold` and an issue carrying both labels is held — while
   * every layer answered success. These are the assertions that make the
   * removal part of the operation rather than an implementation detail.
   */
  describe('release removes the hold as well as adding the ready label', () => {
    it('removes factory:hold', async () => {
      await service.release('wo-uuid', 'user-1');

      expect(removeLabel).toHaveBeenCalledWith(
        { owner: 'acme', name: 'app' },
        312,
        'factory:hold',
      );
    });

    it('adds the ready label BEFORE removing the hold', async () => {
      // Order is the difference between failing closed and failing open. If
      // the second write fails, add-then-remove leaves the issue carrying both
      // labels — the hold outranks, and the work order stays held. The reverse
      // would leave it with neither, and `reconcileHold` reads only the hold,
      // so a release the API reported as FAILED would re-queue the work order
      // and eventually spend money dispatching it.
      const order: string[] = [];
      addLabel.mockImplementation(async () => {
        order.push('add');
        return { performed: true, noop: false };
      });
      removeLabel.mockImplementation(async () => {
        order.push('remove');
        return { performed: true, noop: false };
      });

      await service.release('wo-uuid', 'user-1');

      expect(order).toEqual(['add', 'remove']);
    });

    it('reports both writes', async () => {
      const result = await service.release('wo-uuid', 'user-1');

      expect(result.writes).toEqual([
        {
          label: 'factory:ready',
          operation: 'add',
          performed: true,
          noop: false,
        },
        {
          label: 'factory:hold',
          operation: 'remove',
          performed: true,
          noop: false,
        },
      ]);
      expect(result.labelWritten).toBe(true);
    });

    it('succeeds when the work order was never held', async () => {
      // GitHub answers 404 for removing a label that is not there, which
      // `GitHubWriteService.removeLabel` turns into a performed no-op. A
      // release of an unheld work order is an ordinary release, not an error:
      // treating it as one would make the bulk control (#421) fail on exactly
      // the rows it changed nothing about.
      removeLabel.mockResolvedValue({ performed: true, noop: true });

      const result = await service.release('wo-uuid', 'user-1');

      expect(result.labelWritten).toBe(true);
      expect(result.writes[1]).toMatchObject({ noop: true, performed: true });
    });
  });

  describe('a hold does NOT remove factory:ready', () => {
    it('writes one label and only one', async () => {
      // Deliberate asymmetry, matching `SteeringService.namedOperation`
      // (#425). The two labels compose — ready means AUTHORIZED, hold means
      // PAUSED — and the projection defines their precedence rather than
      // treating them as contradictory. Removing the ready would also make an
      // issue with no work order yet project as `not-marked-ready`, so it
      // would vanish from the queue instead of appearing held, and a later
      // release would be guessing at the state it restored.
      await service.hold('wo-uuid', 'user-1');

      expect(addLabel).toHaveBeenCalledTimes(1);
      expect(removeLabel).not.toHaveBeenCalled();
    });
  });

  describe('a steer that only half landed is not a success', () => {
    it('raises when the removal fails after the add succeeded', async () => {
      // The bug one level up. The add genuinely happened, so `labelWritten`
      // would have been true — and the work order is still held, because the
      // hold is still on the issue.
      removeLabel.mockRejectedValue(new Error('GitHub 500'));

      await expect(service.release('wo-uuid', 'user-1')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });

    it('names both writes and the consequence in the message', async () => {
      removeLabel.mockRejectedValue(new Error('GitHub 500'));

      const error = await service
        .release('wo-uuid', 'user-1')
        .catch((caught: Error) => caught);

      const message = (error as ServiceUnavailableException).message;
      expect(message).toContain('factory:ready added');
      expect(message).toContain('factory:hold NOT removed');
      expect(message).toContain('remains held');
      expect(message).toContain('Retrying is safe');
    });

    it('audits the half-applied steer before raising', async () => {
      // The one somebody will hunt for afterwards. A release that raised and
      // left no record would be worse than the bug it replaced.
      removeLabel.mockRejectedValue(new Error('GitHub 500'));

      await service.release('wo-uuid', 'user-1').catch(() => undefined);

      const [{ data }] = auditCreate.mock.calls[0];
      expect(data.action).toBe('queue.release');
      expect(data.meta.outcome).toBe('incomplete');
      expect(data.meta.labelWritten).toBe(false);
      expect(data.meta.writes[1]).toMatchObject({
        label: 'factory:hold',
        performed: false,
        error: 'GitHub 500',
      });
    });

    it('does not attempt the removal when the add itself failed', async () => {
      // Removing the hold without having written the ready label is the
      // fail-open case the write order exists to prevent.
      addLabel.mockRejectedValue(new Error('GitHub 500'));

      await expect(service.release('wo-uuid', 'user-1')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(removeLabel).not.toHaveBeenCalled();
    });

    it('raises when the kill switch is flipped between the two writes', async () => {
      // `guardedWrite` reads `github.writesEnabled` per call (#341), so a
      // release can add the label and then have its removal suppressed. That
      // is a suppressed HALF, not a suppressed steer, and reporting it like
      // the writes-off case would say "nothing was written" over an issue that
      // now carries both labels.
      removeLabel.mockResolvedValue({ performed: false, noop: false });

      await expect(service.release('wo-uuid', 'user-1')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });
  });

  describe('the response cannot claim more than happened', () => {
    it('separates "label written" from "reconciled"', async () => {
      const result = await service.hold('wo-uuid', 'user-1');

      expect(result.labelWritten).toBe(true);
      // Always false. Reconciliation is a later tick's job, and a UI showing
      // the work order as held before a tick had run would show a state the
      // control plane has not reached.
      expect(result.reconciled).toBe(false);
      expect(result.effect).toContain('next reconciler tick');
    });

    it('reports labelWritten false when writes are disabled', async () => {
      // During the observation week nothing reaches GitHub. Saying so is the
      // difference between a queued request and a silent no-op.
      addLabel.mockResolvedValue({ performed: false, noop: false });
      removeLabel.mockResolvedValue({ performed: false, noop: false });

      const result = await service.release('wo-uuid', 'user-1');
      expect(result.labelWritten).toBe(false);
    });

    it('suppresses the removal too, rather than half a release', async () => {
      // Both writes go through `guardedWrite`, so the kill switch covers the
      // removal exactly as it covers the add. A removal that escaped it would
      // release work orders during the observation week that VISION §12 says
      // must only be observed.
      addLabel.mockResolvedValue({ performed: false, noop: false });
      removeLabel.mockResolvedValue({ performed: false, noop: false });

      const result = await service.release('wo-uuid', 'user-1');

      expect(result.writes.every((write) => !write.performed)).toBe(true);
      expect(result.writes).toHaveLength(2);
    });
  });

  describe('identity and audit', () => {
    it('accepts the work-order identity as well as the row id', async () => {
      // The identity is what a human recognises and what a commit trailer
      // carries; requiring the row id would make the URL unusable from
      // anything but the cockpit.
      await service.hold('wo_opifex_312_a3f91c2_a1', 'user-1');

      const [{ where }] = findFirst.mock.calls[0];
      expect(where.OR).toEqual([
        { id: 'wo_opifex_312_a3f91c2_a1' },
        { identity: 'wo_opifex_312_a3f91c2_a1' },
      ]);
    });

    it('404s for a work order that does not exist', async () => {
      findFirst.mockResolvedValue(null);

      await expect(service.hold('nope', 'user-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(addLabel).not.toHaveBeenCalled();
    });

    it('records who asked, and whether it reached GitHub', async () => {
      await service.hold('wo-uuid', 'user-7');

      const [{ data }] = auditCreate.mock.calls[0];
      expect(data.actorUserId).toBe('user-7');
      expect(data.action).toBe('queue.hold');
      expect(data.targetId).toBe('wo-uuid');
      expect(data.meta.label).toBe('factory:hold');
      expect(data.meta.labelWritten).toBe(true);
    });

    it('audits even when the write did not reach GitHub', async () => {
      // "Who asked for this and when" is the fact worth keeping, and a request
      // that failed is exactly the one somebody will later need to find.
      addLabel.mockResolvedValue({ performed: false, noop: false });

      await service.hold('wo-uuid', 'user-1');

      expect(auditCreate).toHaveBeenCalled();
      expect(auditCreate.mock.calls[0][0].data.meta.labelWritten).toBe(false);
    });
  });
});
