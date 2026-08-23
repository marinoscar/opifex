import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { runEventSchema } from './runs.dto';

/**
 * The activity feed: the normalized event floor across every run.
 *
 * Distinct from `GET /runs/{id}/events`, which is ONE run's timeline. Same
 * row shape, different question — "what is the factory doing" rather than
 * "what did this run do" — and a different query, because spanning runs means
 * every row has to name which run and which work order it belongs to or the
 * feed is a list of sentences with no subject.
 */

/**
 * How many events one page carries.
 *
 * `RunEvent` is high-volume (#39): a single run emits a progress event per
 * tool call plus heartbeats, so a handful of live runs produces a feed that
 * scrolls faster than anyone reads. The dashboard panel asks for 20, and the
 * default matches it rather than being generous — a feed nobody can keep up
 * with is not more informative than one they can.
 */
export const EVENTS_MAX_PAGE_SIZE = 200;
export const EVENTS_FEED_DEFAULT_PAGE_SIZE = 20;

export const eventsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(EVENTS_MAX_PAGE_SIZE)
    .default(EVENTS_FEED_DEFAULT_PAGE_SIZE),
  /** Only events of this type. */
  type: z
    .enum([
      'run.started',
      'run.heartbeat',
      'run.progress',
      'run.blocked',
      'run.completed',
      'run.failed',
    ])
    .optional(),
  /** Only events from this source — `runner`, `git` or `control-plane`. */
  source: z.enum(['runner', 'git', 'control-plane']).optional(),
});

export class EventsQueryDto extends createZodDto(eventsQuerySchema) {}

/**
 * The same row the run timeline serves.
 *
 * Reused rather than redeclared: two schemas for one concept drift, and the
 * cockpit has ONE `RunEvent` type that both endpoints feed. If the feed ever
 * needs a field the timeline does not, that is the moment to split them — not
 * before.
 */
export const activityEventSchema = runEventSchema;

export class ActivityEventDto extends createZodDto(activityEventSchema) {}
