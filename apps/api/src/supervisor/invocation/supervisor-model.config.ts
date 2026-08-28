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
 * These are the values `models.<provider>.baseUrl` derives from when it is not
 * overridden — see `effectiveBaseUrl` for what "overridden" means, which is
 * the subtle part.
 */
export const PROVIDER_BASE_URLS: Readonly<
  Record<SupervisorModelProvider, string>
> = Object.freeze({
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
});

/**
 * How each provider's name is written for a human (#422).
 *
 * Here rather than in the settings registry for the reason this file's header
 * gives: the registry GENERATES one credential slot per provider, and a label
 * table over there would be a second place that spells a vendor. Derivation
 * from the id was considered and rejected — `Uppercase`/title-case turns
 * `openai` into `Openai`, and a credential form that misspells the vendor it
 * belongs to is worse than a table.
 */
export const PROVIDER_LABELS: Readonly<
  Record<SupervisorModelProvider, string>
> = Object.freeze({
  anthropic: 'Anthropic',
  openai: 'OpenAI',
});

// ---------------------------------------------------------------------------
// The consumers (#423, epic #419)
//
// A CREDENTIAL belongs to a provider; a CONSUMER selects one. #422 built the
// first half of that sentence. This is the second: there is now more than one
// thing in the process that asks a model a question, and the two want
// different models for reasons that are not going to converge — the supervisor
// makes an occasional judgement and wants the stronger model, while the chat
// parses an instruction somebody is waiting on and wants the fast one.
//
// The consumer is therefore a PARAMETER of the resolution rather than a second
// copy of it. `supervisor.model.*` and `chat.model.*` are the same four keys
// with a different prefix, and `resolveModelConfig` is the only place either
// set is read. Two hand-written resolvers would be two places to change when a
// fifth field is added, and the one that gets missed is the one that keeps
// working with a stale value.
//
// The key names are TEMPLATED off this list, which is what makes the settings
// registry and this file impossible to drift apart: `settings.get` is typed by
// `OperatorSettingKey`, so a consumer added here with no registry rows fails
// to COMPILE rather than resolving to a default at runtime.
// ---------------------------------------------------------------------------

/** The things in this process that ask a model a question. */
export const MODEL_CONSUMERS = ['supervisor', 'chat'] as const;

export type ModelConsumer = (typeof MODEL_CONSUMERS)[number];

/**
 * How a refusal is worded for one consumer.
 *
 * Three fields rather than a per-consumer message, because the SENTENCES are
 * the same sentence: the same missing key, the same remedy, the same promise
 * that no restart is needed. Only the thing being talked about and the unit it
 * runs in differ, and a consumer added with a whole message of its own would
 * drift from the others in wording nobody diffs.
 */
interface ModelConsumerVoice {
  /** How an operator refers to it: "the supervisor", "the chat". */
  readonly subject: string;
  /** The way to stop it asking anything, as an imperative clause. */
  readonly standDown: string;
  /** What one piece of its work is called — an invocation, a request. */
  readonly unit: string;
}

const CONSUMER_VOICE: Readonly<Record<ModelConsumer, ModelConsumerVoice>> =
  Object.freeze({
    supervisor: {
      subject: 'the supervisor',
      // `supervisor.enabled` is a real switch, so the supervisor has a real
      // off. The chat does not have one and deliberately does not need one —
      // see `chat.model.name` in the registry for why an empty model name IS
      // the off switch there.
      standDown: 'turn the supervisor off',
      unit: 'invocation',
    },
    chat: {
      subject: 'the chat',
      standDown: 'leave the chat unconfigured',
      unit: 'request',
    },
  });

/** The settings key naming one consumer's provider. */
export type ModelProviderSettingKey = `${ModelConsumer}.model.provider`;

/** The settings key naming one consumer's model. */
export type ModelNameSettingKey = `${ModelConsumer}.model.name`;

/** The settings key bounding how long one consumer's call may take. */
export type ModelTimeoutSettingKey = `${ModelConsumer}.model.timeoutMs`;

/** The settings key bounding one consumer's answer. */
export type ModelMaxTokensSettingKey =
  `${ModelConsumer}.model.defaultMaxTokens`;

export function modelProviderSettingKey(
  consumer: ModelConsumer,
): ModelProviderSettingKey {
  return `${consumer}.model.provider`;
}

export function modelNameSettingKey(
  consumer: ModelConsumer,
): ModelNameSettingKey {
  return `${consumer}.model.name`;
}

export function modelTimeoutSettingKey(
  consumer: ModelConsumer,
): ModelTimeoutSettingKey {
  return `${consumer}.model.timeoutMs`;
}

