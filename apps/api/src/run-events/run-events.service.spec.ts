import { BadRequestException, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { FactoryMetrics } from '../telemetry/factory-metrics.service';
import { RunEventValidator } from './run-event-validator';
import { RunEventsService } from './run-events.service';
import { RUN_EVENT_SCHEMA_VERSION } from './run-event.types';

const RUN_ID = '018f2c31-7a4e-7c3b-9f21-4d5e6a7b8c9d';

function event(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: RUN_EVENT_SCHEMA_VERSION,
    eventId: 'clr-0001',
    runId: RUN_ID,
    workOrderId: 'wo_opifex_312_a3f91c2_a1',
    type: 'run.heartbeat',
    source: 'runner-reported',
    occurredAt: '2026-08-21T10:00:00.000Z',
    ...overrides,
  };
}

/**
 * The error body from a rejected batch.
 *
 * `.catch(e => e)` types the result as the union of the resolved value and the
 * error, so each call site would otherwise cast past it individually — and a
 * test that resolved instead of rejecting would silently read `undefined`
 * rather than failing. This asserts the rejection actually happened.
 */
async function rejection(promise: Promise<unknown>): Promise<{
  message: string;
  rejected: {
    index: number;
    eventId: string | null;
    failures: { path: string; message: string }[];
  }[];
}> {
  try {
    await promise;
  } catch (error) {
    return (error as BadRequestException).getResponse() as never;
  }
  throw new Error('expected the batch to be rejected, but it resolved');
}

