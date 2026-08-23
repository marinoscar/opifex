/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Written by `npm run contracts:generate` from the schema named below, which
 * is the contract. Edit that, re-run the generator, and commit both.
 * `npm run contracts:check` fails CI when this file and the schema disagree.
 */

// Source: schemas/run-event.schema.json

/**
 * The normalized event floor every runner maps into (VISION.MD §9). Exactly six types. A seventh requires a schema version bump, which is the point: the floor is what makes runners comparable, and a floor that grows on demand is not a floor.
 */
export type RunEvent = {
  /**
   * Version of this schema the event claims to conform to. Stored with the event so an old payload stays readable after the schema moves on. Any 1.x version is accepted: within a major, every change is an added optional field, so a document written against an earlier minor still validates here (ADR-0010). A 2.x document is rejected by this file — majors get their own.
   */
  schemaVersion: string;
  /**
   * Stable identifier chosen by the SENDER, not by Opifex. This is what makes ingestion idempotent: a runner retrying a delivery reuses the id, and the second delivery is recognised rather than stored twice (#53).
   */
  eventId: string;
  runId: string;
  /**
   * The deterministic work-order identity, wo_{repo}_{issue}_{commit7}_a{attempt}. Carried on every event so a trace can be assembled without joining through the run.
   */
  workOrderId: string;
  /**
   * The six normalized types. Closed on purpose.
   */
  type:
    | 'run.started'
    | 'run.heartbeat'
    | 'run.progress'
    | 'run.blocked'
    | 'run.completed'
    | 'run.failed';
  /**
   * Where this event came from. REQUIRED, and deliberately given no default. VISION §9: 'a synthesized event must never masquerade as a report.' A watchdog that cannot tell 'the runner told me it was blocked' from 'I decided it looked blocked' will eventually make an unrecoverable decision on its own guess — so a sender that omits this gets an error, not a plausible assumption.
   */
  source: 'runner-reported' | 'git-derived' | 'control-plane-synthesized';
  /**
   * When the event actually happened, per its source — NOT when Opifex stored it. The gap between the two is detection latency, success metric 1.
   */
  occurredAt: string;
  /**
   * One line, for a human reading a timeline.
   */
  summary?: string;
  /**
   * Which runner produced this, as key@version. Absent for git-derived and control-plane-synthesized events, which no runner produced.
   */
  runner?: string;
  /**
   * OpenTelemetry correlation. VISION §9 maps one trace per work order and one span per turn or tool call.
   */
  trace?: {
    traceId: string;
    spanId?: string;
  };
  /**
   * Cost and tokens attributed to THIS EVENT, and only this event. INCREMENTAL, never cumulative: the control plane sums a run's events to get its total (#183), so a runner that repeated a running total on every event would multiply its own spend. A runner that can only report once should report once, on its terminal event, with the whole figure — which is what claude-code-local does. Absent means NOT REPORTED, which is different from zero — VISION §6 makes cost reporting a declared capability, so a runner that cannot report cost must not look like one that spent nothing.
   */
  cost?: {
    usd?: number;
    tokensInput?: number;
    tokensOutput?: number;
  };
};

/** The version a producer should write, from the schema's `default`. */
export const RUN_EVENT_SCHEMA_VERSION = '1.0.0';

/** Every value `type` may take. Closed — adding one is a major bump (ADR-0010). */
export const RUN_EVENT_TYPE = [
  'run.started',
  'run.heartbeat',
  'run.progress',
  'run.blocked',
  'run.completed',
  'run.failed',
] as const;

/** Every value `source` may take. Closed — adding one is a major bump (ADR-0010). */
export const RUN_EVENT_SOURCE = [
  'runner-reported',
  'git-derived',
  'control-plane-synthesized',
] as const;
