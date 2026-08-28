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
 * The supervisor's Anthropic adapter: the Messages API over the platform
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
 * shape, which is what this file is. #392 added a second vendor and did not
 * change that calculation: the second adapter is another auth header and
 * another JSON shape, and the parts that turned out to be common — the config,
 * the error, the three model names — moved to `supervisor-model.config.ts`
 * rather than into a dependency.
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
 *
 * ## Configured per call, not at construction (#344)
 *
 * The adapter holds `OperatorSettingsService`, not a resolved config object,
 * and reads every key on every `ask()` and every read of `name`. This is the
 * whole of #344: the key used to decide whether an adapter was BOUND at all,
 * so a key an operator set in the Control Center reached a process that had
 * already decided, at boot, that there was no model — the setting appeared to
 * work and changed nothing until a restart. A value read per call cannot have
 * that failure, because there is no boot-time copy of it to disagree with.
 *
 * What that costs is that an absent key is no longer a wiring fact but a
 * per-invocation one: `ask()` refuses and says which variable is missing, and
 * `name` reports `'none'` — the same name `UnavailableSupervisorModel` reports
 * — so the decision-log row for an unconfigured supervisor reads exactly as it
 * did when no adapter was bound at all. Since #392 both adapters share that
 * behaviour through `reportedModelName`, so it also reads the same on either
 * provider.
 */

/**
 * The version header Anthropic requires on every request.
 *
 * Exported since #393 so that the model catalogue sends the same one: two
 * copies of a required header is two things to update when it moves, and the
 * one that gets missed fails as a rejected request rather than as a compile
 * error.
 */
export const ANTHROPIC_VERSION = '2023-06-01';

export class AnthropicSupervisorModel implements SupervisorModel {
  private readonly logger = new Logger(AnthropicSupervisorModel.name);

  constructor(private readonly settings: OperatorSettingsService) {}

  /**
   * The exact string sent as the request's `model` field.
   *
   * Reported from the same read that `ask()` sends, because #89 asks this to
   * make "runs on a small model" a claim checkable against the LOG rather than
   * against a config file's assertion about what it would have sent.
   *
   * Three answers, and the difference between them is the point: the literal
   * model name when there is one, `'unconfigured'` when a key names no model,
   * and `'none'` when there is no key — which is what an unconfigured
   * deployment recorded before #344 bound this adapter unconditionally.
   */
  get name(): string {
    return reportedModelName(resolveSupervisorModelConfig(this.settings));
  }

  async ask(request: SupervisorModelRequest): Promise<SupervisorModelResponse> {
    // Once per call, and everything below reads THIS object rather than the
    // settings again: a tick whose base URL changed halfway through building
    // its own request would be a worse thing to debug than a stale value.
    const config = resolveSupervisorModelConfig(this.settings);

    if (config.apiKey === '') throw noApiKeyError(config.provider);
    if (config.model === '') throw noModelNamedError(config.provider);

    const body = {
      model: config.model,
      max_tokens: request.maxOutputTokens ?? config.defaultMaxTokens,
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

    const response = await this.post(body, config);
    const payload = await readJson(response);
    const text = extractText(payload);
    const tokensInput = usageTokens(payload, 'input_tokens');
    const tokensOutput = usageTokens(payload, 'output_tokens');

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
    const url = `${config.baseUrl}/v1/messages`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'x-api-key': config.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        // The same bound `GitHubHttpService` uses: the call either answers
        // inside its own timeout or the timeout ends it. That is why there is
        // no watchdog around this adapter — there is nothing here that can run
        // long enough to need one.
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
