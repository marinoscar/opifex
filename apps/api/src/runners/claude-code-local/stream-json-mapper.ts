import { createHash, randomUUID } from 'node:crypto';

import {
  RUN_EVENT_SCHEMA_VERSION,
  type RunEventPayload,
  type RunEventTypeName,
} from '../../run-events/run-event.types';

/**
 * `stream-json` → the six normalized types (#33).
 *
 * ## Written against a captured transcript, not against memory
 *
 * Every shape this file matches was read out of a real
 * `claude -p --output-format stream-json --verbose` run: the envelope keys,
 * where `tool_use` sits inside `message.content`, the fact that only
 * `assistant` and `user` lines carry a `timestamp`, and the exact shape of
 * `rate_limit_info`. #61 requires the manifest be *"verified against observed
 * behaviour, not aspirational"*, and a mapper built from recollection would
 * make the manifest a claim about a format nobody looked at.
 *
 * A sanitised copy of that transcript is the fixture in
 * `stream-json-fixtures.ts`, so the next person can see what these rules were
 * written against rather than trusting this paragraph.
 *
 * ## Unmappable lines are dropped, never invented
 *
 * ADR 0006 is explicit:
 *
 * > Map to the six normalized types (#33) and **drop what does not map**,
 * > rather than inventing a type. An unmappable line is logged once per run,
 * > not escalated: a new CLI event type is a version skew, not a stalled run.
 *
 * So this returns a `drop` outcome with a reason rather than a best guess. A
 * seventh event type is a schema version bump; it is never something a parser
 * decides on its own at three in the morning.
 *
 * ## The result line does not end the run
 *
 * A `result` line is turned into {@link StreamResult}, NOT into a
 * `run.completed`. The process's exit code is what ends a run — VISION §8 puts
 * the runner on the never-trustable list, so a run that prints
 * `{"subtype":"success"}` and then exits 2 is a run that failed. What the
 * result line contributes is the cost and the final text, which the runner
 * folds into the single terminal event it emits itself.
 *
 * Two terminal events for one run would be worse than none: ingestion would
 * have to pick, and nothing tells it which is right.
 */

export interface MapperContext {
  runId: string;
  workOrderId: string;
  runnerKey: string;
  /** Receipt time, for the lines the CLI does not timestamp itself. */
  receivedAt: Date;
}

/** Cost and outcome scraped off the CLI's `result` line. */
export interface StreamResult {
  isError: boolean;
  subtype: string;
  costUsd?: number;
  tokensInput?: number;
  tokensOutput?: number;
  durationMs?: number;
  numTurns?: number;
  /** The agent's own final message, trimmed to something loggable. */
  text?: string;
  /** Tools the agent asked for and was refused. */
  permissionDenials: number;
}

export type StreamMapping =
  | { kind: 'event'; event: RunEventPayload }
  | { kind: 'result'; result: StreamResult }
  | { kind: 'drop'; reason: string };

const drop = (reason: string): StreamMapping => ({ kind: 'drop', reason });

/** How much agent prose reaches a summary. The schema caps it; so do we. */
export const SUMMARY_MAX_LENGTH = 400;

/**
 * One parsed line of `stream-json`.
 *
 * Takes an already-parsed value rather than a string: the caller has to handle
 * a parse failure anyway (a partial write, a non-JSON diagnostic on stdout),
 * and handling it in two places is how one of them ends up killing the run.
 */
export function mapStreamLine(
  line: unknown,
  context: MapperContext,
): StreamMapping {
  if (!isRecord(line) || typeof line.type !== 'string') {
    return drop('not a stream-json object');
  }

  switch (line.type) {
    case 'assistant':
      return mapAssistant(line, context);
    case 'user':
      return mapUser(line, context);
    case 'rate_limit_event':
      return mapRateLimit(line, context);
    case 'result':
      return mapResult(line);
    case 'system':
      return mapSystem(line, context);
    default:
      // active_goal, autocompact_state, and whatever the next CLI version
      // adds. Dropping is the whole point: see the class comment.
      return drop(`unmapped line type "${line.type}"`);
  }
}

// ---------------------------------------------------------------------------

/**
 * An assistant turn: a tool call, some prose, or some thinking.
 *
 * The tool call is the valuable one — it is the entire basis of loop
 * detection (#55) and the reason `streamingFidelity` is graded at all.
 */
