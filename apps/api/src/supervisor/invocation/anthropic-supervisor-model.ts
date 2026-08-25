import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { priceUsd } from './model-pricing';
import type {
  SupervisorModel,
  SupervisorModelRequest,
  SupervisorModelResponse,
} from './supervisor-model.port';

/**
 * The supervisor's model adapter: Anthropic's Messages API over the platform
 * `fetch` (ADR-0015, #230).
 *
 * ## No SDK, for a reason that is checkable
 *
 * ADR-0002 rejected Octokit for the GitHub client because its defaults fought
 * the behaviour the reconciler needed. That specific argument does not
 * transfer here — there is no tick to block — but the reasoning one level up
 * does, and it applies more strongly: **an SDK is worth the amount of its own
 * machinery a caller actually uses,** and this caller uses none of it. There
 * is no retry (the port's contract is "throws on failure; the caller records
 * the failure and moves on"), no streaming (`SupervisorModelRequest` has no
 * callback and no iterator), no pagination (one request, one answer), and no
 * rate-limit backoff to want, because a failed invocation simply waits for the
 * next scheduled tick — "try again in a moment" is something the SCHEDULER
 * already provides for free.
 *
 * What is left after subtracting all of that is an auth header and a JSON
 * shape, which is what this file is.
 *
 * ## What it deliberately cannot do
 *
 * Text in, text out. No `tools` field is sent and none would be honoured if
 * the API returned one — #90 requires that execution be structurally
 * impossible rather than merely unimplemented, and a model that could call a
 * tool would be an executor with extra steps. `ask()` builds one user message
 * and reads back text blocks. That is the entire surface.
 *
 * ## One call, no retry loop
 *
 * `ask()` issues exactly one `fetch`. Any non-2xx, network failure or timeout
 * throws, and `SupervisorService`'s per-proposer `try`/`catch` records the
 * failure and moves to the next proposer. A retry here would spend a second
 * call on a diagnosis that the next hourly tick will attempt anyway.
 */

/** The version header Anthropic requires on every Messages API request. */
const ANTHROPIC_VERSION = '2023-06-01';

/** What the model is recorded as when `SUPERVISOR_MODEL_NAME` is not set. */
const UNCONFIGURED_MODEL_NAME = 'unconfigured';

/** Everything the adapter needs, already resolved from `ConfigService`. */
export interface AnthropicSupervisorModelConfig {
  /** `SUPERVISOR_MODEL_API_KEY`. The adapter is not constructed without one. */
  apiKey: string;
  /**
   * `SUPERVISOR_MODEL_NAME`, sent verbatim and reported verbatim.
   *
   * Empty when unset, which `ask()` refuses rather than guesses at — see
   * `createSupervisorModel`.
   */
  model: string;
  /** `SUPERVISOR_MODEL_BASE_URL`. */
  baseUrl: string;
  /** `SUPERVISOR_MODEL_TIMEOUT_MS`, handed to `AbortSignal.timeout`. */
  timeoutMs: number;
  /** `SUPERVISOR_MODEL_DEFAULT_MAX_TOKENS`. Anthropic requires `max_tokens`. */
  defaultMaxTokens: number;
}

/**
 * A failed model call, with the HTTP status when there was one.
 *
 * A class rather than a bare `Error` so the decision log's failure reason can
 * say 401 rather than "request failed" — the difference between a credential
 * to fix and an outage to wait out.
 */
export class SupervisorModelError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'SupervisorModelError';
  }
}

export class AnthropicSupervisorModel implements SupervisorModel {
  private readonly logger = new Logger(AnthropicSupervisorModel.name);

  constructor(private readonly config: AnthropicSupervisorModelConfig) {}

  /**
   * The exact string sent as the request's `model` field.
   *
   * Reported from the same value that is sent, not from a second read of
   * configuration, because #89 asks this to make "runs on a small model" a
   * claim checkable against the LOG rather than against a config file's
   * assertion about what it would have sent.
   */
  get name(): string {
    return this.config.model === ''
      ? UNCONFIGURED_MODEL_NAME
      : this.config.model;
  }

  async ask(request: SupervisorModelRequest): Promise<SupervisorModelResponse> {
    if (this.config.model === '') {
      // Refuses per call rather than throwing at construction: a missing model
      // name must not stop the API booting, and a supervisor that is
      // misconfigured should say so once an hour in the decision log, where it
      // is visible, rather than in a container that will not start.
      throw new SupervisorModelError(
        'SUPERVISOR_MODEL_API_KEY is set but SUPERVISOR_MODEL_NAME is not, so ' +
          'there is no model to ask.',
      );
    }

    const body = {
      model: this.config.model,
      max_tokens: request.maxOutputTokens ?? this.config.defaultMaxTokens,
      messages: [
        {
          role: 'user',
          // The snapshot and the proposer's instruction, in one turn. There is
          // no system prompt and no conversation id: VISION §7 — "the
          // supervisor holds no state in its context" — and the snapshot is
          // the only state it receives.
          content: `${request.snapshot}\n\n${request.instruction}`,
        },
      ],
    };

    const response = await this.post(body);
    const payload = await readJson(response);
    const text = extractText(payload);
    const tokensInput = usageTokens(payload, 'input_tokens');
    const tokensOutput = usageTokens(payload, 'output_tokens');

    return {
      text,
      // Null, never a guess and never zero, when the table has no rate for
      // this model — see model-pricing.ts.
      costUsd: priceUsd(this.config.model, tokensInput, tokensOutput),
      tokensInput,
      tokensOutput,
    };
  }