describe('RunEventsService', () => {
  let prisma: {
    run: { findUnique: jest.Mock; updateMany: jest.Mock };
    runEvent: { createMany: jest.Mock; aggregate: jest.Mock };
  };
  let service: RunEventsService;

  beforeEach(() => {
    prisma = {
      run: {
        findUnique: jest.fn().mockResolvedValue({
          id: RUN_ID,
          workOrder: { identity: 'wo_opifex_312_a3f91c2_a1' },
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      runEvent: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
        // The cost roll-up (#183) reads the STORED rows, not the batch, so
        // the double has to answer for the table rather than echo the input.
        // Defaulted to "nothing reported anything", which is what almost
        // every test in this file is about.
        aggregate: jest.fn().mockResolvedValue({
          _sum: { costUsd: null, tokensInput: null, tokensOutput: null },
        }),
      },
    };
    // The REAL validator, against the real schema file. Mocking it would make
    // every validation test below assert nothing.
    //
    // The REAL FactoryMetrics too: with no SDK registered the OpenTelemetry
    // API hands back noop instruments, so this exercises the actual call and
    // the actual span ids it returns rather than a stub's.
    service = new RunEventsService(
      prisma as unknown as PrismaService,
      new RunEventValidator(),
      new FactoryMetrics(),
    );
  });

  describe('validation against the contract', () => {
    it('accepts all six types', async () => {
      for (const type of [
        'run.started',
        'run.heartbeat',
        'run.progress',
        'run.completed',
      ]) {
        await expect(
          service.ingest(RUN_ID, [event({ type })]),
        ).resolves.toMatchObject({
          accepted: 1,
        });
      }
      await expect(
        service.ingest(RUN_ID, [
          event({ type: 'run.blocked', blocked: { reason: 'rate-limit' } }),
        ]),
      ).resolves.toMatchObject({ accepted: 1 });
      await expect(
        service.ingest(RUN_ID, [
          event({ type: 'run.failed', failure: { reason: 'red' } }),
        ]),
      ).resolves.toMatchObject({ accepted: 1 });
    });

    it('rejects a seventh type with a clear error', async () => {
      await expect(
        service.ingest(RUN_ID, [event({ type: 'run.paused' })]),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an event with no source', async () => {
      const { source, ...noSource } = event();
      expect(source).toBeDefined();

      await expect(service.ingest(RUN_ID, [noSource])).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('names every failure by path, not just the first', async () => {
      // A runner author fixing one field per round trip is the friction that
      // leads to someone disabling validation.
      const body = await rejection(
        service.ingest(RUN_ID, [{ eventId: 'x', type: 'run.paused' }]),
      );

      expect(body.rejected[0].failures.length).toBeGreaterThan(1);
      expect(body.rejected[0].failures[0]).toHaveProperty('path');
    });

    it('writes nothing when any event in the batch is invalid', async () => {
      // A partial write leaves a runner unable to tell which events landed,
      // and its only recovery is to resend everything — which works only
      // because ingestion is idempotent, so relying on it here would be
      // building on the safety net.
      await service
        .ingest(RUN_ID, [event(), event({ eventId: 'bad', type: 'nope' })])
        .catch(() => undefined);

      expect(prisma.runEvent.createMany).not.toHaveBeenCalled();
    });
  });

  describe('a runner may only report as itself', () => {
    it.each(['git-derived', 'control-plane-synthesized'])(
      'rejects source %s',
      async (source) => {
        // Accepting these would let a runner manufacture exactly the
        // masquerade VISION §9 forbids — claiming the control plane concluded
        // something it did not.
        const body = await rejection(
          service.ingest(RUN_ID, [event({ source })]),
        );

        expect(body.rejected[0].failures[0].message).toContain(
          'produced by Opifex',
        );
      },
    );

    it('rejects an event claiming a different run than the URL', async () => {
      const body = await rejection(
        service.ingest(RUN_ID, [
          event({ runId: '018f0000-0000-7000-8000-000000000000' }),
        ]),
      );

      expect(body.rejected[0].failures[0].path).toBe('/runId');
    });
  });

  describe('idempotency', () => {
    it('stores the sender-chosen id as externalId', async () => {
      await service.ingest(RUN_ID, [event({ eventId: 'clr-0042' })]);

      const [{ data }] = prisma.runEvent.createMany.mock.calls[0];
      expect(data[0].externalId).toBe('clr-0042');
    });

    it('uses skipDuplicates rather than reading first', async () => {
      // Two concurrent deliveries could interleave past a read-then-write.
      await service.ingest(RUN_ID, [event()]);

      const [{ skipDuplicates }] = prisma.runEvent.createMany.mock.calls[0];
      expect(skipDuplicates).toBe(true);
    });

    it('reports a retried delivery as a duplicate, not an error', async () => {
      prisma.runEvent.createMany.mockResolvedValue({ count: 0 });

      await expect(service.ingest(RUN_ID, [event()])).resolves.toEqual({
        accepted: 0,
        duplicates: 1,
      });
    });

    it('counts a partially-duplicate batch correctly', async () => {
      prisma.runEvent.createMany.mockResolvedValue({ count: 1 });

      await expect(
        service.ingest(RUN_ID, [
          event({ eventId: 'a' }),
          event({ eventId: 'b' }),
        ]),
      ).resolves.toEqual({ accepted: 1, duplicates: 1 });
    });
  });

  describe('run.blocked keeps what makes it actionable', () => {
    it('retains the reason and reset time through normalization', async () => {
      // #53: losing these collapses park-and-auto-resume into kill-and-re-run,
      // which VISION §9 calls the most common supervision bug.
      await service.ingest(RUN_ID, [
        event({
          type: 'run.blocked',
          blocked: {
            reason: 'rate-limit',
            resetAt: '2026-08-21T18:00:00.000Z',
          },
        }),
      ]);

      const [{ data }] = prisma.runEvent.createMany.mock.calls[0];
      expect(data[0].blockedReason).toBe('rate-limit');
      expect(data[0].blockedUntil).toEqual(
        new Date('2026-08-21T18:00:00.000Z'),
      );
    });

    it('carries the reset time onto the run, so #56 need not re-read events', async () => {
      await service.ingest(RUN_ID, [
        event({
          type: 'run.blocked',
          blocked: {
            reason: 'rate-limit',
            resetAt: '2026-08-21T18:00:00.000Z',
          },
        }),
      ]);

      const [{ data }] = prisma.run.updateMany.mock.calls[0];
      expect(data.resumesAt).toEqual(new Date('2026-08-21T18:00:00.000Z'));
    });

    it('sets no resume time for a block with no reset time', async () => {
      // `reason: unknown` with no resetAt — #56 escalates rather than parking
      // forever, and a fabricated resume time would hide that.
      await service.ingest(RUN_ID, [
        event({ type: 'run.blocked', blocked: { reason: 'unknown' } }),
      ]);

      const [{ data }] = prisma.run.updateMany.mock.calls[0];
      expect(data.resumesAt).toBeUndefined();
    });
  });

  describe('other fields carried through', () => {
    it('stores the tool signature loop detection needs', async () => {
      await service.ingest(RUN_ID, [
        event({
          type: 'run.progress',
          tool: { name: 'Bash', signature: 'sha256:abc' },
        }),
      ]);

      const [{ data }] = prisma.runEvent.createMany.mock.calls[0];
      expect(data[0].toolSignature).toBe('Bash:sha256:abc');
    });

    it('stores cost and trace when present', async () => {
      await service.ingest(RUN_ID, [
        event({
          cost: { usd: 0.04, tokensInput: 100, tokensOutput: 20 },
          trace: { traceId: '4bf92f3577b34da6a3ce929d0e0e4736' },
        }),
      ]);

      const [{ data }] = prisma.runEvent.createMany.mock.calls[0];
      expect(data[0]).toMatchObject({ costUsd: 0.04, tokensInput: 100 });
      expect(data[0].traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    });

    it('leaves cost null when not reported, rather than zero', async () => {
      // VISION §6 makes cost reporting a declared capability, so a runner that
      // cannot report must not look like one that spent nothing.
      await service.ingest(RUN_ID, [event()]);

      const [{ data }] = prisma.runEvent.createMany.mock.calls[0];
      expect(data[0].costUsd).toBeNull();
    });
  });

  describe('advancing the run', () => {
    it('moves lastEventAt to the newest event in the batch', async () => {
      await service.ingest(RUN_ID, [
        event({ eventId: 'a', occurredAt: '2026-08-21T10:00:00.000Z' }),
        event({ eventId: 'b', occurredAt: '2026-08-21T10:05:00.000Z' }),
      ]);

      const [{ data }] = prisma.run.updateMany.mock.calls[0];
      expect(data.lastEventAt).toEqual(new Date('2026-08-21T10:05:00.000Z'));
    });

    it('guards against moving BACKWARDS in the where clause', async () => {
      // In the WHERE rather than a read-then-compare, so two concurrent
      // deliveries cannot both decide they are newest. A late-arriving old
      // event must not make a live run look staler than it is.
      await service.ingest(RUN_ID, [event()]);

      const [{ where }] = prisma.run.updateMany.mock.calls[0];
      expect(where.OR).toEqual([
        { lastEventAt: null },
        { lastEventAt: { lt: new Date('2026-08-21T10:00:00.000Z') } },
      ]);
    });
  });

  describe('the run must exist', () => {
    it('404s for an unknown run', async () => {
      prisma.run.findUnique.mockResolvedValue(null);

      await expect(service.ingest(RUN_ID, [event()])).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('rejects an empty batch', async () => {
      await expect(service.ingest(RUN_ID, [])).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });
  /**
   * The cost roll-up (#183).
   *
   * `Run.costUsd` was `null` for every run that had ever executed, because
   * `RunEvent.costUsd` was written from day one and nothing ever carried it
   * onto the run. Everything downstream reads the RUN -- `GET /api/cost`,
   * VISION §10's metric 5, the spend ledger's measured arm -- so all three
   * were structurally empty while honestly reporting that they knew nothing,
   * which is why nothing looked broken.
   */
  describe('rolling reported cost onto the run', () => {
    /** What the stored-row aggregate should answer. */
    function stored(sum: {
      costUsd?: number | null;
      tokensInput?: number | null;
      tokensOutput?: number | null;
    }) {
      prisma.runEvent.aggregate.mockResolvedValue({
        _sum: {
          costUsd: sum.costUsd ?? null,
          tokensInput: sum.tokensInput ?? null,
          tokensOutput: sum.tokensOutput ?? null,
        },
      });
    }

    /** Every `run.updateMany` call that wrote a cost or token figure. */
    function costWrites() {
      return prisma.run.updateMany.mock.calls
        .map(([arg]) => arg as { data: Record<string, unknown> })
        .filter(
          (call) =>
            'costUsd' in call.data ||
            'tokensInput' in call.data ||
            'tokensOutput' in call.data,
        );
    }

    it('writes the summed cost onto the run', async () => {
      stored({ costUsd: 4.25 });

      await service.ingest(RUN_ID, [event({ cost: { usd: 4.25 } })]);

      expect(costWrites().map((call) => call.data)).toContainEqual({
        costUsd: 4.25,
      });
    });

    it('sums from the STORED rows, not from the batch', async () => {
      // The subtlety this whole design turns on. `advanceRun` receives every
      // VALIDATED event, including the ones `createMany({ skipDuplicates })`
      // then skips -- `duplicates` is derived from the shortfall precisely
      // because the insert does not say which were skipped. Summing the batch
      // would count a redelivered terminal event twice and silently double
      // the recorded spend.
      stored({ costUsd: 4.25 });

      await service.ingest(RUN_ID, [
        event({ eventId: 'e1', cost: { usd: 4.25 } }),
        event({ eventId: 'e2', cost: { usd: 4.25 } }),
      ]);

      expect(prisma.runEvent.aggregate).toHaveBeenCalledWith(
        expect.objectContaining({ where: { runId: RUN_ID } }),
      );
      // 4.25, not 8.50: the figure came from the table, which holds each
      // event once however many times it was delivered.
      expect(costWrites().map((call) => call.data)).toContainEqual({
        costUsd: 4.25,
      });
    });

    it('writes nothing when no event reported anything', async () => {
      // `null` and `0` are different claims. A run whose events all reported
      // nothing must keep a null cost, or it becomes indistinguishable from
      // one that genuinely spent nothing -- the distinction `reportsCost`
      // exists for in the capability manifest.
      stored({});

      await service.ingest(RUN_ID, [event()]);

      expect(costWrites()).toHaveLength(0);
    });

    it('writes a genuine zero, which is a report and not an absence', async () => {
      stored({ costUsd: 0 });

      await service.ingest(RUN_ID, [event({ cost: { usd: 0 } })]);

      expect(costWrites().map((call) => call.data)).toContainEqual({
        costUsd: 0,
      });
    });

    it('guards the write so an older, smaller figure cannot win', async () => {
      // Two concurrent ingests can compute their sums and land out of order.
      // A sum over an append-only table only ever grows, so the `lt` guard is
      // the whole protection -- and it lives in the WHERE clause rather than
      // a read-then-compare so the two cannot race.
      stored({ costUsd: 4.25 });

      await service.ingest(RUN_ID, [event({ cost: { usd: 4.25 } })]);

      const write = costWrites().find(
        (call) => 'costUsd' in call.data,
      ) as unknown as {
        where: { OR: unknown[] };
      };
      expect(write.where.OR).toEqual([
        { costUsd: null },
        { costUsd: { lt: 4.25 } },
      ]);
    });

    it('carries tokens too, independently of cost', async () => {
      // A runner may report tokens and not dollars. Bundling the three into
      // one write would drop the tokens whenever the cost was absent.
      stored({ tokensInput: 100, tokensOutput: 362 });

      await service.ingest(RUN_ID, [
        event({ cost: { tokensInput: 100, tokensOutput: 362 } }),
      ]);

      const written = costWrites().map((call) => call.data);
      expect(written).toContainEqual({ tokensInput: 100 });
      expect(written).toContainEqual({ tokensOutput: 362 });
      expect(written).not.toContainEqual(
        expect.objectContaining({ costUsd: expect.anything() }),
      );
    });

    it('converts a Decimal sum rather than stringifying it', async () => {
      // Prisma returns `_sum.costUsd` as a Decimal against a real database.
      // #167 found the same column converted two different ways in two
      // services, one of which produced NaN against a double.
      stored({ costUsd: null });
      prisma.runEvent.aggregate.mockResolvedValue({
        _sum: {
          costUsd: { toNumber: () => 7.49 },
          tokensInput: null,
          tokensOutput: null,
        },
      });

      await service.ingest(RUN_ID, [event({ cost: { usd: 7.49 } })]);

      expect(costWrites().map((call) => call.data)).toContainEqual({
        costUsd: 7.49,
      });
    });
  });
});
