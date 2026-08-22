import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  BLOCKED_REASONS,
  RUN_EVENT_SCHEMA_VERSION,
  RUN_EVENT_SOURCES,
  RUN_EVENT_TYPES,
  toPrismaEventSource,
  toPrismaEventType,
  type RunEventTypeName,
} from './run-event.types';

/**
 * These types are hand-written against `run-event.schema.json` because #35's
 * codegen does not exist yet. That is only safe while the two agree, and
 * nothing else in the system would notice them drifting — a value added to the
 * schema and missing here would simply never be handled.
 */
const schema = JSON.parse(
  readFileSync(
    join(__dirname, '..', '..', '..', '..', 'schemas', 'run-event.schema.json'),
    'utf8',
  ),
) as {
  properties: Record<string, { enum?: string[]; const?: string }>;
  allOf: { then?: { properties?: Record<string, unknown> } }[];
};

describe('run-event types, pinned against the schema', () => {
  it('matches the schema version', () => {
    expect(RUN_EVENT_SCHEMA_VERSION).toBe(schema.properties.schemaVersion.const);
  });

  it('matches the six event types exactly', () => {
    expect([...RUN_EVENT_TYPES].sort()).toEqual([...schema.properties.type.enum!].sort());
  });

  it('matches the three sources exactly', () => {
    expect([...RUN_EVENT_SOURCES].sort()).toEqual([...schema.properties.source.enum!].sort());
  });

  it('matches the blocked reasons exactly', () => {
    // Buried inside the conditional `allOf` branch for run.blocked, which is
    // why this digs rather than reading a top-level property.
    const branch = schema.allOf.find(
      (b) =>
        (b.then?.properties as Record<string, { properties?: Record<string, { enum?: string[] }> }>)
          ?.blocked?.properties?.reason?.enum !== undefined,
    );
    const reasons = (
      branch!.then!.properties as Record<
        string,
        { properties: Record<string, { enum: string[] }> }
      >
    ).blocked.properties.reason.enum;

    expect([...BLOCKED_REASONS].sort()).toEqual([...reasons].sort());
  });
});

describe('mapping onto the Prisma enums', () => {
  it.each<[RunEventTypeName, string]>([
    ['run.started', 'run_started'],
    ['run.heartbeat', 'run_heartbeat'],
    ['run.progress', 'run_progress'],
    ['run.blocked', 'run_blocked'],
    ['run.completed', 'run_completed'],
    ['run.failed', 'run_failed'],
  ])('maps %s to %s', (wire, prisma) => {
    expect(toPrismaEventType(wire)).toBe(prisma);
  });

  it('produces a value the Prisma client actually accepts, for every type', async () => {
    // The mapping is a string transform, so nothing but this stops it from
    // producing a plausible label the database would reject at insert time.
    const { RunEventType } = await import('@prisma/client');
    const accepted = new Set(Object.keys(RunEventType));

    for (const type of RUN_EVENT_TYPES) {
      expect(accepted.has(toPrismaEventType(type))).toBe(true);
    }
  });

  it('produces a value the Prisma client accepts, for every source', async () => {
    const { RunEventSource } = await import('@prisma/client');
    const accepted = new Set(Object.keys(RunEventSource));

    for (const source of RUN_EVENT_SOURCES) {
      expect(accepted.has(toPrismaEventSource(source))).toBe(true);
    }
  });

  it('keeps the three sources distinct after mapping', () => {
    // Collapsing two of them would be the exact masquerade VISION §9 forbids,
    // and a careless mapping is how that would happen quietly.
    const mapped = RUN_EVENT_SOURCES.map(toPrismaEventSource);

    expect(new Set(mapped).size).toBe(RUN_EVENT_SOURCES.length);
  });
});
