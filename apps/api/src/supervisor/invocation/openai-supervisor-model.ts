import { Logger } from '@nestjs/common';

import type { OperatorSettingsService } from '../../settings/operator-settings/operator-settings.service';
import { priceUsd } from './model-pricing';
import {
  SupervisorModelError,
  errorDetail,
  errorMessage,
  isAbort,
  noApiKeyError,
  noModelNamedError,
  reportedModelName,
  resolveSupervisorModelConfig,
  type SupervisorModelConfig,
} from './supervisor-model.config';
import type {
  SupervisorModel,
  SupervisorModelRequest,
  SupervisorModelResponse,
} from './supervisor-model.port';

/**
 * The supervisor's OpenAI adapter: Chat Completions over the platform `fetch`
 * (#392, epic #391).
 *
 * ## This exercises the seam; it does not change it
 *
 * `supervisor-model.port.ts` has been vendor-neutral by construction since
 * #89, and ADR-0015 supplied exactly one adapter behind it. Nothing in the
 * port changed to admit this file, which is the point: `SupervisorModel` is
 * still `name` plus `ask()`, and every proposer, `SupervisorService` and the
 * decision log are unchanged and unaware. A second vendor that HAD required a
 * port change would have meant the first seam was shaped around one API.
 *
 * ## Chat Completions rather than Responses
 *
 * Both would serve. Chat Completions wins on the one property that is specific
 * to this setting: `supervisor.model.baseUrl` is documented as an override
 * point for proxies and gateways, and `/v1/chat/completions` is the surface
 * an "OpenAI-compatible" endpoint actually implements. Choosing the newer API
 * would make the override point work only against OpenAI itself.
 *
 * It is also the closer mirror of the Anthropic adapter — one user message in,
 * message text out — so the two files differ in the auth header, the path, and
 * the field names, and in nothing else. That is what keeps them reviewable
 * side by side.
 *
 * `max_completion_tokens`, not `max_tokens`: the latter is absent from the
 * current request schema and is rejected outright by the reasoning models this
 * adapter will mostly be pointed at, which would turn the supervisor's token
 * ceiling into a 400 once an hour.
 *
 * ## What it deliberately cannot do
 *
 * The same nothing the Anthropic adapter can do. No `tools`, no
 * `tool_choice`, no function calling — #90 requires execution be structurally
 * impossible rather than merely unimplemented, and a supervisor that could
 * call a tool would be an executor with extra steps. Text in, text out.
 *
 * ## One call, no retry loop
 *
 * Exactly one `fetch`. Any non-2xx, network failure or timeout throws, and
 * `SupervisorService`'s per-proposer `try`/`catch` records it. The next
 * scheduled tick is the retry.
 */

/** What the model is asked to answer as. One turn, no system prompt. */
const USER_ROLE = 'user';

export class OpenAiSupervisorModel implements SupervisorModel {
  private readonly logger = new Logger(OpenAiSupervisorModel.name);

  constructor(private readonly settings: OperatorSettingsService) {}

  /**
   * The exact string sent as the request's `model` field.
   *
   * Verbatim, from the same read `ask()` sends — #89 exists so that "runs on a
   * small model" is checkable against the LOG rather than against a config
   * file's claim about what it would have sent, and that has to be as true of
   * this provider as of the other one. The three answers are the shared ones:
   * the model name, `'unconfigured'` for a key that names no model, `'none'`
   * for no key at all.
   */
  get name(): string {
    return reportedModelName(resolveSupervisorModelConfig(this.settings));
  }

  async ask(request: SupervisorModelRequest): Promise<SupervisorModelResponse> {
    // Once per call, and everything below reads THIS object rather than the
    // settings again: a tick whose base URL changed halfway through building
    // its own request would be a worse thing to debug than a stale value.
    const config = resolveSupervisorModelConfig(this.settings);

    if (config.apiKey === '') throw noApiKeyError();
    if (config.model === '') throw noModelNamedError();

    const body = {
      model: config.model,
      max_completion_tokens: request.maxOutputTokens ?? config.defaultMaxTokens,
      messages: [
        {
          role: USER_ROLE,
          // The snapshot and the proposer's instruction, in one turn. No
          // system message and no conversation id: VISION §7 — "the supervisor
          // holds no state in its context."
          content: `${request.snapshot}\n\n${request.instruction}`,
        },
      ],
    };

    const response = await this.post(body, config);
    const payload = await readJson(response);
    const text = extractText(payload);
    const tokensInput = usageTokens(payload, 'prompt_tokens');
    const tokensOutput = usageTokens(payload, 'completion_tokens');

    return {
      text,
      // Null, never a guess and never zero, when the table has no rate for
      // this model — see model-pricing.ts.
      costUsd: priceUsd(config.model, tokensInput, tokensOutput),
      tokensInput,
      tokensOutput,
    };
  }

