import { NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import type { ReconcileAction } from '../reconciler/diff/actions.types';
import { EscalationsService } from './escalations.service';

const RUN_A = '018f2c31-7a4e-7c3b-9f21-4d5e6a7b8c9d';
const RUN_B = '018f2c31-7a4e-7c3b-9f21-4d5e6a7b8cff';

function escalateAction(overrides: Partial<ReconcileAction> = {}): ReconcileAction {
  return {
    type: 'escalate',
    repository: 'marinoscar/opifex',
    issueNumber: 312,
    runId: RUN_A,
    escalationKind: 'run_stalled',
    reason:
      'Run has been silent for 12m, exceeding the 5m threshold for a runner declaring full streaming fidelity.',
    evidence: {
      intent: 'run',
      inputLabels: ['factory:ready'],
      workOrderIdentity: 'wo_opifex_312_a3f91c2_a1',
      runStatus: 'running',
      currentMirrorLabels: [],
      desiredMirrorLabels: [],
    },
    ...overrides,
  } as ReconcileAction;
}

/**
 * A stateful stand-in for the `escalation` model.
 *
 * Deliberately stateful rather than `jest.fn()` returning canned rows: the
 * requirement under test is that a SECOND raise finds the FIRST one, and a
 * mock that always answers "nothing exists" would let a completely broken
 * dedupe pass. That includes two identical actions inside one batch.
 */
function fakePrisma() {
  const rows: Record<string, unknown>[] = [];
  let seq = 0;

  const matches = (row: Record<string, unknown>, where: Record<string, any>): boolean => {
    if (where.runId !== undefined) {
      const expected = where.runId;
      if (expected !== null && typeof expected === 'object' && 'in' in expected) {
        if (!expected.in.includes(row.runId)) return false;
      } else if (row.runId !== expected) {
        return false;
      }
    }
    if (where.kind !== undefined && row.kind !== where.kind) return false;
    if (where.status !== undefined) {
      const expected = where.status;
      if (typeof expected === 'object' && expected !== null && 'in' in expected) {
        if (!expected.in.includes(row.status)) return false;
      } else if (row.status !== expected) {
        return false;
      }
    }
    return true;
  };

  return {
    rows,
    escalation: {
      findFirst: async ({ where }: any) => rows.find((row) => matches(row, where)) ?? null,
      findUnique: async ({ where }: any) => rows.find((row) => row.id === where.id) ?? null,
      findMany: async ({ where = {}, skip = 0, take = 50 }: any = {}) =>
        rows
          .filter((row) => matches(row, where))
          .slice()
          .reverse()
          .slice(skip, skip + take),
      count: async ({ where = {} }: any = {}) => rows.filter((row) => matches(row, where)).length,
      create: async ({ data }: any) => {
        const row = {
          id: `escalation-${(seq += 1)}`,
          transport: null,
          receiptId: null,
          failureReason: null,
          deliveryAttempts: 0,
          detail: null,
          raisedAt: new Date('2026-08-21T12:00:00Z'),
          dispatchedAt: null,
          deliveredAt: null,
          acknowledgedAt: null,
          acknowledgedById: null,
          ...data,
        };
        rows.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const row = rows.find((candidate) => candidate.id === where.id);
        Object.assign(row as object, data);
        return row;
      },
      updateMany: async ({ where, data }: any) => {
        const targets = rows.filter((row) => matches(row, where));
        targets.forEach((row) => Object.assign(row, data));
        return { count: targets.length };
      },
    },
  };
}

describe('EscalationsService', () => {
  let prisma: ReturnType<typeof fakePrisma>;
  let service: EscalationsService;

  beforeEach(() => {
    prisma = fakePrisma();
    service = new EscalationsService(prisma as unknown as PrismaService);
    // The service logs every raise at `warn`; silence it so a suite that
    // deliberately raises a dozen escalations stays readable.
    jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
  });

  describe('raising', () => {
    it('records an escalation for an escalate action', async () => {
      const result = await service.raiseFrom([escalateAction()]);

      expect(result).toEqual({ raised: 1, deduplicated: 0 });
      expect(prisma.rows).toHaveLength(1);
      expect(prisma.rows[0]).toMatchObject({
        runId: RUN_A,
        kind: 'run_stalled',
        status: 'raised',
      });
    });

    it('ignores every action type that is not an escalation', async () => {
      // The tick hands this service the WHOLE action list, watchdog and
      // reconciler together. Filtering here rather than at the call site is
      // what keeps a new action type from silently becoming a page.
      await service.raiseFrom([
        { ...escalateAction(), type: 'kill-and-re-run' },
        { ...escalateAction(), type: 'add-mirror-label' },
        { ...escalateAction(), type: 'park' },
      ]);

      expect(prisma.rows).toHaveLength(0);
    });

    it('keeps the full reason as the detail', async () => {
      // The reason already names the numbers that produced the decision
      // (VISION §5). Discarding it here would leave an operator with a
      // notification they cannot act on without opening a laptop.
      await service.raiseFrom([escalateAction()]);

      expect(prisma.rows[0].detail).toBe(escalateAction().reason);
    });

    it('falls back to a system escalation when no kind was carried', async () => {
      // Better a `system` escalation than none: a component that escalated
      // without saying why still has something wrong with it.
      await service.raiseFrom([escalateAction({ escalationKind: undefined })]);

      expect(prisma.rows[0].kind).toBe('system');
    });

    it('records a system escalation with no run', async () => {
      await service.raiseFrom([
        escalateAction({ runId: undefined, escalationKind: 'system' }),
      ]);

      expect(prisma.rows[0].runId).toBeNull();
    });
  });

  describe('deduplication', () => {
    it('raises once for a stall the watchdog re-derives every tick', async () => {
      // #57: "A run that stalls once should produce one escalation, not one
      // per tick — an operator who is paged twelve times about the same stall
      // stops reading escalations, which reproduces the original problem by a
      // different route."
      //
      // The watchdog is a reconciler: it recomputes the same verdict from
      // scratch on every tick BY DESIGN. Twelve ticks is one minute of a
      // five-second loop, or twelve minutes of a one-minute one.
      for (let tick = 0; tick < 12; tick += 1) {
        await service.raiseFrom([escalateAction()]);
      }

      expect(prisma.rows).toHaveLength(1);
    });

    it('reports what it suppressed rather than swallowing it', async () => {
      await service.raiseFrom([escalateAction()]);

      expect(await service.raiseFrom([escalateAction()])).toEqual({
        raised: 0,
        deduplicated: 1,
      });
    });

    it('dedupes within a single batch, not just across ticks', async () => {
      // Two detectors can reach the same conclusion in one sweep.
      const result = await service.raiseFrom([escalateAction(), escalateAction()]);

      expect(result).toEqual({ raised: 1, deduplicated: 1 });
    });

    it('does NOT collapse two different problems with the same run', async () => {
      // Deduped per (run, kind), not per run. A run that is both looping and
      // over budget has two problems, and collapsing them hides one.
      await service.raiseFrom([
        escalateAction({ escalationKind: 'run_looping' }),
        escalateAction({ escalationKind: 'budget_exceeded' }),
      ]);

      expect(prisma.rows.map((row) => row.kind)).toEqual(['run_looping', 'budget_exceeded']);
    });

    it('does not let one run suppress another', async () => {
      await service.raiseFrom([escalateAction(), escalateAction({ runId: RUN_B })]);

      expect(prisma.rows).toHaveLength(2);
    });

    it.each(['raised', 'dispatched', 'delivered', 'failed'])(
      'treats a %s escalation as still outstanding',
      async (status) => {
        // `delivered` is the interesting one: the operator was TOLD and has
        // not acted. Paging them again is the noise, not the fix. `failed` is
        // the other: a transport that could not deliver is #58's problem to
        // retry, not a reason to write a second record.
        await service.raiseFrom([escalateAction()]);
        prisma.rows[0].status = status;

        await service.raiseFrom([escalateAction()]);

        expect(prisma.rows).toHaveLength(1);
      },
    );

    it.each(['acknowledged', 'resolved'])(
      'raises again after the first was %s',
      async (status) => {
        // A stall that recurs AFTER a human dealt with it is new information.
        // Suppressing it forever would be the silent failure this system
        // exists to eliminate, arrived at by way of the noise fix.
        await service.raiseFrom([escalateAction()]);
        prisma.rows[0].status = status;

        await service.raiseFrom([escalateAction()]);

        expect(prisma.rows).toHaveLength(2);
      },
    );
  });

  describe('the summary', () => {
    it('fits on a phone and names the work order and the issue', async () => {
      // #57 requires the payload be "sufficient to act on without opening a
      // laptop" — which means the identity of the thing that is stuck.
      await service.raiseFrom([escalateAction()]);

      const summary = prisma.rows[0].summary as string;
      expect(summary).toBe('wo_opifex_312_a3f91c2_a1 stalled (marinoscar/opifex#312)');
      expect(summary.length).toBeLessThanOrEqual(120);
      expect(summary).not.toContain('\n');
    });

    it('falls back to the issue when there is no work order yet', async () => {
      await service.raiseFrom([
        escalateAction({
          evidence: { ...escalateAction().evidence, workOrderIdentity: null },
        }),
      ]);

      expect(prisma.rows[0].summary).toBe(
        'marinoscar/opifex#312 stalled (marinoscar/opifex#312)',
      );
    });

    it.each([
      ['run_stalled', 'stalled'],
      ['run_looping', 'is looping'],
      ['run_failed', 'failed'],
      ['quarantined', 'quarantined'],
      ['budget_exceeded', 'hit its budget ceiling'],
      ['system', 'needs attention'],
    ])('says what happened for a %s escalation', async (kind, phrase) => {
      // Every kind gets its own wording. A single generic line would make the
      // notification useless for triage, which is the one thing it is for.
      await service.raiseFrom([escalateAction({ escalationKind: kind as never })]);

      expect(prisma.rows.at(-1)!.summary).toContain(phrase);
    });
  });

  describe('acknowledging', () => {
    it('records who saw it, and when', async () => {
      await service.raiseFrom([escalateAction()]);

      const result = await service.acknowledge('escalation-1', 'user-1');

      expect(result.status).toBe('acknowledged');
      expect(result.acknowledgedById).toBe('user-1');
      expect(result.acknowledgedAt).not.toBeNull();
    });

    it('keeps the first acknowledgement when two people reach for the same page', async () => {
      await service.raiseFrom([escalateAction()]);
      const first = await service.acknowledge('escalation-1', 'user-1');

      const second = await service.acknowledge('escalation-1', 'user-2');

      expect(second.acknowledgedById).toBe('user-1');
      expect(second.acknowledgedAt).toBe(first.acknowledgedAt);
    });

    it('404s on an escalation that does not exist', async () => {
      await expect(service.acknowledge('escalation-404', 'user-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('lets the next occurrence raise again', async () => {
      // Acknowledging is what re-arms the detector. Without this the operator
      // would silence the run permanently by looking at it once.
      await service.raiseFrom([escalateAction()]);
      await service.acknowledge('escalation-1', 'user-1');

      await service.raiseFrom([escalateAction()]);

      expect(prisma.rows).toHaveLength(2);
    });
  });

  describe('resolving what cleared on its own', () => {
    it('marks it resolved, not acknowledged', async () => {
      // The distinction is the point: `acknowledged` claims a human saw it.
      // Nobody saw this one — the condition cleared first.
      await service.raiseFrom([escalateAction()]);

      expect(await service.resolveStale([RUN_A])).toBe(1);
      expect(prisma.rows[0].status).toBe('resolved');
      expect(prisma.rows[0].acknowledgedAt).toBeNull();
      expect(prisma.rows[0].acknowledgedById).toBeNull();
    });

    it('leaves an escalation a human already acknowledged alone', async () => {
      await service.raiseFrom([escalateAction()]);
      await service.acknowledge('escalation-1', 'user-1');

      await service.resolveStale([RUN_A]);

      expect(prisma.rows[0].status).toBe('acknowledged');
    });

    it('touches no other run', async () => {
      await service.raiseFrom([escalateAction(), escalateAction({ runId: RUN_B })]);

      await service.resolveStale([RUN_A]);

      expect(prisma.rows.map((row) => row.status)).toEqual(['resolved', 'raised']);
    });

    it('issues no query at all for an empty list', async () => {
      // `updateMany` with `in: []` matches nothing, so this is about not
      // making the round trip on the common tick where nothing cleared.
      const updateMany = jest.spyOn(prisma.escalation, 'updateMany');

      expect(await service.resolveStale([])).toBe(0);
      expect(updateMany).not.toHaveBeenCalled();
    });
  });

  describe('listing', () => {
    beforeEach(async () => {
      await service.raiseFrom([
        escalateAction(),
        escalateAction({ runId: RUN_B, escalationKind: 'run_looping' }),
      ]);
    });

    it('returns the page with a total', async () => {
      const result = await service.list({ page: 1, pageSize: 10 });

      expect(result.total).toBe(2);
      expect(result.items).toHaveLength(2);
    });

    it('filters to what is still outstanding', async () => {
      await service.acknowledge('escalation-1', 'user-1');

      const result = await service.list({ page: 1, pageSize: 10, unresolvedOnly: true });

      expect(result.items.map((item) => item.id)).toEqual(['escalation-2']);
    });

    it('filters by an explicit status', async () => {
      await service.acknowledge('escalation-1', 'user-1');

      const result = await service.list({ page: 1, pageSize: 10, status: 'acknowledged' });

      expect(result.items.map((item) => item.id)).toEqual(['escalation-1']);
    });

    it('serialises timestamps as ISO strings', async () => {
      const [item] = (await service.list({ page: 1, pageSize: 10 })).items;

      expect(typeof item.raisedAt).toBe('string');
      expect(item.acknowledgedAt).toBeNull();
    });
  });
});