export function modelMaxTokensSettingKey(
  consumer: ModelConsumer,
): ModelMaxTokensSettingKey {
  return `${consumer}.model.defaultMaxTokens`;
}

/**
 * The environment variable behind one consumer's provider, and its siblings.
 *
 * `SUPERVISOR_MODEL_PROVIDER` and `SUPERVISOR_MODEL_NAME` are what they have
 * always been — the derivation reproduces the names ADR-0015 shipped rather
 * than replacing them, which is the whole reason the consumer id is the
 * lower-cased env prefix and not some prettier word. `operator-settings
 * .registry.spec.ts` asserts these against the registry's own `envVar`
 * strings, so the two cannot drift even though the registry writes them out
 * literally (it has to: `apps/web`'s drift suite reads the key names out of
 * the registry source as text).
 */
export function modelProviderEnvVar(consumer: ModelConsumer): string {
  return `${consumer.toUpperCase()}_MODEL_PROVIDER`;
}

export function modelNameEnvVar(consumer: ModelConsumer): string {
  return `${consumer.toUpperCase()}_MODEL_NAME`;
}

export function modelTimeoutEnvVar(consumer: ModelConsumer): string {
  return `${consumer.toUpperCase()}_MODEL_TIMEOUT_MS`;
}

export function modelMaxTokensEnvVar(consumer: ModelConsumer): string {
  return `${consumer.toUpperCase()}_MODEL_DEFAULT_MAX_TOKENS`;
}

// ---------------------------------------------------------------------------
// The credential slots (#422, epic #419)
//
// A CREDENTIAL belongs to a PROVIDER; a CONSUMER selects a provider. Before
// #422 there was one `supervisor.model.apiKey` paired with one
// `supervisor.model.provider`, so an operator holding an Anthropic key and an
// OpenAI key could store only one of them and switching provider destroyed the
// other. These four functions are what make the slot a function of the vendor
// instead.
//
// They live here, and the registry calls them, so that adding a third adapter
// creates its credential slot in the Control Center without anyone editing the
// settings layer — and so that the settings layer still names no vendor, which
// `test/governing/supervisor-provider-seam.spec.ts` asserts over the source.
//
// The BASE URL is per provider for the same reason the key is, and it is worth
// being explicit about why it is a property of the credential rather than of
// the consumer: the key is SENT to whatever host is named, so "which host" and
// "which key" are one fact. A single shared override across two providers
// would post one vendor's credential to another vendor's proxy — the precise
// confusion this issue removes from the key, rebuilt one field over.
// ---------------------------------------------------------------------------

/** The settings key holding one provider's API key. */
export type ModelApiKeySettingKey = `models.${SupervisorModelProvider}.apiKey`;

/** The settings key holding one provider's base-URL override. */
export type ModelBaseUrlSettingKey =
  `models.${SupervisorModelProvider}.baseUrl`;

export function modelApiKeySettingKey(
  provider: SupervisorModelProvider,
): ModelApiKeySettingKey {
  return `models.${provider}.apiKey`;
}

export function modelBaseUrlSettingKey(
  provider: SupervisorModelProvider,
): ModelBaseUrlSettingKey {
  return `models.${provider}.baseUrl`;
}

/**
 * The environment variable for one provider's key.
 *
 * `MODEL_` and not `ANTHROPIC_API_KEY`, which is already taken and means
 * something else entirely: it is one of the two credentials the `claude-code-
 * local` CLI authenticates with (`child-environment.ts`), billed against the
 * runner's own quota. ADR-0015's whole point is that the supervisor's metered
 * key is NOT that one, and reusing the name would merge them back together.
 */
export function modelApiKeyEnvVar(provider: SupervisorModelProvider): string {
  return `MODEL_${provider.toUpperCase()}_API_KEY`;
}