  /** One request. Errors are mapped; nothing is retried. */
  private async post(
    body: unknown,
    config: SupervisorModelConfig,
  ): Promise<Response> {
    const url = `${config.baseUrl}/v1/chat/completions`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          // Bearer, where Anthropic wants `x-api-key`. The difference is the
          // adapter's whole reason to exist.
          authorization: `Bearer ${config.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (error) {
      if (isAbort(error)) {
        throw new SupervisorModelError(
          `The supervisor model did not answer within ${config.timeoutMs}ms.`,
          null,
          error,
        );
      }
      throw new SupervisorModelError(
        `The supervisor model could not be reached: ${errorMessage(error)}`,
        null,
        error,
      );
    }

    if (!response.ok) {
      const detail = await errorDetail(response);
      this.logger.warn(
        `OpenAI rejected the supervisor's request with ${response.status}: ${detail}`,
      );
      throw new SupervisorModelError(
        `The supervisor model returned ${response.status}: ${detail}`,
        response.status,
      );
    }

    return response;
  }
}

// ---------------------------------------------------------------------------
// Response reading
// ---------------------------------------------------------------------------

/** The parts of a chat completion this adapter reads. Nothing else. */
interface ChatCompletion {
  choices?: unknown;
  usage?: unknown;
}

async function readJson(response: Response): Promise<ChatCompletion> {
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (error) {
    throw new SupervisorModelError(
      `The supervisor model returned a body that is not JSON: ${errorMessage(error)}`,
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

  return parsed as ChatCompletion;
}

/**
 * The first choice's message text.
 *
 * `n` is never sent, so there is exactly one choice and reading past it would
 * be reading something this adapter did not ask for — the same reason the
 * Anthropic side skips block types it never requested.
 *
 * A REFUSAL throws rather than answering empty. `content` is null and
 * `refusal` carries the reason when a model declines, and returning `''` there
 * would be recorded as a supervisor that ran and had nothing to say — a lie
 * the approval rate would then average over, and the exact thing
 * `UnavailableSupervisorModel`'s doc says must never happen.
 */
function extractText(payload: ChatCompletion): string {
  if (!Array.isArray(payload.choices) || payload.choices.length === 0) {
    throw new SupervisorModelError(
      'The supervisor model returned a completion with no choices.',
    );
  }

  const first: unknown = payload.choices[0];
  const message =
    first !== null && typeof first === 'object'
      ? (first as { message?: unknown }).message
      : undefined;

  if (message === null || typeof message !== 'object') {
    throw new SupervisorModelError(
      'The supervisor model returned a choice with no message.',
    );
  }

  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;

  const refusal = (message as { refusal?: unknown }).refusal;
  if (typeof refusal === 'string' && refusal !== '') {
    throw new SupervisorModelError(
      `The supervisor model refused to answer: ${refusal}`,
    );
  }

  throw new SupervisorModelError(
    'The supervisor model returned a message with no text content.',
  );
}

/**
 * One token count, or null when the response did not report it.
 *
 * Null rather than 0 for the reason the whole cost column is nullable: a call
 * that reported no usage is unmeasured, not free. Note that OpenAI's
 * `completion_tokens` INCLUDES reasoning tokens, which is what is billed, so
 * it is the right number to price against and not an over-count.
 */
function usageTokens(
  payload: ChatCompletion,
  field: 'prompt_tokens' | 'completion_tokens',
): number | null {
  const usage = payload.usage;
  if (usage === null || typeof usage !== 'object') return null;

  const value = (usage as Record<string, unknown>)[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
