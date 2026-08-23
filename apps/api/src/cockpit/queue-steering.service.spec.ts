import { NotFoundException } from '@nestjs/common';

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

    service = new QueueSteeringService(
      {
        workOrder: { findFirst, update: workOrderUpdate },
        auditEvent: { create: auditCreate },
      } as unknown as PrismaService,
      { addLabel } as unknown as GitHubWriteService,
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
      addLabel.mockResolvedValue({ performed: false, noop: true });

      const result = await service.release('wo-uuid', 'user-1');
      expect(result.labelWritten).toBe(false);
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
      addLabel.mockResolvedValue({ performed: false, noop: true });

      await service.hold('wo-uuid', 'user-1');

      expect(auditCreate).toHaveBeenCalled();
      expect(auditCreate.mock.calls[0][0].data.meta.labelWritten).toBe(false);
    });
  });
});
