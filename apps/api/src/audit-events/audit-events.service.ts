import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { redactSettingsMeta } from '../common/crypto/redact';
import { PrismaService } from '../prisma/prisma.service';
import type { AuditEventListQueryDto } from './dto/audit-event-list-query.dto';
import type { AuditEventResponse } from './dto/audit-event-response.dto';

/**
 * The first read path `audit_events` has ever had (#338, epic #332).
 *
 * Nine services write to this table and, until this file, `auditEvent.findMany`
 * appeared nowhere in the API — every row written since the foundation shipped
 * has been write-only. The Control Center's History section is what needs
 * them, but the table is not settings-specific and neither is this: it is the
 * general read model, filtered.
 *
 * ## Why the meta is redacted on the way out as well as on the way in
 *
 * `redactSettingsMeta` runs at write time now (#337), which is the pass that
 * actually protects the table, because nothing added afterwards removes a
 * plaintext secret from rows already on disk. Running it again here is for the
 * rows written before that landed and for any future writer that forgets. It
 * costs a walk of a small JSON object per row and it means this endpoint
 * cannot become the thing that hands out a credential somebody else logged by
 * mistake.
 */
@Injectable()
export class AuditEventsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: AuditEventListQueryDto): Promise<{
    items: AuditEventResponse[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  }> {
    const {
      page,
      pageSize,
      targetType,
      targetId,
      action,
      actorUserId,
      since,
      until,
      sortOrder,
    } = query;

    const where: Prisma.AuditEventWhereInput = {};

    if (targetType) where.targetType = targetType;
    if (targetId) where.targetId = targetId;
    if (action) where.action = action;
    if (actorUserId) where.actorUserId = actorUserId;

    if (since || until) {
      where.createdAt = {
        ...(since ? { gte: new Date(since) } : {}),
        // Exclusive, so that paging by `until = the oldest createdAt seen` does
        // not re-serve the boundary row on every page.
        ...(until ? { lt: new Date(until) } : {}),
      };
    }

    const [rows, total] = await Promise.all([
      this.prisma.auditEvent.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        // A tiebreaker on `id`, because `createdAt` is not unique: several
        // rows written inside one transaction share a timestamp, and an
        // unstable sort would drop or duplicate one across a page boundary.
        orderBy: [{ createdAt: sortOrder }, { id: sortOrder }],
        include: {
          actorUser: { select: { id: true, email: true, displayName: true } },
        },
      }),
      this.prisma.auditEvent.count({ where }),
    ]);

    return {
      items: rows.map((row) => ({
        id: row.id,
        action: row.action,
        targetType: row.targetType,
        targetId: row.targetId,
        actorUserId: row.actorUserId,
        actor: row.actorUser
          ? {
              id: row.actorUser.id,
              email: row.actorUser.email,
              displayName: row.actorUser.displayName,
            }
          : null,
        meta: redactMeta(row.meta),
        createdAt: row.createdAt.toISOString(),
      })),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }
}

/**
 * The second redaction pass. See the class header for why there is one.
 *
 * A non-object `meta` — a bare string or number some writer stored — has no
 * field names to match on, so it is passed through as-is. That is not a hole
 * being waved past: `redactSettingsMeta` masks by FIELD NAME, and a scalar has
 * none, so there is nothing this function could do with it other than drop it
 * and lose the audit record's content.
 */
function redactMeta(meta: Prisma.JsonValue): unknown {
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
    return meta;
  }

  return redactSettingsMeta(meta as Record<string, unknown>);
}
