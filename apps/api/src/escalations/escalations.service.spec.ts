import { NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import type { ReconcileAction } from '../reconciler/diff/actions.types';
import type { FactoryMetrics } from '../telemetry/factory-metrics.service';
import { EscalationsService } from './escalations.service';

const RUN_A = '018f2c31-7a4e-7c3b-9f21-4d5e6a7b8c9d';
const RUN_B = '018f2c31-7a4e-7c3b-9f21-4d5e6a7b8cff';
const STOPPED_AT = new Date('2026-08-22T10:00:00Z');

function escalateAction(overrides: Partial<ReconcileAction> = {}): ReconcileAction {
  return {
    type: 'escalate',
    repository: 'marinoscar/opifex',
    issueNumber: 312,
    runId: RUN_A,
    escalationKind: 'run_stalled',
    progressStoppedAt: STOPPED_AT.toISOString(),
    detectionSource: 'runner',
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
          progressStoppedAt: null,
          detectionSource: null,
          detectLatencyMs: null,
          notifyLatencyMs: null,
          raisedAt: new Date('2026-08-21T12:00:00Z'),
          run: {
            workOrder: {
              identity: 'wo_opifex_312_a3f91c2_a1',
              repository: { owner: 'marinoscar', name: 'opifex' },
            },
          },
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
        const row = rows.find((candidate) => candidate.id === where.id) as any;
        for (const [key, value] of Object.entries(data)) {
          // Prisma's atomic-number shorthand, which markDelivered uses.
          row[key] =
            value && typeof value === 'object' && 'increment' in (value as object)
              ? (row[key] ?? 0) + (value as { increment: number }).increment
              : value;
        }
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
  let metrics: { recordDetected: jest.Mock; recordNotified: jest.Mock };
  let service: EscalationsService;

  beforeEach(() => {
    prisma = fakePrisma();
    metrics = { recordDetected: jest.fn(), recordNotified: jest.fn() };
    service = new EscalationsService(
      prisma as unknown as PrismaService,
      metrics as unknown as FactoryMetrics,
    );
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

  describe('detection latency', () => {
    it('records the stop time the detector measured from', async () => {
      // Not "when we noticed". VISION §10 measures from when the run ceased
      // to make progress, and only the detector knows whether that was the
      // last event, the start of a run that never reported, or the moment a
      // tool signature began repeating.
      await service.raiseFrom([escalateAction()]);

      expect(prisma.rows[0].progressStoppedAt).toEqual(STOPPED_AT);
    });

    it('records which liveness source was carrying the run', async () => {
      await service.raiseFrom([escalateAction({ detectionSource: 'git' })]);

      expect(prisma.rows[0].detectionSource).toBe('git');
    });

    it('stores stop-to-raised so the cockpit can aggregate it', async () => {
      const raisedAt = new Date(STOPPED_AT.getTime() + 4_000);
      jest.useFakeTimers().setSystemTime(raisedAt);

      await service.raiseFrom([escalateAction()]);
      jest.useRealTimers();

      expect(prisma.rows[0].detectLatencyMs).toBe(4_000);
    });

    it('never stores a negative latency from a skewed runner clock', async () => {
      // A negative value in the histogram is not a small error: it drags the
      // aggregate below the truth and can make the target look met.
      jest.useFakeTimers().setSystemTime(new Date(STOPPED_AT.getTime() - 30_000));

      await service.raiseFrom([escalateAction()]);
      jest.useRealTimers();

      expect(prisma.rows[0].detectLatencyMs).toBe(0);
    });

    it('does NOT record a measurement it cannot make', async () => {
      // Falling back to `raisedAt` would put a near-zero latency in the
      // histogram for every unmeasurable escalation — the one way to make
      // success metric 1 lie in the flattering direction.
      await service.raiseFrom([escalateAction({ progressStoppedAt: undefined })]);

      expect(prisma.rows[0].detectLatencyMs).toBeNull();
      expect(metrics.recordDetected).not.toHaveBeenCalled();
    });

    it('feeds the metric with the same numbers it stored', async () => {
      await service.raiseFrom([escalateAction()]);

      expect(metrics.recordDetected).toHaveBeenCalledWith(
        expect.objectContaining({
          workOrderIdentity: 'wo_opifex_312_a3f91c2_a1',
          repository: 'marinoscar/opifex',
          kind: 'run_stalled',
          detectionSource: 'runner',
          progressStoppedAt: STOPPED_AT,
          raisedAt: prisma.rows[0].raisedAt,
        }),
      );
    });

    it('does not measure a suppressed duplicate', async () => {
      // Twelve ticks about one stall must contribute ONE measurement, or the
      // histogram reports the dedupe rate rather than the latency.
      await service.raiseFrom([escalateAction()]);
      await service.raiseFrom([escalateAction()]);

      expect(metrics.recordDetected).toHaveBeenCalledTimes(1);
    });
  });

  describe('being told', () => {
    const DELIVERED_AT = new Date(STOPPED_AT.getTime() + 7_000);

    beforeEach(async () => {
      await service.raiseFrom([escalateAction()]);
    });

    it('measures stop-to-notified, not stop-to-detected', async () => {
      // The definition VISION §10 actually gives: "the elapsed time between a
      // run ceasing to make progress and a human being informed."
      await service.markDelivered('escalation-1', 'push', { deliveredAt: DELIVERED_AT });

      expect(prisma.rows[0].notifyLatencyMs).toBe(7_000);
    });

    it('is not recorded by raising alone', async () => {
      // The trap: a system that reports stop-to-detected under the other name
      // shows success while the operator still finds out four hours later.
      expect(prisma.rows[0].notifyLatencyMs).toBeNull();
      expect(metrics.recordNotified).not.toHaveBeenCalled();
    });

    it('records the transport and its receipt', async () => {
      await service.markDelivered('escalation-1', 'push', { receiptId: 'rcpt_1' });

      expect(prisma.rows[0]).toMatchObject({
        status: 'delivered',
        transport: 'push',
        receiptId: 'rcpt_1',
        deliveryAttempts: 1,
      });
    });

    it('does not restart the clock on a redelivery', async () => {
      // The FIRST delivery is the one that informed the operator. A transport
      // that redelivers must not improve the metric by doing so.
      await service.markDelivered('escalation-1', 'push', { deliveredAt: DELIVERED_AT });

      await service.markDelivered('escalation-1', 'email', {
        deliveredAt: new Date(STOPPED_AT.getTime() + 4 * 60 * 60_000),
      });

      expect(prisma.rows[0].notifyLatencyMs).toBe(7_000);
      expect(prisma.rows[0].transport).toBe('push');
      expect(metrics.recordNotified).toHaveBeenCalledTimes(1);
    });

    it('closes the trace with the same work order it opened', async () => {
      await service.markDelivered('escalation-1', 'push', { deliveredAt: DELIVERED_AT });

      expect(metrics.recordNotified).toHaveBeenCalledWith(
        expect.objectContaining({
          workOrderIdentity: 'wo_opifex_312_a3f91c2_a1',
          repository: 'marinoscar/opifex',
          detectionSource: 'runner',
          progressStoppedAt: STOPPED_AT,
          deliveredAt: DELIVERED_AT,
        }),
      );
    });

    it('404s on an escalation that does not exist', async () => {
      await expect(service.markDelivered('escalation-404', 'push')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('the cockpit summary', () => {
    /** A row as the summary reads it, bypassing raise so times are exact. */
    function row(overrides: Record<string, unknown> = {}) {
      prisma.rows.push({
        id: `escalation-${prisma.rows.length + 1}`,
        status: 'raised',
        kind: 'run_stalled',
        detectionSource: 'runner',
        progressStoppedAt: STOPPED_AT,
        detectLatencyMs: 4_000,
        notifyLatencyMs: null,
        raisedAt: STOPPED_AT,
        ...overrides,
      });
    }

    it('reports nulls, not zeros, when nothing has been measured', async () => {
      // A fresh install has detected nothing. Rendering that as 0ms would put
      // a perfect number on the cockpit for a system that has never worked.
      const summary = await service.latencySummary();

      expect(summary.notified).toMatchObject({ count: 0, p50Ms: null, maxMs: null });
      expect(summary.detected).toMatchObject({ count: 0, p50Ms: null });
    });

    it('reports stop-to-notified as the headline figure', async () => {
      row({ notifyLatencyMs: 7_000 });
      row({ notifyLatencyMs: 9_000 });

      const summary = await service.latencySummary();

      expect(summary.notified).toMatchObject({ count: 2, p50Ms: 7_000, maxMs: 9_000 });
    });

    it('keeps stop-to-noticed as a SEPARATE figure', async () => {
      // A fast detector behind a broken transport looks perfect on `detected`
      // alone. Both are reported so the gap is visible.
      row({ detectLatencyMs: 4_000, notifyLatencyMs: 4 * 60 * 60_000 });

      const summary = await service.latencySummary();

      expect(summary.detected.p50Ms).toBe(4_000);
      expect(summary.notified.p50Ms).toBe(4 * 60 * 60_000);
    });

    it('counts what was never delivered rather than dropping it', async () => {
      // Their real stop-to-notified latency is unbounded. Omitting them
      // silently would make a completely broken transport render as excellent
      // latency over a sample of one.
      row({ notifyLatencyMs: 2_000 });
      row();
      row();

      const summary = await service.latencySummary();

      expect(summary.notified.count).toBe(1);
      expect(summary.awaitingNotification).toBe(2);
    });

    it('counts what could not be measured at all', async () => {
      // A `system` escalation is about the control plane and has no run that
      // stopped. Measuring it from `raisedAt` would add a zero-latency entry
      // per unmeasurable event.
      row({ kind: 'system', progressStoppedAt: null, detectLatencyMs: null });

      const summary = await service.latencySummary();

      expect(summary.unmeasurable).toBe(1);
      expect(summary.detected.count).toBe(0);
    });

    it('splits the figures by liveness source', async () => {
      // Git-derived detection is structurally slower than runner-reported. A
      // blended number describes neither and hides which half needs work.
      row({ detectionSource: 'runner', notifyLatencyMs: 3_000 });
      row({ detectionSource: 'git', notifyLatencyMs: 90 * 60_000 });

      const summary = await service.latencySummary();

      expect(summary.bySource.runner.notified.p50Ms).toBe(3_000);
      expect(summary.bySource.git.notified.p50Ms).toBe(90 * 60_000);
      expect(summary.bySource.control_plane.notified.count).toBe(0);
    });

    it('says when it read only part of the window', async () => {
      // A truncation nobody reports reads as "this is what happened", which
      // is the same class of lie as measuring stop-to-detected.
      const summary = await service.latencySummary();

      expect(summary.truncated).toBe(false);
      expect(summary).toHaveProperty('sampleSize', 0);
    });

    it('echoes the window it was asked for', async () => {
      const since = new Date('2026-08-01T00:00:00Z');

      const summary = await service.latencySummary({ since });

      expect(summary.since).toBe(since.toISOString());
    });
  });

  describe('per-run queryability', () => {
    it('filters escalations to one run', async () => {
      // The aggregate says the fleet is slow; this says which run it was.
      await service.raiseFrom([escalateAction(), escalateAction({ runId: RUN_B })]);

      const result = await service.list({ page: 1, pageSize: 10, runId: RUN_B });

      expect(result.items.map((item) => item.runId)).toEqual([RUN_B]);
    });

    it('exposes the measured latency on each escalation', async () => {
      await service.raiseFrom([escalateAction()]);

      const [item] = (await service.list({ page: 1, pageSize: 10 })).items;
      expect(item.progressStoppedAt).toBe(STOPPED_AT.toISOString());
      expect(item.detectionSource).toBe('runner');
      expect(typeof item.detectLatencyMs).toBe('number');
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