function mapAssistant(
  line: Record<string, unknown>,
  context: MapperContext,
): StreamMapping {
  const content = contentBlocks(line);

  const toolUse = content.find((block) => block.type === 'tool_use');
  if (toolUse && typeof toolUse.name === 'string') {
    return {
      kind: 'event',
      event: event(line, context, 'run.progress', {
        summary: `Tool: ${toolUse.name}`,
        tool: {
          name: toolUse.name,
          signature: toolSignature(toolUse.input),
        },
      }),
    };
  }

  const text = content.find((block) => block.type === 'text');
  if (text && typeof text.text === 'string' && text.text.trim().length > 0) {
    return {
      kind: 'event',
      event: event(line, context, 'run.progress', {
        summary: truncate(text.text),
      }),
    };
  }

  // Thinking is liveness, not progress: it says the run is alive and says
  // nothing about it having moved. #54's silence thresholds want to see it;
  // a progress feed that filled up with it would drown the tool calls.
  //
  // The content is deliberately NOT copied into the summary. It is the
  // model's reasoning, it can be long, and it is the last place anyone
  // should be reading a run's state from.
  if (content.some((block) => block.type === 'thinking')) {
    return {
      kind: 'event',
      event: event(line, context, 'run.heartbeat', { summary: 'Thinking' }),
    };
  }

  return drop('assistant line with no mappable content block');
}

/**
 * A tool result coming back.
 *
 * Heartbeat rather than progress, including when the tool ERRORED. A failed
 * tool call is not a failed run — agents recover from those constantly — and
 * emitting `run.failed` here would make the control plane abandon runs that
 * were about to succeed.
 */
function mapUser(
  line: Record<string, unknown>,
  context: MapperContext,
): StreamMapping {
  const result = contentBlocks(line).find(
    (block) => block.type === 'tool_result',
  );
  if (!result) return drop('user line with no tool result');

  return {
    kind: 'event',
    event: event(line, context, 'run.heartbeat', {
      summary: result.is_error === true ? 'Tool result (error)' : 'Tool result',
    }),
  };
}

/**
 * The structured rate-limit signal — what earns `rateLimitSignal: 'structured'`.
 *
 * `resetsAt` is unix SECONDS, and it is the entire difference between #56
 * parking a run with a dated resume and #57 escalating it to a human. A
 * heuristic runner has to guess; this one is told.
 *
 * A `status: 'allowed'` line is a status report on a run that is not blocked.
 * Emitting `run.blocked` for it would park a healthy run, which is a worse
 * failure than missing a real block — the watchdog would eventually notice a
 * real block through silence, but it has nothing that notices a wrongly
 * parked run.
 */
function mapRateLimit(
  line: Record<string, unknown>,
  context: MapperContext,
): StreamMapping {
  const info = isRecord(line.rate_limit_info) ? line.rate_limit_info : null;
  if (!info) return drop('rate_limit_event with no rate_limit_info');

  const status = typeof info.status === 'string' ? info.status : 'unknown';
  if (status === 'allowed') return drop('rate limit status is allowed');

  // `quota-exhausted` and `rate-limit` are different in #56: one clears at a
  // known time, the other needs a human to buy more. The CLI tells us which.
  const exhausted =
    info.overageStatus === 'rejected' && info.isUsingOverage === true;

  return {
    kind: 'event',
    event: event(line, context, 'run.blocked', {
      summary: `Rate limited (${status})`,
      blocked: {
        reason: exhausted ? 'quota-exhausted' : 'rate-limit',
        ...resetAt(info.resetsAt),
        detail:
          typeof info.rateLimitType === 'string'
            ? info.rateLimitType
            : undefined,
      },
    }),
  };
}

/**
 * Unix seconds → an ISO instant, or nothing.
 *
 * Absent rather than guessed when the value is unusable: the schema says
 * `resetAt` absent means "the runner cannot say", and #56 escalates rather
 * than parking forever on that. An invented reset time would park a run until
 * a moment that means nothing.
 */
function resetAt(value: unknown): { resetAt?: string } {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    return {};
  return { resetAt: new Date(value * 1000).toISOString() };
}

/** System lines: mostly noise, one of them worth keeping. */
function mapSystem(
  line: Record<string, unknown>,
  context: MapperContext,
): StreamMapping {
  switch (line.subtype) {
    case 'init':
      // Not `run.started`. The runner already emitted one when it spawned the
      // process, and a second would be two answers to "when did this begin" —
      // which is the number detection latency (#59) is measured from.
      return {
        kind: 'event',
        event: event(line, context, 'run.progress', {
          summary: `Agent ready${typeof line.model === 'string' ? ` on ${line.model}` : ''}`,
        }),
      };

    case 'permission_denied': {
      // Progress, NOT `run.blocked`/`awaiting-approval`. Nobody is being
      // awaited: under a non-interactive permission mode the request is
      // refused outright and the agent carries on. Parking here would stall a
      // run that is still working, and #56 would then wait for an approval
      // that no one has been asked for.
      //
      // Kept rather than dropped because a run that is quietly being refused
      // its tools is the shape of a run about to go silent, and this is the
      // only warning of it an operator gets.
      const tool =
        typeof line.tool_name === 'string' ? line.tool_name : 'a tool';
      const why =
        typeof line.decision_reason === 'string'
          ? `: ${line.decision_reason}`
          : '';
      return {
        kind: 'event',
        event: event(line, context, 'run.progress', {
          summary: truncate(`Permission denied for ${tool}${why}`),
        }),
      };
    }

    default:
      // commands_changed, thinking_tokens, task_summary, post_turn_summary.
      // Internal bookkeeping with no normalized equivalent.
      return drop(`unmapped system subtype "${String(line.subtype)}"`);
  }
}

