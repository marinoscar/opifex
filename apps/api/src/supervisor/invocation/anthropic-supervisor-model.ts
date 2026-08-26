import { Logger } from '@nestjs/common';

import { OperatorSettingsService } from '../../settings/operator-settings/operator-settings.service';
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
 *
 * ## Configured per call, not at construction (#344)
 *
 * The adapter holds `OperatorSettingsService`, not a resolved config object,
 * and reads all five keys on every `ask()` and every read of `name`. This is
 * the whole of #344: the key used to decide whether an adapter was BOUND at
 * all, so a key an operator set in the Control Center reached a process that
 * had already decided, at boot, that there was no model — the setting appeared
 * to work and changed nothing until a restart. A value read per call cannot
 * have that failure, because there is no boot-time copy of it to disagree
 * with.
 *
 * What that costs is that an absent key is no longer a wiring fact but a
 * per-invocation one: `ask()` refuses and says which variable is missing, and
 * `name` reports `'none'` — the same name `UnavailableSupervisorModel` reports
 * — so the decision-log row for an unconfigured supervisor reads exactly as it
 * did when no adapter was bound at all.
 */

/** The version header Anthropic requires on every Messages API request. */
const ANTHROPIC_VERSION = '2023-06-01';

/** What the model is recorded as when `SUPERVISOR_MODEL_NAME` is not set. */
const UNCONFIGURED_MODEL_NAME = 'unconfigured';

/**
 * What the model is recorded as when there is no API key at all.
 *
 * The same string `UnavailableSupervisorModel.name` reports, deliberately: an
 * unconfigured supervisor's decision-log row must read the same after #344 as
 * it did when the absence of a key meant no adapter was bound. `'none'` says
 * no model answered; `'unconfigured'` above says one was asked for and not
 * named. Keeping them distinct is what keeps a typo in a model name apart from
 * a deliberate decision not to run a supervisor — ADR-0015's argument, now
 * carried entirely by this file.
 */
const UNAVAILABLE_MODEL_NAME = 'none';

/** Everything the adapter needs, resolved from the settings for ONE call. */
export interface AnthropicSupervisorModelConfig {
  /**
   * `SUPERVISOR_MODEL_API_KEY`.
   *
   * Empty when unset. Since #344 the adapter is built anyway and `ask()`
   * refuses per call, so that a key supplied later is picked up by the next
   * invocation rather than by the next restart.
   */
  apiKey: string;
  /**
   * `SUPERVISOR_MODEL_NAME`, sent verbatim and reported verbatim.
   *
   * Empty when unset, which `ask()` refuses rather than guesses at.
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
 * Read all five keys, now.
 *
 * One function so that `name` and `ask()` cannot resolve differently, and so
 * that the per-call read is a single readable thing rather than five scattered
 * `settings.get` calls. The trailing-slash trim lives here because the base
 * URL's registry format is `url`, which permits one.
 */
export function resolveSupervisorModelConfig(
  settings: OperatorSettingsService,
): AnthropicSupervisorModelConfig {
  return {
    apiKey: settings.get('supervisor.model.apiKey'),
    model: settings.get('supervisor.model.name'),
    baseUrl: settings.get('supervisor.model.baseUrl').replace(/\/$/, ''),
    timeoutMs: settings.get('supervisor.model.timeoutMs'),
    defaultMaxTokens: settings.get('supervisor.model.defaultMaxTokens'),
  };
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
    const config = resolveSupervisorModelConfig(this.settings);
    if (config.apiKey === '') return UNAVAILABLE_MODEL_NAME;
    return config.model === '' ? UNCONFIGURED_MODEL_NAME : config.model;
  }

