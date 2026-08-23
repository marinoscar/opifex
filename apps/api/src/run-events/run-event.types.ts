/**
 * The wire types for `schemas/run-event.schema.json`, DERIVED from the
 * generated contract rather than restated here.
 *
 * This file used to hold the whole shape by hand, with a note that it was an
 * interim and #35 would "delete rather than reconcile" it. #35 landed: the
 * definitions are gone, and everything below is either an alias of a generated
 * type or a projection of one. A schema change now reaches this file through
 * `npm run contracts:generate`, and CI fails if the generated output is stale.
 *
 * The names are kept because fifty call sites use them, and renaming types is
 * not what #35 is about.
 *
 * What remains genuinely hand-written is the Prisma enum mapping at the bottom,
 * which is not part of the contract — it translates the wire spelling into the
 * generated client's, and belongs to this repository's database rather than to
 * any runner.
 */

import type { RunEvent } from '../contracts/generated';
import {
  RUN_EVENT_REASON,
  RUN_EVENT_SCHEMA_VERSION as GENERATED_SCHEMA_VERSION,
  RUN_EVENT_SOURCE,
  RUN_EVENT_TYPE,
} from '../contracts/generated';

export const RUN_EVENT_SCHEMA_VERSION = GENERATED_SCHEMA_VERSION;

/** The six normalized types. Closed — a seventh is a major bump (ADR-0010). */
export type RunEventTypeName = (typeof RUN_EVENT_TYPE)[number];
export const RUN_EVENT_TYPES: readonly RunEventTypeName[] = RUN_EVENT_TYPE;

/**
 * Where the event came from. VISION §9: a synthesized event must never
 * masquerade as a report, which is why this is required and has no default.
 */
export type RunEventSourceName = (typeof RUN_EVENT_SOURCE)[number];
export const RUN_EVENT_SOURCES: readonly RunEventSourceName[] =
  RUN_EVENT_SOURCE;

/**
 * Why a run is blocked. `unknown` exists so a runner that cannot tell still has
 * something honest to say; the watchdog treats it as blocked-with-no-known-
 * reset rather than leaving the run looking healthy forever.
 */
export type BlockedReason = (typeof RUN_EVENT_REASON)[number];
export const BLOCKED_REASONS: readonly BlockedReason[] = RUN_EVENT_REASON;

// Projections of the generated event. `NonNullable` strips the optionality the
// property carries, leaving the object's own shape — so these track the schema
// without restating a single field.
export type RunEventTrace = NonNullable<RunEvent['trace']>;

/**
 * Incremental cost for one event. Absent means NOT REPORTED, which differs from
 * zero: VISION §6 makes cost reporting a declared capability, so a runner that
 * cannot report cost must not look like one that spent nothing.
 */
export type RunEventCost = NonNullable<RunEvent['cost']>;

/**
 * Tool name plus a normalized argument DIGEST — not the raw arguments, which
 * can be enormous and can contain secrets. Loop detection (#55) only ever
 * compares them for equality.
 */
export type RunEventTool = NonNullable<RunEvent['tool']>;
export type RunEventBlocked = NonNullable<RunEvent['blocked']>;
export type RunEventResult = NonNullable<RunEvent['result']>;
export type RunEventFailure = NonNullable<RunEvent['failure']>;

/**
 * One event on the wire.
 *
 * The generated type is the SUPERSET: every conditionally-required property is
 * present and optional, because JSON Schema's `if`/`then` has no static
 * TypeScript equivalent. The conditions themselves are enforced by
 * `RunEventValidator` at ingestion, so a `run.blocked` event carrying no
 * `blocked` object is rejected there even though this type would accept it.
 */
export type RunEventPayload = RunEvent;

// ---------------------------------------------------------------------------
// Mapping onto the Prisma enums
// ---------------------------------------------------------------------------
//
// The database cannot hold a dot in an enum label, and Prisma's `@map` handles
// that at the SQL level — but the generated CLIENT enum uses the underscore
// form, so a translation is needed in one direction. Kept here, next to the
// wire types, rather than scattered across the ingestion and watcher paths.

/** `run.started` -> `run_started`, the generated Prisma client's spelling. */
export function toPrismaEventType(type: RunEventTypeName): string {
  return type.replace('.', '_');
}

/** `control-plane-synthesized` -> `control_plane`. */
export function toPrismaEventSource(source: RunEventSourceName): string {
  switch (source) {
    case 'runner-reported':
      return 'runner';
    case 'git-derived':
      return 'git';
    case 'control-plane-synthesized':
      return 'control_plane';
  }
}

// ---------------------------------------------------------------------------
// And back out again, for the cockpit read models (#80)
// ---------------------------------------------------------------------------
//
// The comment above said a translation is needed "in one direction". That was
// true until something had to READ these rows and show them to a human. The
// reverse mappers live here for the same reason the forward ones do: three
// vocabularies exist for one concept, and keeping the translations apart is
// how two of them silently drift.
//
// The three vocabularies, which are genuinely all different:
//
//   wire (schemas/run-event.schema.json)  run.started   runner-reported
//   Prisma client enum                    run_started   control_plane
//   cockpit (apps/web/src/types)          run.started   control-plane
//
// The dots come back because the cockpit renders the wire vocabulary — which
// is correct, since that is the name an operator will find in the schema.

/** `run_started` -> `run.started`, the name the wire and the cockpit use. */
export function fromPrismaEventType(type: string): string {
  return type.replace('_', '.');
}

/**
 * `control_plane` -> `control-plane`, the cockpit's spelling.
 *
 * NOT the wire spelling (`control-plane-synthesized`): the cockpit uses a
 * shorter vocabulary for this one field because it renders the value as a
 * visible label on every row, and VISION §9's rule that *a synthesized event
 * must never masquerade as a report* is served by the label being READ, not by
 * it being long.
 */
export function fromPrismaEventSource(source: string): string {
  return source.replace('_', '-');
}
