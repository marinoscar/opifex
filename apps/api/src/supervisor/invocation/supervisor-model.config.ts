/**
 * What every supervisor model adapter shares (#392).
 *
 * `supervisor-model.port.ts` says the seam is vendor-neutral by construction —
 * "nothing outside `invocation/` may name a model provider" — and until #392
 * there was exactly one adapter, so everything an adapter needed lived inside
 * that adapter's file. Two adapters make three of those things common: the
 * settings they resolve, the error they throw, and the three names a model can
 * be recorded under. This file is those three things and nothing else.
 *
 * It is also where the provider VOCABULARY lives, and that placement is the
 * whole of the seam's claim. `supervisor.model.provider` is a registry key, so
 * `operator-settings.registry.ts` has to declare its legal values and its
 * default — and if it declared them as literals, the registry would be a
 * second place that names a vendor. It imports them from here instead, the
 * same way `runners.claudeCodeLocal.permissionMode` imports `PERMISSION_MODES`
 * from the file that writes them into argv. `test/governing/supervisor-provider-seam.spec.ts`
 * asserts the result over the source.
 */

import type { OperatorSettingsService } from '../../settings/operator-settings/operator-settings.service';

/**
 * The providers a supervisor model adapter exists for.
 *
 * The single declaration point. `operator-settings.registry.ts` imports this
 * as `supervisor.model.provider`'s legal values rather than restating them.
 */
export const SUPERVISOR_MODEL_PROVIDERS = ['anthropic', 'openai'] as const;

export type SupervisorModelProvider =
  (typeof SUPERVISOR_MODEL_PROVIDERS)[number];

/**
 * What an unset `SUPERVISOR_MODEL_PROVIDER` means.
 *
 * Anthropic, because ADR-0015 shipped the Anthropic adapter and every existing
 * deployment is configured for it. A default that changed which vendor an
 * unchanged deployment calls would be a silent outage at best and a call to
 * the wrong billed account at worst.
 */
export const DEFAULT_SUPERVISOR_MODEL_PROVIDER: SupervisorModelProvider =
  'anthropic';

/**
 * Each provider's own published API host.
 *
 * These are the values `supervisor.model.baseUrl` derives from when it is not
 * overridden — see `effectiveBaseUrl` for what "overridden" means, which is
 * the subtle part.
 */
export const PROVIDER_BASE_URLS: Readonly<
  Record<SupervisorModelProvider, string>
> = Object.freeze({
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
});

/** What the model is recorded as when `SUPERVISOR_MODEL_NAME` is not set. */
export const UNCONFIGURED_MODEL_NAME = 'unconfigured';

/**
 * What the model is recorded as when there is no API key at all.
 *
 * The same string `UnavailableSupervisorModel.name` reports, deliberately: an
 * unconfigured supervisor's decision-log row must read the same after #344 as
 * it did when the absence of a key meant no adapter was bound. `'none'` says
 * no model answered; `'unconfigured'` above says one was asked for and not
 * named. Keeping them distinct is what keeps a typo in a model name apart from
 * a deliberate decision not to run a supervisor — ADR-0015's argument, and it
 * has to hold identically on every provider or the log stops being comparable
 * across a provider switch.
 */
export const UNAVAILABLE_MODEL_NAME = 'none';

/** Everything an adapter needs, resolved from the settings for ONE call. */
export interface SupervisorModelConfig {
  /** `SUPERVISOR_MODEL_PROVIDER`. Which adapter answers this call. */
  provider: SupervisorModelProvider;
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
  /**
   * `SUPERVISOR_MODEL_BASE_URL`, resolved against the provider and with any
   * trailing slash removed. Never empty — see `effectiveBaseUrl`.
   */
  baseUrl: string;
  /** `SUPERVISOR_MODEL_TIMEOUT_MS`, handed to `AbortSignal.timeout`. */
  timeoutMs: number;
  /** `SUPERVISOR_MODEL_DEFAULT_MAX_TOKENS`, the ceiling on one answer. */
  defaultMaxTokens: number;
}