  async ask(request: SupervisorModelRequest): Promise<SupervisorModelResponse> {
    // Once per call, and everything below reads THIS object rather than the
    // settings again: a tick whose base URL changed halfway through building
    // its own request would be a worse thing to debug than a stale value.
    const config = resolveSupervisorModelConfig(this.settings);

    if (config.apiKey === '') {
      // The refusal that used to be a missing DI binding (#344). It is per
      // call now, so the key an operator sets in the Control Center takes
      // effect on the next invocation — and until they do, this names the
      // setting to change rather than telling whoever reads the log to bind a
      // provider.
      throw new SupervisorModelError(
        'The supervisor has no model API key, so there is no model to ask. ' +
          'Set SUPERVISOR_MODEL_API_KEY — the "Supervisor model API key" ' +
          'setting — to a separately metered Anthropic credential, or turn the ' +
          'supervisor off. A key set now takes effect on the next invocation; ' +
          'no restart is needed.',
      );
    }

    if (config.model === '') {
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
    config: AnthropicSupervisorModelConfig,
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
 * Build the adapter. Always.
 *
 * ## Why this returns an adapter unconditionally (#344)
 *
 * It used to return `undefined` when `SUPERVISOR_MODEL_API_KEY` was absent,
 * which left `SUPERVISOR_MODEL` unbound for the life of the process and
 * `SupervisorService` permanently on `UnavailableSupervisorModel`. That was
 * correct while the key could only arrive from a `.env` file read at boot: in
 * that world "no key" is a fact fixed for the process's whole life, and not
 * binding is strictly tidier than binding something that refuses.
 *
 * Epic #332 makes the key an operator-settable value, and inverts the
 * argument exactly as ADR-0018 §5 inverts it for the reconciler's interval.
 * A factory runs once. Its verdict becomes a SECOND, STALE COPY of the key's
 * presence, and the two can disagree for as long as the process stays up — an
 * operator sets the key in the Control Center, `supervisor.enabled` is already
 * live (`supervisor.service.ts`), and they enable a supervisor that provably
 * cannot call anything while the UI says it is on. That is the failure class
 * this epic exists to eliminate, and it is invisible: every invocation records
 * a refusal that reads exactly like a deployment that never configured one.
 *
 * So the binding no longer depends on configuration at all, and the
 * configuration is resolved per call inside the adapter.
 *
 * ## The unconfigured path is unchanged, and must stay that way
 *
 * ADR-0015 requires it, and #344 keeps it. With no key: `ask()` refuses, the
 * proposer's failure is caught by `SupervisorService` as any other proposer
 * failure is, the invocation still writes its decision-log row, and
 * `SupervisorModel.name` still reads `'none'`. Nothing is swallowed and
 * nothing crashes at boot — what changed is that the refusal now names the
 * setting to change, and that supplying it takes effect on the next
 * invocation instead of on the next restart.
 *
 * ADR-0015 also asked for a warning at STARTUP when a key names no model.
 * That warning is gone rather than moved: it read the key once, at boot, to
 * describe a state that is now allowed to change underneath it, so it could
 * only be right by accident. Its content survives where it is actually
 * checkable — `ask()` refuses per invocation with the missing variable named,
 * which is what ADR-0015 wanted the warning for.
 *
 * `SupervisorService` keeps its `@Optional()` parameter and its
 * `?? new UnavailableSupervisorModel()` fallback. Through this module the
 * fallback is now unreachable, and it is not deleted: the service is
 * constructed directly, without the module, by
 * `test/governing/supervisor-offline.spec.ts` among others, and a required
 * binding would make "the factory runs with the supervisor offline" harder to
 * state rather than easier.
 *
 * It binds one adapter, and nothing outside `invocation/` names a model
 * provider — the seam stays vendor-neutral even though there is exactly one
 * vendor behind it. A second vendor is chosen HERE, which is what keeps this a
 * factory rather than a `useClass`.
 */
export function createSupervisorModel(
  settings: OperatorSettingsService,
): SupervisorModel {
  return new AnthropicSupervisorModel(settings);
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

/**
 * Whether a rejected `fetch` was our own timeout firing.
 *
 * Checked by `name` rather than with `instanceof Error`, because what
 * `AbortSignal.timeout` rejects with is a `DOMException`, and a `DOMException`
 * is NOT an `instanceof Error` in Node. Getting that wrong reports a timeout
 * as an unreachable endpoint, which sends whoever reads the decision log
 * looking at the network instead of at the timeout they set.
 */
function isAbort(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const name = (error as { name?: unknown }).name;
  return name === 'TimeoutError' || name === 'AbortError';
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