export function modelBaseUrlEnvVar(provider: SupervisorModelProvider): string {
  return `MODEL_${provider.toUpperCase()}_BASE_URL`;
}

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
export interface ModelConfig {
  /**
   * Which consumer this call is for (#423).
   *
   * Carried on the config rather than passed alongside it, because everything
   * downstream that has to SAY something about the call — the refusal when
   * there is no key, the readiness report, the log line — needs to name the
   * consumer, and a parameter that travels beside a config is a parameter that
   * eventually stops matching it.
   */
  consumer: ModelConsumer;
  /** `<CONSUMER>_MODEL_PROVIDER`. Which adapter answers this call. */
  provider: SupervisorModelProvider;
  /**
   * The selected provider's own credential — `models.<provider>.apiKey`.
   *
   * Empty when unset. Since #344 the adapter is built anyway and `ask()`
   * refuses per call, so that a key supplied later is picked up by the next
   * invocation rather than by the next restart. Since #422 the slot is chosen
   * by `provider`, so switching provider selects the OTHER stored key instead
   * of finding the same one and posting it to a host that will reject it.
   */
  apiKey: string;
  /**
   * `<CONSUMER>_MODEL_NAME`, sent verbatim and reported verbatim.
   *
   * Empty when unset, which `ask()` refuses rather than guesses at. For the
   * chat, empty is also the deployed default and therefore the state a chat
   * that nobody has configured is IN — see `modelReadiness`.
   */
  model: string;
  /**
   * `models.<provider>.baseUrl`, resolved against the provider and with any
   * trailing slash removed. Never empty — see `effectiveBaseUrl`.
   */
  baseUrl: string;
  /**
   * `<CONSUMER>_MODEL_TIMEOUT_MS`, handed to `AbortSignal.timeout`.
   *
   * Per consumer and not shared, which is a decision rather than symmetry for
   * its own sake: the supervisor's 60s is generous because an hourly judgement
   * nobody is waiting on can afford to be, and the same number in front of an
   * operator watching a text box is a minute of nothing happening.
   */
  timeoutMs: number;
  /** `<CONSUMER>_MODEL_DEFAULT_MAX_TOKENS`, the ceiling on one answer. */
  defaultMaxTokens: number;
}

/**
 * Which host this call actually goes to.
 *
 * ## What "explicitly overridden" means, and why it is a property of the VALUE
 *
 * The base URL is an override point for proxies and tests, and
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
 * Read all six keys for ONE consumer, now.
 *
 * One function so that `name` and `ask()` cannot resolve differently, and so
 * that the per-call read is a single readable thing rather than six scattered
 * `settings.get` calls. Per call rather than at construction is the whole of
 * #344: a value read per call cannot disagree with a boot-time copy of itself,
 * because there is no boot-time copy.
 *
 * ## Why the consumer is an argument and not a second function (#423)
 *
 * Four of the six keys are a function of the consumer and two are a function
 * of the provider it selects, and NOTHING here is a function of both. That is
 * the shape the credential/consumer split has, so it is the shape this
 * function has: the supervisor and the chat can name different providers and
 * different models at the same moment, and each still reaches the one stored
 * credential for the vendor it named. A second copy of this body for the chat
 * would be a second place where that pairing is decided, which is the exact
 * failure epic #332 spent twenty-one issues removing.
 *
 * Every key is read through a TEMPLATED key name, so `settings.get`'s own
 * types are what guarantee the registry declares them. A consumer added to
 * `MODEL_CONSUMERS` without its four registry rows does not resolve to a
 * default — it fails to compile.
 */
export function resolveModelConfig(
  settings: OperatorSettingsService,
  consumer: ModelConsumer,
): ModelConfig {
  const provider = settings.get(modelProviderSettingKey(consumer));

  return {
    consumer,
    provider,
    // The credential is looked up BY provider (#422), which is the whole of
    // the credential/consumer split: the two keys sit side by side in the
    // settings table and this read picks the one that belongs to the vendor
    // being called. Since #423 two consumers can arrive here naming different
    // vendors on the same tick, and each gets the key for the one it named.
    apiKey: settings.get(modelApiKeySettingKey(provider)),
    model: settings.get(modelNameSettingKey(consumer)),
    baseUrl: effectiveBaseUrl(
      provider,
      settings.get(modelBaseUrlSettingKey(provider)),
    ),
    timeoutMs: settings.get(modelTimeoutSettingKey(consumer)),
    defaultMaxTokens: settings.get(modelMaxTokensSettingKey(consumer)),
  };
}

/**
 * The supervisor's own configuration. The name every existing caller uses.
 *
 * A one-line delegation rather than an alias, and deliberately not deleted in
 * favour of `resolveModelConfig(settings, 'supervisor')` at each of its five
 * call sites: the supervisor's adapters, its factory and its probe are not
 * generic over consumers and should not have to pass a constant that can only
 * ever be one value. It reads the same keys through the same function, so
 * there is still exactly one read path per key.
 */
export function resolveSupervisorModelConfig(
  settings: OperatorSettingsService,
): ModelConfig {
  return resolveModelConfig(settings, 'supervisor');
}

/**
 * The three answers to "which model answered", from one resolved config.
 *
 * Shared rather than reimplemented per adapter, because the decision log's
 * `model` column is compared ACROSS invocations — including across a provider
 * switch — and two adapters that disagreed about how to say "no key" would
 * make an unconfigured supervisor look like two different states.
 */
