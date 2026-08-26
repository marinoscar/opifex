import { prismaMock, resetPrismaMock } from '../../test/mocks/prisma.mock';
import { MASK } from '../common/crypto/redact';
import { AuditEventsService } from './audit-events.service';
import type { AuditEventListQueryDto } from './dto/audit-event-list-query.dto';
import { auditEventListQuerySchema } from './dto/audit-event-list-query.dto';

/**
 * The first read path `audit_events` has ever had.
 *
 * The assertion worth reading is the redaction one. Rows written before #337
 * landed can hold a credential in the clear, and this endpoint is the first
 * thing that would ever hand one back — so the read path redacts as well as
 * the write path, and that has to be a test rather than an intention.
 */
function query(
  overrides: Partial<AuditEventListQueryDto> = {},
): AuditEventListQueryDto {
  return auditEventListQuerySchema.parse(overrides) as AuditEventListQueryDto;
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-4000-8000-00000000000a',
    action: 'operator_settings:set',
    targetType: 'operator_settings',
    targetId: 'dispatch.enabled',
    actorUserId: '00000000-0000-4000-8000-000000000001',
    meta: { key: 'dispatch.enabled', from: false, to: true },
    createdAt: new Date('2026-08-26T10:00:00.000Z'),
    actorUser: {
      id: '00000000-0000-4000-8000-000000000001',
      email: 'operator@example.com',
      displayName: 'The Operator',
    },
    ...overrides,
  };
}

describe('AuditEventsService (#338)', () => {
  let service: AuditEventsService;

  beforeEach(() => {
    resetPrismaMock();
    service = new AuditEventsService(prismaMock);
  });

  it('returns a flat paginated page with the actor resolved', async () => {
    prismaMock.auditEvent.findMany.mockResolvedValue([row()]);
    prismaMock.auditEvent.count.mockResolvedValue(42);

    const result = await service.list(query({ pageSize: 20 }));

    expect(result).toMatchObject({
      total: 42,
      page: 1,
      pageSize: 20,
      totalPages: 3,
    });
    expect(result.items[0]).toMatchObject({
      action: 'operator_settings:set',
      targetType: 'operator_settings',
      targetId: 'dispatch.enabled',
      createdAt: '2026-08-26T10:00:00.000Z',
      actor: { email: 'operator@example.com' },
    });
  });

  it('filters by targetType, which is what History actually asks for', async () => {
    prismaMock.auditEvent.findMany.mockResolvedValue([]);
    prismaMock.auditEvent.count.mockResolvedValue(0);

    await service.list(query({ targetType: 'operator_settings' }));

    expect(prismaMock.auditEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { targetType: 'operator_settings' },
      }),
    );
  });

  it('combines the filters rather than letting the last one win', async () => {
    prismaMock.auditEvent.findMany.mockResolvedValue([]);
    prismaMock.auditEvent.count.mockResolvedValue(0);

    await service.list(
      query({
        targetType: 'operator_settings',
        targetId: 'github.token',
        action: 'operator_settings:set',
        actorUserId: '00000000-0000-4000-8000-000000000001',
      }),
    );

    expect(prismaMock.auditEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          targetType: 'operator_settings',
          targetId: 'github.token',
          action: 'operator_settings:set',
          actorUserId: '00000000-0000-4000-8000-000000000001',
        },
      }),
    );
  });

  it('bounds a time range with an exclusive upper edge', async () => {
    prismaMock.auditEvent.findMany.mockResolvedValue([]);
    prismaMock.auditEvent.count.mockResolvedValue(0);

    await service.list(
      query({
        since: '2026-08-01T00:00:00.000Z',
        until: '2026-08-26T00:00:00.000Z',
      }),
    );

    // `lt`, not `lte`: paging backwards by "the oldest createdAt I have seen"
    // would otherwise re-serve the boundary row on every page.
    expect(prismaMock.auditEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          createdAt: {
            gte: new Date('2026-08-01T00:00:00.000Z'),
            lt: new Date('2026-08-26T00:00:00.000Z'),
          },
        },
      }),
    );
  });

  it('sorts newest first, with a tiebreaker so a page boundary is stable', async () => {
    prismaMock.auditEvent.findMany.mockResolvedValue([]);
    prismaMock.auditEvent.count.mockResolvedValue(0);

    await service.list(query());

    // `createdAt` is not unique — several rows written in one transaction
    // share it — so an unstable sort would drop or duplicate one across a page
    // boundary.
    expect(prismaMock.auditEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    );
  });

  it('pages with skip and take', async () => {
    prismaMock.auditEvent.findMany.mockResolvedValue([]);
    prismaMock.auditEvent.count.mockResolvedValue(0);

    await service.list(query({ page: 3, pageSize: 25 }));

    expect(prismaMock.auditEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 50, take: 25 }),
    );
  });

  it('redacts a credential an older build wrote into meta in the clear', async () => {
    // #337 redacts at write time now, which protects nothing already on disk.
    // This endpoint is the first thing that could ever serve such a row.
    prismaMock.auditEvent.findMany.mockResolvedValue([
      row({
        targetType: 'system_settings',
        meta: {
          settings: { github: { token: 'ghp_Kx7Vd2Nq9Zb4Mr6Wt3Jc8Ly5Hs' } },
        },
      }),
    ]);
    prismaMock.auditEvent.count.mockResolvedValue(1);

    const result = await service.list(query());

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('ghp_Kx7Vd2Nq9Zb4Mr6Wt3Jc8Ly5Hs');
    expect(serialized).toContain(MASK);
  });

  it('leaves a non-secret meta alone, so History still says something', async () => {
    prismaMock.auditEvent.findMany.mockResolvedValue([row()]);
    prismaMock.auditEvent.count.mockResolvedValue(1);

    const result = await service.list(query());

    expect(result.items[0].meta).toEqual({
      key: 'dispatch.enabled',
      from: false,
      to: true,
    });
  });

  it('serves a row whose actor has been deleted', async () => {
    // `onDelete: SetNull`, and a row with no actor at all — the reconciler and
    // the cron tasks write plenty of those. Neither may drop the event.
    prismaMock.auditEvent.findMany.mockResolvedValue([
      row({ actorUserId: null, actorUser: null }),
    ]);
    prismaMock.auditEvent.count.mockResolvedValue(1);

    const result = await service.list(query());

    expect(result.items[0]).toMatchObject({ actorUserId: null, actor: null });
  });

  describe('the query schema', () => {
    it('defaults to the newest twenty', () => {
      expect(auditEventListQuerySchema.parse({})).toMatchObject({
        page: 1,
        pageSize: 20,
        sortOrder: 'desc',
      });
    });

    it('refuses a page size big enough to ask for the whole history', () => {
      expect(
        auditEventListQuerySchema.safeParse({ pageSize: 1000 }).success,
      ).toBe(false);
    });

    it('coerces the numbers a query string actually delivers', () => {
      expect(
        auditEventListQuerySchema.parse({ page: '3', pageSize: '50' }),
      ).toMatchObject({ page: 3, pageSize: 50 });
    });
  });
});