/** The final line: cost and outcome, folded into the runner's own ending. */
function mapResult(line: Record<string, unknown>): StreamMapping {
  const usage = isRecord(line.usage) ? line.usage : {};

  return {
    kind: 'result',
    result: {
      isError: line.is_error === true,
      subtype: typeof line.subtype === 'string' ? line.subtype : 'unknown',
      costUsd: numberOrUndefined(line.total_cost_usd),
      tokensInput: numberOrUndefined(usage.input_tokens),
      tokensOutput: numberOrUndefined(usage.output_tokens),
      durationMs: numberOrUndefined(line.duration_ms),
      numTurns: numberOrUndefined(line.num_turns),
      text: typeof line.result === 'string' ? truncate(line.result) : undefined,
      permissionDenials: Array.isArray(line.permission_denials)
        ? line.permission_denials.length
        : 0,
    },
  };
}

// ---------------------------------------------------------------------------

/**
 * A stable digest of a tool call's arguments.
 *
 * A digest and not the arguments themselves, for the two reasons the schema
 * gives: arguments can be enormous, and they can contain secrets — a `Bash`
 * command line is the obvious case. Loop detection (#55) only ever compares
 * these for equality, so it loses nothing.
 *
 * Keys are sorted recursively before hashing. Without that, two identical
 * calls whose arguments serialised in a different key order would hash
 * differently, and a loop would look like progress — which is precisely the
 * failure #55 exists to catch.
 */
export function toolSignature(input: unknown): string {
  return createHash('sha256')
    .update(canonicalJson(input))
    .digest('hex')
    .slice(0, 32);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object')
    return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);

  return `{${entries.join(',')}}`;
}

function event(
  line: Record<string, unknown>,
  context: MapperContext,
  type: RunEventTypeName,
  rest: Partial<RunEventPayload>,
): RunEventPayload {
  return {
    schemaVersion: RUN_EVENT_SCHEMA_VERSION,
    // The CLI stamps a uuid on EVERY line, so reusing it makes redelivery
    // idempotent for free — ingestion is keyed on `(runId, eventId)` (#53),
    // and a re-poll that returned the same line twice is recognised rather
    // than stored twice.
    eventId: typeof line.uuid === 'string' ? line.uuid : randomEventId(),
    runId: context.runId,
    workOrderId: context.workOrderId,
    type,
    // Everything here was reported by the runner. VISION §9: a synthesized
    // event must never masquerade as a report.
    source: 'runner-reported',
    // Only `assistant` and `user` lines carry a timestamp; for the rest,
    // receipt time is within milliseconds of the truth and is the honest
    // best available. The schema wants when it HAPPENED per its source, and
    // for an untimestamped line that is when it reached us.
    occurredAt: cliTimestamp(line) ?? context.receivedAt.toISOString(),
    runner: context.runnerKey,
    ...rest,
  };
}

function cliTimestamp(line: Record<string, unknown>): string | null {
  if (typeof line.timestamp !== 'string') return null;
  const parsed = new Date(line.timestamp);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function contentBlocks(
  line: Record<string, unknown>,
): Record<string, unknown>[] {
  const message = isRecord(line.message) ? line.message : null;
  if (!message || !Array.isArray(message.content)) return [];
  return message.content.filter(isRecord);
}

function truncate(text: string): string {
  const clean = text.trim().replace(/\s+/g, ' ');
  return clean.length <= SUMMARY_MAX_LENGTH
    ? clean
    : `${clean.slice(0, SUMMARY_MAX_LENGTH - 1)}…`;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function randomEventId(): string {
  // Only reached for a line the CLI did not stamp, which the captured
  // transcript says does not happen — but a format change must not produce an
  // event with no id, because ingestion keys on it.
  //
  // Random rather than derived from the line's content: two identical
  // heartbeats a second apart are two events, and content-addressing them
  // would silently collapse them into one.
  return randomUUID();
}