export function reportedModelName(config: ModelConfig): string {
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

/**
 * The refusal when the selected provider has no API key configured.
 *
 * Names the PROVIDER's slot rather than a single global one (#422). Before the
 * credential split there was one key and one message; now there are two slots
 * and the useful sentence is which of them is empty — an operator who switched
 * to a provider they have never given a key to would otherwise read the same
 * line as one who has configured nothing at all.
 */
export function noApiKeyError(config: ModelConfig): SupervisorModelError {
  // The refusal that used to be a missing DI binding (#344). It is per call
  // now, so the key an operator sets in the Control Center takes effect on the
  // next invocation — and until they do, this names the setting to change
  // rather than telling whoever reads the log to bind a provider.
  //
  // Takes the whole config rather than a provider (#423) because the remedy
  // now depends on the CONSUMER as well: "turn the supervisor off" is not
  // advice a chat can act on, and a message that gave it would send an
  // operator to a switch that has nothing to do with what they are reading.
  const { provider } = config;

  return new SupervisorModelError(
    `No API key is configured for ${PROVIDER_LABELS[provider]}, so there is ` +
      `no model to ask. Set ${modelApiKeySettingKey(provider)} — the ` +
      `"${PROVIDER_LABELS[provider]} API key" setting, ` +
      `${modelApiKeyEnvVar(provider)} in the environment — to a separately ` +
      `metered credential, select a provider you have given a key to, or ` +
      `${CONSUMER_VOICE[config.consumer].standDown}. A key set now takes ` +
      `effect on the next ${CONSUMER_VOICE[config.consumer].unit}; no ` +
      `restart is needed.`,
  );
}

/** The refusal when a key is set and no model is named. Every provider. */
export function noModelNamedError(config: ModelConfig): SupervisorModelError {
  // Refuses per call rather than throwing at construction: a missing model
  // name must not stop the API booting, and a supervisor that is misconfigured
  // should say so once an hour in the decision log, where it is visible,
  // rather than in a container that will not start.
  //
  // The variable is DERIVED from the consumer, so the supervisor's message is
  // the same sentence naming the same `SUPERVISOR_MODEL_NAME` it has always
  // named, and the chat's names `CHAT_MODEL_NAME` without a second message
  // existing to say it.
  return new SupervisorModelError(
    `${modelApiKeySettingKey(config.provider)} is set but ` +
      `${modelNameEnvVar(config.consumer)} is not, so there is no model to ` +
      `ask.`,
  );
}

// ---------------------------------------------------------------------------
// Inert, and saying so (#423, #324)
// ---------------------------------------------------------------------------

/**
 * Whether this consumer can ask anything at all, and why not when it cannot.
 *
 * ONE predicate, used by both the adapters that refuse and any caller that
 * wants to know BEFORE it tries. That is the point of it being a function
 * returning the error rather than two booleans: a caller checking readiness
 * and an adapter refusing a call cannot come to different conclusions,
 * because they are the same conclusion, and the sentence an operator reads is
 * the same sentence either way.
 *
 * The order matters and is the order it has always had: no key is reported
 * before no model, because a deployment with neither is a deployment that has
 * configured nothing, and telling it to name a model first would send it to
 * the second step of a two-step remedy.
 */
export function unavailableReason(
  config: ModelConfig,
): SupervisorModelError | null {
  if (config.apiKey === '') return noApiKeyError(config);
  if (config.model === '') return noModelNamedError(config);
  return null;
}

/**
 * What one consumer would do if asked right now.
 *
 * `available` plus `unavailableReason` rather than a bare boolean, which is
 * the shape `FleetRunnerState` already uses for the same distinction and for
 * the same reason: a thing that is off because nobody configured it is a
 * REPORT, not an incident, and the report is worthless without the sentence
 * that says what to set.
 *
 * The distinction #324 draws is between "enabled" — somebody decided this
 * should run — and "available" — it actually can. This answers only the
 * second. The supervisor keeps its own `supervisor.enabled` for the first; the
 * chat has no separate switch, because an unnamed model already means it does
 * nothing, and a second flag would let a deployment be enabled and inert at
 * the same time with two different places to look for why.
 */
export interface ModelReadiness {
  readonly consumer: ModelConsumer;
  /** The provider this consumer names right now. */
  readonly provider: SupervisorModelProvider;
  /** What the log would record as having answered — see `reportedModelName`. */
  readonly model: string;
  /** True when a call would be attempted rather than refused. */
  readonly available: boolean;
  /** Null when available; otherwise the sentence naming what to set. */
  readonly unavailableReason: string | null;
}

export function modelReadiness(config: ModelConfig): ModelReadiness {
  const problem = unavailableReason(config);

  return {
    consumer: config.consumer,
    provider: config.provider,
    model: reportedModelName(config),
    available: problem === null,
    unavailableReason: problem === null ? null : problem.message,
  };
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