/**
 * Which host this call actually goes to.
 *
 * ## What "explicitly overridden" means, and why it is a property of the VALUE
 *
 * `supervisor.model.baseUrl` is an override point for proxies and tests, and
 * before #392 it defaulted to Anthropic's host — which made switching provider
 * a two-step operation where forgetting the second step produced an OpenAI key
 * being posted to Anthropic. #392 makes the URL follow the provider unless it
 * is overridden, and there were two ways to decide whether it had been:
 *
 * **By provenance** — `settings.resolve(...).source !== 'default'`. Rejected.
 * A form that saves every field writes the displayed value back, so opening
 * the settings screen and pressing Save would silently PIN the base URL
 * forever, and nothing about the value would show it. #394 is exactly that
 * screen. A rule whose answer depends on how a value arrived cannot survive a
 * UI round trip.
 *
 * **By value** — what this does. Empty means follow the provider, which is the
 * registry's default and therefore what an untouched deployment has. A host
 * that is some OTHER provider's published host also means follow the provider:
 * naming a vendor's own endpoint is not an override, it is the default written
 * out longhand, and it carries no information the derivation does not already
 * have. That second rule is what migrates the deployments that copied
 * `SUPERVISOR_MODEL_BASE_URL=https://api.anthropic.com` out of
 * `.env.example` — without it, every one of them would switch provider and
 * still reach Anthropic.
 *
 * Anything else — a proxy, a gateway, a test server — is a real override and
 * is used exactly as given, on whichever provider is selected.
 */
export function effectiveBaseUrl(
  provider: SupervisorModelProvider,
  configured: string,
): string {
  // The registry's format for this key is `url`, which permits a trailing
  // slash, and every adapter appends a rooted path.
  const trimmed = configured.trim().replace(/\/$/, '');
  if (trimmed === '') return PROVIDER_BASE_URLS[provider];

  const canonical = Object.values(PROVIDER_BASE_URLS).includes(trimmed);
  return canonical ? PROVIDER_BASE_URLS[provider] : trimmed;
}

/**
 * Read all six keys, now.
 *
 * One function so that `name` and `ask()` cannot resolve differently, and so
 * that the per-call read is a single readable thing rather than six scattered
 * `settings.get` calls. Per call rather than at construction is the whole of
 * #344: a value read per call cannot disagree with a boot-time copy of itself,
 * because there is no boot-time copy.
 */
export function resolveSupervisorModelConfig(
  settings: OperatorSettingsService,
): SupervisorModelConfig {
  const provider = settings.get('supervisor.model.provider');

  return {
    provider,
    apiKey: settings.get('supervisor.model.apiKey'),
    model: settings.get('supervisor.model.name'),
    baseUrl: effectiveBaseUrl(
      provider,
      settings.get('supervisor.model.baseUrl'),
    ),
    timeoutMs: settings.get('supervisor.model.timeoutMs'),
    defaultMaxTokens: settings.get('supervisor.model.defaultMaxTokens'),
  };
}

/**
 * The three answers to "which model answered", from one resolved config.
 *
 * Shared rather than reimplemented per adapter, because the decision log's
 * `model` column is compared ACROSS invocations — including across a provider
 * switch — and two adapters that disagreed about how to say "no key" would
 * make an unconfigured supervisor look like two different states.
 */
export function reportedModelName(config: SupervisorModelConfig): string {
  if (config.apiKey === '') return UNAVAILABLE_MODEL_NAME;
  return config.model === '' ? UNCONFIGURED_MODEL_NAME : config.model;
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

/** The refusal when no API key is configured. Identical on every provider. */
export function noApiKeyError(): SupervisorModelError {
  // The refusal that used to be a missing DI binding (#344). It is per call
  // now, so the key an operator sets in the Control Center takes effect on the
  // next invocation — and until they do, this names the setting to change
  // rather than telling whoever reads the log to bind a provider.
  return new SupervisorModelError(
    'The supervisor has no model API key, so there is no model to ask. ' +
      'Set SUPERVISOR_MODEL_API_KEY — the "Supervisor model API key" ' +
      'setting — to a separately metered credential for the configured ' +
      'provider, or turn the supervisor off. A key set now takes effect on ' +
      'the next invocation; no restart is needed.',
  );
}

/** The refusal when a key is set and no model is named. Every provider. */
export function noModelNamedError(): SupervisorModelError {
  // Refuses per call rather than throwing at construction: a missing model
  // name must not stop the API booting, and a supervisor that is misconfigured
  // should say so once an hour in the decision log, where it is visible,
  // rather than in a container that will not start.
  return new SupervisorModelError(
    'SUPERVISOR_MODEL_API_KEY is set but SUPERVISOR_MODEL_NAME is not, so ' +
      'there is no model to ask.',
  );
}

/**
 * A provider's `{ error: { message } }`, falling back to the status text.
 *
 * Both vendors use that envelope, which is why this is shared rather than
 * duplicated. An adapter for a vendor that does not would supply its own.
 */
export async function errorDetail(response: Response): Promise<string> {
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
export function isAbort(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const name = (error as { name?: unknown }).name;
  return name === 'TimeoutError' || name === 'AbortError';
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
