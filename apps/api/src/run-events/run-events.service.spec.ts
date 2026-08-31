import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';

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

/** The columns of the one run row the doubles below stand in for. */
interface RunRow {
  status: string;
  lastEventAt?: Date | null;
  endedAt?: Date;
  attentionReason?: string;
  [column: string]: unknown;
}

/**
 * Does this WHERE match the row?
 *
 * Only the operators this service actually uses — equality, `in`, `lt` and
 * `OR`. A `lt` against a null column does not match, exactly as SQL's
 * three-valued logic has it, which is what makes the `{ lastEventAt: null }`
 * arm of the advance guard load-bearing rather than decorative.
 */
function whereMatches(where: Record<string, unknown>, row: RunRow): boolean {
  return Object.entries(where).every(([column, condition]) => {
    if (column === 'OR') {
      return (condition as Record<string, unknown>[]).some((arm) =>
        whereMatches(arm, row),
      );
    }
    if (column === 'id') return condition === RUN_ID;

    const value = row[column];
    if (condition === null) return value === null || value === undefined;
    if (condition instanceof Date) return value === condition;

    if (typeof condition === 'object') {
      const test = condition as { in?: unknown[]; lt?: Date | number };
      if (test.in) return test.in.includes(value);
      if (test.lt !== undefined) {
        if (value === null || value === undefined) return false;
        return (value as Date | number) < test.lt;
      }
      return true;
    }

    return value === condition;
  });
}

