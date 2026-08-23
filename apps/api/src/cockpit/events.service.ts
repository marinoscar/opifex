import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import {
  fromPrismaEventSource,
  fromPrismaEventType,
  toPrismaEventSource,
  toPrismaEventType,
} from '../run-events/run-event.types';
import type {
  RunEventTypeName,
  RunEventSourceName,
} from '../run-events/run-event.types';
import { EVENTS_FEED_DEFAULT_PAGE_SIZE } from './dto/events.dto';
import type { RunEventView } from './dto/runs.dto';

/**
 * What the factory is doing, across every run.
 *
 * ## Not the same query as one run's timeline
 *
 * `RunsService.events` answers "what did THIS run do" and already knows which
 * work order it belongs to, so it resolves the identity once. This spans runs,
 * so every row has to carry its own — a feed of "edited a file" with no
 * subject is a list of sentences nobody can act on.
 *
 * ## The three vocabularies, again
 *
 * Postgres cannot hold a dot in an enum label, so the generated client says
 * `run_started` where the wire schema, every runner and the cockpit say
 * `run.started` — and `source` is spelled differently again (`control_plane`
 * vs `control-plane`). The compiler catches the first mismatch and NOT the
 * second, which is how it nearly shipped in #164. Both directions are used
 * here: OUT for what is returned, and IN for the filters, because a caller
 * filtering `?type=run.started` must not have to know the database's spelling.
 */
@Injectable()
export class EventsService {
  constructor(private readonly prisma: PrismaService) {}

  async feed(query: {
    page?: number;
    pageSize?: number;
    type?: string;
    source?: string;
  }): Promise<{
    items: RunEventView[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? EVENTS_FEED_DEFAULT_PAGE_SIZE;

    const where: Prisma.RunEventWhereInput = {
      // Translated INTO the database's spelling. A caller asking for
      // `run.started` — the only name that appears in the schema, in a
      // runner's output, or in this API's own responses — would otherwise
      // match nothing and get an empty feed rather than an error.
      ...(query.type
        ? { type: toPrismaEventType(query.type as RunEventTypeName) as never }
        : {}),
      ...(query.source
        ? { source: toPrismaFeedSource(query.source) as never }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.runEvent.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        // Newest first, with the same tiebreak the timeline uses: two events
        // can share a reported millisecond, and an unstable sort would shuffle
        // them between pages so a reader could see one twice and another never.
        orderBy: [{ occurredAt: 'desc' }, { recordedAt: 'desc' }],
        select: {
          id: true,
          type: true,
          source: true,
          occurredAt: true,
          runId: true,
          summary: true,
          // The identity, not the row id — this is rendered to a human in the
          // mono token, and a uuid tells them nothing about which work order
          // they are looking at.
          run: { select: { workOrder: { select: { identity: true } } } },
        },
      }),
      this.prisma.runEvent.count({ where }),
    ]);

    return {
      items: rows.map((row) => ({
        id: row.id,
        type: fromPrismaEventType(row.type) as RunEventView['type'],
        source: fromPrismaEventSource(row.source) as RunEventView['source'],
        occurredAt: row.occurredAt.toISOString(),
        runId: row.runId,
        workOrderId: row.run.workOrder.identity,
        summary: row.summary,
      })),
      total,
      page,
      pageSize,
    };
  }
}

/**
 * The cockpit's source spelling into the database's.
 *
 * `toPrismaEventSource` takes the WIRE vocabulary
 * (`control-plane-synthesized`); the cockpit and this endpoint's filter use
 * the short one (`control-plane`). Mapping through the wire name rather than
 * writing a third table keeps one source of truth for the translation, and
 * makes the difference between the two vocabularies explicit rather than
 * something a reader has to notice.
 */
function toPrismaFeedSource(source: string): string {
  const wire: Record<string, RunEventSourceName> = {
    runner: 'runner-reported',
    git: 'git-derived',
    'control-plane': 'control-plane-synthesized',
  };
  return toPrismaEventSource(wire[source]);
}