  /** One request. Errors are mapped; nothing is retried. */
  private async post(body: unknown): Promise<Response> {
    const url = `${this.config.baseUrl}/v1/messages`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'x-api-key': this.config.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        // The same bound `GitHubHttpService` uses: the call either answers
        // inside its own timeout or the timeout ends it. That is why there is
        // no watchdog around this adapter — there is nothing here that can run
        // long enough to need one.
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new SupervisorModelError(
          `The supervisor model did not answer within ${this.config.timeoutMs}ms.`,
          null,
          error,
        );
      }
      throw new SupervisorModelError(
        `The supervisor model could not be reached: ${message(error)}`,
        null,
        error,
      );
    }

    if (!response.ok) {
      const detail = await errorDetail(response);
      this.logger.warn(
        `Anthropic rejected the supervisor's request with ${response.status}: ${detail}`,
      );
      throw new SupervisorModelError(
        `The supervisor model returned ${response.status}: ${detail}`,
        response.status,
      );
    }

    return response;
  }
}

/**
 * Build the adapter, or nothing at all.
 *
 * Returning `undefined` is the load-bearing half. ADR-0015: with no
 * `SUPERVISOR_MODEL_API_KEY`, this contributes no adapter, `@Optional()` in
 * `SupervisorService`'s constructor leaves `model` undefined, and the existing
 * `?? new UnavailableSupervisorModel()` fallback still wins — which still
 * refuses, out loud, in the decision log. Nothing about the unconfigured path
 * changes, and a missing key must never crash the API at boot.
 *
 * The key alone is the trigger, exactly as the ADR specifies. A key with no
 * `SUPERVISOR_MODEL_NAME` beside it is a half-configured deployment rather
 * than an unconfigured one, and it is reported as such per invocation — see
 * `ask()` — rather than silently reverting to the refusing default, which
 * would make a typo in the model name indistinguishable from a deliberate
 * decision not to run a supervisor.
 */
export function createSupervisorModel(
  config: ConfigService,
): SupervisorModel | undefined {
  const apiKey = config.get<string>('supervisor.model.apiKey');
  if (!apiKey) return undefined;

  const model = config.get<string>('supervisor.model.name') ?? '';
  if (model === '') {
    new Logger(AnthropicSupervisorModel.name).warn(
      'SUPERVISOR_MODEL_API_KEY is set but SUPERVISOR_MODEL_NAME is not - every ' +
        'supervisor invocation will record a failure until one is named.',
    );
  }

  return new AnthropicSupervisorModel({
    apiKey,
    model,
    baseUrl: (
      config.get<string>('supervisor.model.baseUrl') ??
      'https://api.anthropic.com'
    ).replace(/\/$/, ''),
    timeoutMs: config.get<number>('supervisor.model.timeoutMs') ?? 60000,
    defaultMaxTokens:
      config.get<number>('supervisor.model.defaultMaxTokens') ?? 1024,
  });
}

// ---------------------------------------------------------------------------
// Response reading
// ---------------------------------------------------------------------------

/** The parts of Anthropic's response this adapter reads. Nothing else. */
interface AnthropicMessage {
  content?: unknown;
  usage?: unknown;
}

async function readJson(response: Response): Promise<AnthropicMessage> {
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (error) {
    throw new SupervisorModelError(
      `The supervisor model returned a body that is not JSON: ${message(error)}`,
      response.status,
      error,
    );
  }

  if (parsed === null || typeof parsed !== 'object') {
    throw new SupervisorModelError(
      'The supervisor model returned a body that is not a message object.',
      response.status,
    );
  }

  return parsed as AnthropicMessage;
}

/**
 * The text blocks of `content`, concatenated.
 *
 * Non-text blocks are skipped rather than rendered: the seam is text in, text
 * out, and a proposer parsing JSON out of the answer (`parseModelJson`) has
 * nothing to do with a block type this adapter never asked for.
 */
function extractText(payload: AnthropicMessage): string {
  if (!Array.isArray(payload.content)) {
    throw new SupervisorModelError(
      'The supervisor model returned a message with no content array.',
    );
  }

  let text = '';
  for (const block of payload.content) {
    if (
      block !== null &&
      typeof block === 'object' &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
    ) {
      text += (block as { text: string }).text;
    }
  }
  return text;
}

/**
 * One token count, or null when the response did not report it.
 *
 * Null rather than 0 for the reason the whole cost column is nullable: a call
 * that reported no usage is unmeasured, not free.
 */
function usageTokens(
  payload: AnthropicMessage,
  field: 'input_tokens' | 'output_tokens',
): number | null {
  const usage = payload.usage;
  if (usage === null || typeof usage !== 'object') return null;

  const value = (usage as Record<string, unknown>)[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Anthropic's `{ error: { message } }`, falling back to the status text. */
async function errorDetail(response: Response): Promise<string> {
  const raw = await response.text().catch(() => '');
  if (raw === '') return response.statusText || 'no response body';

  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object') {
      const error = (parsed as { error?: unknown }).error;
      if (error !== null && typeof error === 'object') {
        const detail = (error as { message?: unknown }).message;
        if (typeof detail === 'string' && detail !== '') return detail;
      }
    }
  } catch {
    // Not JSON. The raw body is more useful than a parse complaint.
  }

  // Bounded: an HTML error page from a proxy would otherwise be copied whole
  // into the decision log's failure reason.
  return raw.slice(0, 500);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