describe('RunEventsService', () => {
  let prisma: {
    run: { findUnique: jest.Mock; updateMany: jest.Mock };
    runEvent: { createMany: jest.Mock; aggregate: jest.Mock };
    runAttempt: { updateMany: jest.Mock };
  };
  let service: RunEventsService;

  /**
   * Give the doubles a real row to apply their WHERE clauses against.
   *
   * The guards in this service ARE their WHERE clauses, and a double that
   * answers `{ count: 1 }` unconditionally cannot tell a guard that matched
   * from one that matched nothing. That is precisely how #254 survived this
   * whole file: `status: 'running'` silently updated zero rows for every
   * stalled run, and every assertion here still passed.
   */
  function withRunRow(initial: Partial<RunRow> & { status: string }): RunRow {
    const row: RunRow = { lastEventAt: null, ...initial };

    prisma.run.updateMany.mockImplementation(
      (args: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        if (!whereMatches(args.where, row)) {
          return Promise.resolve({ count: 0 });
        }
        Object.assign(row, args.data);
        return Promise.resolve({ count: 1 });
      },
    );

    return row;
  }

  beforeEach(() => {
    prisma = {
      run: {
        findUnique: jest.fn().mockResolvedValue({
          id: RUN_ID,
          workOrder: { identity: 'wo_opifex_312_a3f91c2_a1' },
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      // #477: a conclusion closes whichever run attempt is open. Present so
      // the conclusion path can run at all; no test in this file asserts on
      // it, and every one of them concludes runs that have no attempt rows —
      // which is what `updateMany` matching nothing already means.
      runAttempt: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
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

    it('leaves the resume plan to the watchdog, keeping the reset on the event', async () => {
      // INVERTED by #477, and the inversion is the point of that issue's first
      // finding. This used to assert that the block wrote `resumesAt` — the
      // vendor's raw reset — onto the run. Doing so gave one column two
      // meanings and two writers, and the ingestion one always won:
      // `decideParking` short-circuits to `waiting` while `resumesAt` is in
      // the future, so a dated block never reached `park` and JITTER_FRACTION
      // was never applied to one. Every run parked by the same quota window
      // would then have woken in the same instant.
      //
      // The reset time is not lost — the assertion above this one is that it
      // is on the event row as `blockedUntil`, which is where both readers
      // (`WatchdogService.loadBlockedRuns`, `DispatchService.loadQuotaBlocks`)
      // take it from anyway. What the run's column now holds is the watchdog's
      // PLAN, and only the watchdog writes one.
      const row = withRunRow({ status: 'running', resumesAt: null });

      await service.ingest(RUN_ID, [
        event({
          type: 'run.blocked',
          blocked: {
            reason: 'rate-limit',
            resetAt: '2026-08-21T18:00:00.000Z',
          },
        }),
      ]);

      expect(row.status).toBe('blocked');
      expect(row.resumesAt).toBeNull();
    });

    it('sets no resume time for a block with no reset time', async () => {
      // `reason: unknown` with no resetAt — #56 escalates rather than parking
      // forever, and a fabricated resume time would hide that.
      const row = withRunRow({ status: 'running', resumesAt: null });

      await service.ingest(RUN_ID, [
        event({ type: 'run.blocked', blocked: { reason: 'unknown' } }),
      ]);

      expect(row.resumesAt).toBeNull();
    });
  });

  /**
   * #475: `run.blocked` had never written `Run.status`, so
   * `WatchdogService.loadBlockedRuns()` matched zero rows forever and the
   * whole of `watchdog/blocked-parking.ts` was well-tested code that could
   * not execute in production. Like the #254 tests below, these run against
   * a row the doubles actually apply their WHERE clauses to — a double that
   * answers `{ count: 1 }` unconditionally cannot tell a guard that matched
   * from one that matched nothing, which is exactly how #254 hid for as
   * long as it did.
   */
  describe('parking a run on run.blocked (#475)', () => {
    it('parks a running run as blocked, and schedules nothing itself', async () => {
      // #475 wrote the status AND the resume time here. #477 keeps the status
      // and removes the resume time: see the sibling assertion above for why
      // one column with two meanings made the jitter unreachable. A run is
      // `blocked` with no plan for at most one watchdog tick, which is exactly
      // the state that lets `decideParking` reach `park` and draw jitter.
      const row = withRunRow({ status: 'running', resumesAt: null });

      await service.ingest(RUN_ID, [
        event({
          type: 'run.blocked',
          blocked: {
            reason: 'rate-limit',
            resetAt: '2026-08-21T18:00:00.000Z',
          },
        }),
      ]);

      expect(row.status).toBe('blocked');
      expect(row.resumesAt).toBeNull();
    });

    it('parks a stalled run as blocked, leaving resumesAt unset when the block is undated', async () => {
      // `reason: unknown` with no resetAt — #56 escalates after
      // UNDATED_BLOCK_PATIENCE_MS rather than parking forever, and a
      // fabricated resume time would hide that from it.
      const row = withRunRow({ status: 'stalled', resumesAt: null });

      await service.ingest(RUN_ID, [
        event({ type: 'run.blocked', blocked: { reason: 'unknown' } }),
      ]);

      expect(row.status).toBe('blocked');
      expect(row.resumesAt).toBeNull();
    });

    it('does not drag a succeeded run into blocked by a late-arriving block', async () => {
      // Excluded from BLOCKABLE_STATUSES deliberately: nothing resumes a run
      // that already ended, so a park is not a state a finished run can enter.
      const row = withRunRow({ status: 'succeeded', resumesAt: null });

      await service.ingest(RUN_ID, [
        event({
          type: 'run.blocked',
          blocked: {
            reason: 'rate-limit',
            resetAt: '2026-08-21T18:00:00.000Z',
          },
        }),
      ]);

      expect(row.status).toBe('succeeded');
      // The status was never the whole of the park. `resumesAt` asserts "the
      // system will handle it; acting is wasted effort" (`cockpit/dto`), and
      // on a run nothing will ever look at again that is a lie the operator
      // has no way to detect. It rode on the unguarded liveness write until
      // the #475 review moved it under this same guard.
      expect(row.resumesAt).toBeNull();
    });

    it('refuses to park a quarantined run', async () => {
      // VISION §8: a run cannot clear its own quarantine, and a
      // runner-reported block parking one would be doing exactly that.
      const row = withRunRow({ status: 'quarantined', resumesAt: null });

      await service.ingest(RUN_ID, [
        event({
          type: 'run.blocked',
          blocked: {
            reason: 'rate-limit',
            resetAt: '2026-08-21T18:00:00.000Z',
          },
        }),
      ]);

      expect(row.status).toBe('quarantined');
      // Neither half of the park lands. A quarantined run showing a resume
      // time would tell the operator it was being handled automatically,
      // which is the opposite of what quarantine means.
      expect(row.resumesAt).toBeNull();
    });

    it('does not park via a stale block event older than lastEventAt', async () => {
      // The same monotonic guard `lastEventAt` uses: an event too old to move
      // liveness forward must not move the status either.
      const row = withRunRow({
        status: 'running',
        lastEventAt: new Date('2026-08-21T11:00:00.000Z'),
        resumesAt: null,
      });

      await service.ingest(RUN_ID, [
        event({
          type: 'run.blocked',
          occurredAt: '2026-08-21T10:00:00.000Z',
          blocked: {
            reason: 'rate-limit',
            resetAt: '2026-08-21T18:00:00.000Z',
          },
        }),
      ]);

      expect(row.status).toBe('running');
      expect(row.lastEventAt).toEqual(new Date('2026-08-21T11:00:00.000Z'));
      expect(row.resumesAt).toBeNull();
    });
  });

  /**
   * The block a batch ENDS on, not merely one it contains (#475). A block
   * followed by something else in the same window describes a run that hit a
   * wall and either got past it or finished before the flush — parking it
   * anyway would be the wrong error of the two available, since the watchdog
   * eventually notices a real block through silence but nothing notices a
   * wrongly parked run.
   */
  describe('the block a batch ends on, not merely one it contains (#475)', () => {
    it('does not transit blocked when the same batch also concludes the run', async () => {
      const row = withRunRow({ status: 'running', resumesAt: null });

      await service.ingest(RUN_ID, [
        event({
          eventId: 'block',
          type: 'run.blocked',
          occurredAt: '2026-08-21T10:00:00.000Z',
          blocked: {
            reason: 'rate-limit',
            resetAt: '2026-08-21T18:00:00.000Z',
          },
        }),
        event({
          eventId: 'fail',
          type: 'run.failed',
          occurredAt: '2026-08-21T10:05:00.000Z',
          failure: { reason: 'killed for looping' },
        }),
      ]);

      expect(row.status).toBe('failed');
      expect(row.resumesAt).toBeNull();

      // Never passed through `blocked` on the way there.
      const statuses = prisma.run.updateMany.mock.calls
        .map(
          ([call]) => (call as { data: Record<string, unknown> }).data.status,
        )
        .filter(Boolean);
      expect(statuses).toEqual(['failed']);
    });

    it('does not park when a block is followed by a later heartbeat in the same batch', async () => {
      const row = withRunRow({ status: 'running' });

      await service.ingest(RUN_ID, [
        event({
          eventId: 'block',
          type: 'run.blocked',
          occurredAt: '2026-08-21T10:00:00.000Z',
          blocked: {
            reason: 'rate-limit',
            resetAt: '2026-08-21T18:00:00.000Z',
          },
        }),
        event({
          eventId: 'hb',
          type: 'run.heartbeat',
          occurredAt: '2026-08-21T10:05:00.000Z',
        }),
      ]);

      expect(row.status).toBe('running');
    });
  });

  describe('a blocked run that reports again (#254, #475)', () => {
    it('returns to running and clears resumesAt', async () => {
      const row = withRunRow({
        status: 'blocked',
        resumesAt: new Date('2026-08-21T18:00:00.000Z'),
        lastEventAt: new Date('2026-08-21T09:00:00.000Z'),
      });

      await service.ingest(RUN_ID, [event({ type: 'run.heartbeat' })]);

      expect(row.status).toBe('running');
      expect(row.resumesAt).toBeNull();
    });

    it('does not un-park via a stale heartbeat older than lastEventAt', async () => {
      const row = withRunRow({
        status: 'blocked',
        resumesAt: new Date('2026-08-21T18:00:00.000Z'),
        lastEventAt: new Date('2026-08-21T11:00:00.000Z'),
      });

      await service.ingest(RUN_ID, [
        event({ occurredAt: '2026-08-21T10:00:00.000Z' }),
      ]);

      expect(row.status).toBe('blocked');
      expect(row.resumesAt).toEqual(new Date('2026-08-21T18:00:00.000Z'));
    });

    it('still concludes normally when a terminal event arrives', async () => {
      const row = withRunRow({
        status: 'blocked',
        resumesAt: new Date('2026-08-21T18:00:00.000Z'),
      });

      await service.ingest(RUN_ID, [
        event({
          type: 'run.completed',
          occurredAt: '2026-08-21T11:00:00.000Z',
        }),
      ]);

      expect(row.status).toBe('succeeded');
      expect(row.endedAt).toEqual(new Date('2026-08-21T11:00:00.000Z'));
    });
  });

  describe('a redelivered block is a no-op (#475)', () => {
    it('does not rewrite the status or re-announce a park that already happened', async () => {
      // Seeded with `lastEventAt` at the instant of the block that parked it,
      // because that is what a redelivery actually looks like: the writer of
      // `blocked` sets both columns in one batch, so a `blocked` row with a
      // null `lastEventAt` is a state the service cannot produce.
      //
      // The distinction matters. This test used to seed exactly that
      // impossible row and lean on `blocked` being absent from
      // BLOCKABLE_STATUSES, which read as though the status set were the
      // protection. It is not — `advanced.count` is, the same monotonic gate
      // `lastEventAt` uses — and leaning on the set hid the case below, where
      // a genuinely newer block must be let through.
      const row = withRunRow({
        status: 'blocked',
        lastEventAt: new Date('2026-08-21T10:00:00.000Z'),
        resumesAt: new Date('2026-08-21T18:00:00.000Z'),
      });
      const logSpy = jest
        .spyOn(Logger.prototype, 'log')
        .mockImplementation(() => undefined);

      try {
        await service.ingest(RUN_ID, [
          event({
            type: 'run.blocked',
            blocked: {
              reason: 'rate-limit',
              resetAt: '2026-08-21T18:00:00.000Z',
            },
          }),
        ]);

        expect(row.status).toBe('blocked');
        expect(row.resumesAt).toEqual(new Date('2026-08-21T18:00:00.000Z'));
        expect(logSpy).not.toHaveBeenCalledWith(
          expect.stringContaining('reported blocked'),
        );
      } finally {
        logSpy.mockRestore();
      }
    });

    it('records a NEWER block without disturbing the plan it supersedes', async () => {
      // The behaviour this file used to own has MOVED, not gone. A runner that
      // hits a five-hour wall and then a weekly one reports a second, later
      // `resetAt`, and honouring the first plan would resume the run early and
      // re-block it — the loop #56's jitter exists to prevent.
      //
      // That used to be handled here, as a side effect: `blockRun` overwrote
      // `resumesAt` with each new reset. With #477 making the watchdog the
      // column's only writer, the supersession is noticed by the component
      // that owns the plan — `decideParking` re-parks when the current block's
      // `resetAt` is later than the plan on the row. What ingestion still owes
      // is the newer reset on the event, which is what the watchdog reads.
      const row = withRunRow({
        status: 'blocked',
        lastEventAt: new Date('2026-08-21T10:00:00.000Z'),
        resumesAt: new Date('2026-08-21T18:00:00.000Z'),
      });

      await service.ingest(RUN_ID, [
        event({
          eventId: 'clr-second-window',
          type: 'run.blocked',
          occurredAt: '2026-08-21T10:05:00.000Z',
          blocked: {
            reason: 'quota-exhausted',
            resetAt: '2026-08-22T02:00:00.000Z',
          },
        }),
      ]);

      expect(row.status).toBe('blocked');
      expect(row.resumesAt).toEqual(new Date('2026-08-21T18:00:00.000Z'));

      const [{ data }] = prisma.runEvent.createMany.mock.calls[0];
      expect(data[0].blockedUntil).toEqual(
        new Date('2026-08-22T02:00:00.000Z'),
      );
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

  describe('concluding the run (#202)', () => {
    // A terminal event used to be stored and change nothing: the poller
    // deliberately leaves the status to ingestion, and ingestion never picked
    // it up, so every run that ever executed stayed `running` forever — and
    // the projection's review path, which reads `status === 'succeeded'`,
    // could never fire.

    /** The conclude call is the last run.updateMany of an ingest. */
    const conclusion = () => {
      const calls = prisma.run.updateMany.mock.calls;
      return calls[calls.length - 1][0] as {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      };
    };

    it('marks the run succeeded on run.completed', async () => {
      await service.ingest(RUN_ID, [
        event({
          type: 'run.completed',
          occurredAt: '2026-08-21T11:00:00.000Z',
        }),
      ]);

      const { data } = conclusion();
      expect(data.status).toBe('succeeded');
      expect(data.endedAt).toEqual(new Date('2026-08-21T11:00:00.000Z'));
    });

    it('marks the run failed on run.failed, carrying why it stopped', async () => {
      await service.ingest(RUN_ID, [
        event({
          type: 'run.failed',
          failure: { reason: 'killed for looping' },
        }),
      ]);

      const { data } = conclusion();
      expect(data.status).toBe('failed');
      // The field the cockpit already reads, and the one #67's summary needs.
      expect(data.attentionReason).toBe('killed for looping');
    });

    it('cannot be reached without a reason, because the schema requires one', async () => {
      // `run.failed` carries `failure.reason` as a conditional requirement, so
      // a failure with no reason never gets past validation to be concluded.
      // The service's `?? 'run failed'` is belt-and-braces against a future
      // schema change, not a path a runner can take today — and asserting the
      // rejection is more honest than testing a fallback that cannot fire.
      await expect(
        service.ingest(RUN_ID, [event({ type: 'run.failed' })]),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('only concludes a run that has not finished yet', async () => {
      // The monotonic guard, in the WHERE clause for the same reason
      // `lastEventAt` guards there: a redelivered terminal event must not drag
      // a run back out of a terminal state, and a late run.failed must not
      // overwrite a succeeded that already landed.
      //
      // The set, not `running` alone (#254). `succeeded` and `failed` are
      // outside it, which is the whole of the idempotence; `quarantined` is
      // outside it because VISION §8 says a run cannot clear its own.
      await service.ingest(RUN_ID, [event({ type: 'run.completed' })]);
      expect(conclusion().where).toEqual({
        id: RUN_ID,
        status: { in: ['running', 'stalled', 'blocked'] },
      });
    });

    it('carries the pull request onto the run, with its number', async () => {
      // #107 gates surfacing on the checks of `headCommit`, so without these
      // the gate has nothing to ask GitHub about.
      await service.ingest(RUN_ID, [
        event({
          type: 'run.completed',
          result: {
            branch: 'factory/312-a3f91c2-a1',
            headCommit: 'a3f91c2b4d5e6f708192a3b4c5d6e7f809a1b2c3',
            pullRequestUrl: 'https://github.com/acme/app/pull/42',
          },
        }),
      ]);

      const { data } = conclusion();
      expect(data.pullRequestUrl).toBe('https://github.com/acme/app/pull/42');
      expect(data.pullRequestNumber).toBe(42);
      expect(data.headCommit).toBe('a3f91c2b4d5e6f708192a3b4c5d6e7f809a1b2c3');
    });

    it('does not write the branch, which is not a column on the run', async () => {
      // #159. `Run` has no `branch` column — the branch is the work order's,
      // and the runner reads `run.workOrder.branch` to fill this very field.
      // Writing it back made Prisma reject the whole `updateMany` with
      // `Unknown argument`, so a run that completed with a branch never
      // concluded and held its concurrency slot forever.
      //
      // This assertion is the only thing standing between that and a repeat:
      // `data` is a generic inference target, so `tsc` does not check it, and
      // a conditional spread is not excess-property-checked even under
      // `satisfies`.
      await service.ingest(RUN_ID, [
        event({
          type: 'run.completed',
          result: { branch: 'factory/312-a3f91c2-a1' },
        }),
      ]);

      expect(conclusion().data).not.toHaveProperty('branch');
    });

    it('leaves the pull request columns alone when the runner reported none', async () => {
      // Writing null would erase a URL an earlier event had already recorded.
      await service.ingest(RUN_ID, [event({ type: 'run.completed' })]);

      const { data } = conclusion();
      expect(data).not.toHaveProperty('pullRequestUrl');
      expect(data).not.toHaveProperty('headCommit');
    });

    it('does not conclude on a non-terminal event', async () => {
      await service.ingest(RUN_ID, [event({ type: 'run.progress' })]);

      // A progress event may return a stalled run to `running` (#254). What it
      // may never do is write a conclusion.
      for (const [call] of prisma.run.updateMany.mock.calls) {
        expect(['succeeded', 'failed']).not.toContain(
          (call as { data: Record<string, unknown> }).data.status,
        );
      }
    });

    it('takes the LAST terminal event when a batch carries more than one', async () => {
      // Malformed, but picking deterministically by when it happened beats
      // picking by array order.
      await service.ingest(RUN_ID, [
        event({
          eventId: 'late',
          type: 'run.failed',
          occurredAt: '2026-08-21T12:00:00.000Z',
          failure: { reason: 'killed for silence' },
        }),
        event({
          eventId: 'early',
          type: 'run.completed',
          occurredAt: '2026-08-21T11:00:00.000Z',
        }),
      ]);

      expect(conclusion().data.status).toBe('failed');
    });
  });

  /**
   * #254: a stalled run could never conclude, and `stalled` occupies a
   * concurrency slot — so every stall cost a slot for the life of the
   * deployment, and two of them wedged a `maxConcurrency: 2` runner
   * permanently. These tests run against a row the doubles actually apply
   * their WHERE to, because the bug was invisible to one that did not.
   */
  describe('concluding from a status other than running (#254)', () => {
    it('concludes a stalled run, so its slot comes back', async () => {
      const row = withRunRow({ status: 'stalled' });

      await service.ingest(RUN_ID, [
        event({
          type: 'run.completed',
          occurredAt: '2026-08-21T11:00:00.000Z',
        }),
      ]);

      expect(row.status).toBe('succeeded');
      expect(row.endedAt).toEqual(new Date('2026-08-21T11:00:00.000Z'));
    });

    it('concludes a blocked run whose runner reported it stopped', async () => {
      // A parked run can be cancelled while it waits — the poller's deadline
      // and budget passes both do exactly that — and the child then reports
      // `run.failed`. Leaving `blocked` out of the set would strand it the
      // same way `stalled` was stranded.
      const row = withRunRow({ status: 'blocked' });

      await service.ingest(RUN_ID, [
        event({
          type: 'run.failed',
          failure: { reason: 'cancelled (SIGTERM)' },
        }),
      ]);

      expect(row.status).toBe('failed');
      expect(row.attentionReason).toBe('cancelled (SIGTERM)');
    });

    it('refuses to conclude a quarantined run', async () => {
      // VISION §8: a run cannot clear its own quarantine. A runner-reported
      // terminal event concluding one would be it doing precisely that, which
      // is why the guard is a named set rather than "anything not terminal".
      const row = withRunRow({ status: 'quarantined' });

      await service.ingest(RUN_ID, [event({ type: 'run.completed' })]);

      expect(row.status).toBe('quarantined');
      expect(row.endedAt).toBeUndefined();
    });

    it('makes a redelivered terminal event a no-op', async () => {
      // The property the old narrow guard was protecting, preserved: it never
      // came from the value being `running`, it comes from the status CHANGING
      // on the first write.
      const row = withRunRow({ status: 'stalled' });
      const completed = event({
        eventId: 'clr-terminal',
        type: 'run.completed',
        occurredAt: '2026-08-21T11:00:00.000Z',
      });

      await service.ingest(RUN_ID, [completed]);
      expect(row.status).toBe('succeeded');

      // Second delivery of the same event: the row already holds it, so the
      // insert skips it and the conclusion must match nothing.
      prisma.runEvent.createMany.mockResolvedValue({ count: 0 });
      await expect(service.ingest(RUN_ID, [completed])).resolves.toEqual({
        accepted: 0,
        duplicates: 1,
      });

      expect(row.status).toBe('succeeded');
      expect(row.endedAt).toEqual(new Date('2026-08-21T11:00:00.000Z'));
    });

    it('will not let a late run.failed overwrite a succeeded that landed', async () => {
      const row = withRunRow({ status: 'running' });

      await service.ingest(RUN_ID, [
        event({
          eventId: 'done',
          type: 'run.completed',
          occurredAt: '2026-08-21T11:00:00.000Z',
        }),
      ]);
      await service.ingest(RUN_ID, [
        event({
          eventId: 'late',
          type: 'run.failed',
          occurredAt: '2026-08-21T12:00:00.000Z',
          failure: { reason: 'killed for silence' },
        }),
      ]);

      expect(row.status).toBe('succeeded');
      expect(row.attentionReason).toBeUndefined();
    });
  });

  /**
   * The other half of #254: nothing un-stalled a run either, so even a run
   * that never concluded stayed `stalled` while it was demonstrably alive.
   *
   * The decision recorded here is that a resumed run returns to `running`.
   * `Run.status` is present tense, and the operator-facing reads built on it
   * (the daily brief, the snapshot totals) state things about a stalled run
   * that are false of one that is reporting again. The record that it stalled
   * lives in the `Escalation` (`progressStoppedAt`) and in the append-only
   * event stream, neither of which this touches — and this transition is what
   * gives #232's stall durations an end to measure to.
   */
  describe('a stalled run that reports again (#254)', () => {
    it('returns to running', async () => {
      const row = withRunRow({
        status: 'stalled',
        lastEventAt: new Date('2026-08-21T09:00:00.000Z'),
      });

      await service.ingest(RUN_ID, [event({ type: 'run.heartbeat' })]);

      expect(row.status).toBe('running');
      expect(row.lastEventAt).toEqual(new Date('2026-08-21T10:00:00.000Z'));
    });

    it('does not un-stall on an event older than the run already has', async () => {
      // The same monotonic guard `lastEventAt` uses, reused rather than
      // re-derived: an event that cannot make a live run look staler must not
      // make a stalled one look alive.
      const row = withRunRow({
        status: 'stalled',
        lastEventAt: new Date('2026-08-21T11:00:00.000Z'),
      });

      await service.ingest(RUN_ID, [
        event({ occurredAt: '2026-08-21T10:00:00.000Z' }),
      ]);

      expect(row.status).toBe('stalled');
      expect(row.lastEventAt).toEqual(new Date('2026-08-21T11:00:00.000Z'));
    });

    it('leaves attentionReason alone', async () => {
      // The poller wrote "nobody is watching this run", and that stays true
      // whether or not the run is reporting. The cockpit drains its attention
      // panel on the escalation lifecycle, not on this field, so clearing it
      // would erase an explanation without resolving anything.
      const row = withRunRow({
        status: 'stalled',
        attentionReason: 'No runner handle in this process.',
      });

      await service.ingest(RUN_ID, [event({ type: 'run.heartbeat' })]);

      expect(row.status).toBe('running');
      expect(row.attentionReason).toBe('No runner handle in this process.');
    });

    it('cannot drag a concluded run back out of its terminal state', async () => {
      const row = withRunRow({ status: 'succeeded' });

      await service.ingest(RUN_ID, [event({ type: 'run.heartbeat' })]);

      expect(row.status).toBe('succeeded');
    });

    it('never passes through running when the batch also concludes it', async () => {
      // Writing `running` on the way to `succeeded` would put a state through
      // the row that never happened, and anything watching status transitions
      // would see a resume that did not occur.
      const row = withRunRow({ status: 'stalled' });

      await service.ingest(RUN_ID, [event({ type: 'run.completed' })]);

      const statuses = prisma.run.updateMany.mock.calls
        .map(
          ([call]) => (call as { data: Record<string, unknown> }).data.status,
        )
        .filter(Boolean);
      expect(statuses).toEqual(['succeeded']);
      expect(row.status).toBe('succeeded');
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
