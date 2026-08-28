import { Injectable, Logger } from '@nestjs/common';

import { OperatorSettingsService } from '../../settings/operator-settings/operator-settings.service';
import { ANTHROPIC_VERSION } from './anthropic-supervisor-model';
import {
  MODEL_VERSION_FLOOR,
  classifyModelId,
  formatModelVersion,
  type ModelAdmission,
} from './model-version';
import {
  errorDetail,
  errorMessage,
  isAbort,
  modelApiKeySettingKey,
  resolveModelConfig,
  type ModelConfig,
  type ModelConsumer,
  type SupervisorModelProvider,
} from './supervisor-model.config';

/**
 * What the configured key can actually reach (#393, epic #391).
 *
 * ## Why this exists
 *
 * `supervisor.model.name` is free text posted verbatim as the request's
 * `model` field. An operator has to know a literal catalogue string, type it
 * without validation, and finds out about a typo as a failure once an hour in
 * the decision log with nobody looking. This asks the provider instead.
 *
 * ## It spends nothing, and that is a property worth publishing
 *
 * `GET /v1/models` bills no tokens on either vendor, which makes it a
 * credential check that costs nothing sitting beside `supervisor-model` in
 * `OperatorProbesService` — a probe that deliberately spends real money and is
 * rate limited because of it. Those are two different kinds of action and the
 * UI must not present them as one, so `spendsTokens` is a field rather than a
 * sentence in a description: a client that had to know which routes are free
 * would be hard-coding a fact about this endpoint, and the day a vendor starts
 * charging for a catalogue read the hard-coded copy is the one that stays
 * wrong. There is no rate limiter here for the same reason there is one there.
 *
 * ## It reports; it does not throw
 *
 * The same rule `OperatorProbesService` states in its header, and for the same
 * reason: "the request failed" and "the request found a failure" are the two
 * things this endpoint exists to tell apart, and putting them behind one HTTP
 * status destroys the distinction before the UI ever sees it. An invalid key,
 * an unreachable host and a key for the other provider are all 200 with a
 * `status` that says which. Only a bug produces a 5xx.
 *
 * ## Why it is in `invocation/`
 *
 * `supervisor-model.port.ts`: "nothing outside `invocation/` may name a model
 * provider", asserted over the source by
 * `test/governing/supervisor-provider-seam.spec.ts`. Listing models is
 * irreducibly vendor-shaped — a path, an auth header, a field spelling, a
 * timestamp unit — so this file names both vendors and therefore belongs here.
 * The controller that exposes it takes the whole answer as data and names
 * nobody.
 */

/**
 * Why the list is what it is.
 *
 * Each arm names a DIFFERENT REMEDY, which is the test for whether it earns
 * its place. #393's requirement is that failure be legible, and the case it
 * calls out — "a key valid for a provider other than the one configured" — is
 * the one that would otherwise be reported as `invalid_key`, sending an
 * operator off to reissue a credential that was never the problem.
 */
export const MODEL_CATALOG_STATUSES = [
  /** The provider answered with a list. `models` may still be empty. */
  'ok',
  /** No key is configured. Nothing to list yet — not an error. */
  'no_key',
  /** The provider rejected the credential. Remedy: a different key. */
  'invalid_key',
  /**
   * Rejected, AND the key is shaped like the OTHER provider's.
   *
   * The most likely real mistake once there are two providers, and the one
   * `invalid_key` would describe misleadingly. Remedy: change the provider
   * setting, not the key.
   */
  'wrong_provider',
  /** Nothing answered: DNS, network, proxy, or the timeout. Not a key verdict. */
  'unreachable',
  /** Authenticated and then refused (403). Remedy: scope, project, or region. */
  'refused',
  /** The provider answered something else — 429, a 5xx, or an unreadable body. */
  'failed',
] as const;

export type ModelCatalogStatus = (typeof MODEL_CATALOG_STATUSES)[number];

/** One model, as offered to the operator. Never omitted for its version. */
export interface CatalogModel {
  /** The exact string that would be written to `supervisor.model.name`. */
  readonly id: string;
  /** The vendor's own label, where it publishes one. */
  readonly displayName: string | null;
  /** `"4.6"`, or null when the id did not parse. Null is not a failure. */
  readonly version: string | null;
  readonly admission: ModelAdmission;
  /** When the vendor published it, ISO-8601, or null when it did not say. */
  readonly createdAt: string | null;
}

/** The whole answer. One object, whatever happened. */
export interface SupervisorModelCatalog {
  /**
   * Which consumer's selection this answers for (#423).
   *
   * Echoed rather than left implicit because the Control Center now holds two
   * of these lists at once — one per consumer — and a response that did not
   * say which one it was would let a slow answer for the supervisor land in
   * the chat's dropdown, offering models that the chat's key may not reach.
   */
  readonly consumer: ModelConsumer;
  /** The provider this was asked of — `<consumer>.model.provider`, live. */
  readonly provider: SupervisorModelProvider;
  readonly status: ModelCatalogStatus;
  /** One human sentence. Never contains the key. */
  readonly detail: string;
  /** The version floor applied, e.g. `"4.6"`. Shown so the filter is legible. */
  readonly minimumVersion: string;
  /** Always false here. See this file's header for why it is a field. */
  readonly spendsTokens: boolean;
  /** Empty on every failure, and possibly empty on success. */
  readonly models: readonly CatalogModel[];
  readonly checkedAt: string;
}

@Injectable()
export class SupervisorModelCatalogService {
  private readonly logger = new Logger(SupervisorModelCatalogService.name);

  constructor(private readonly settings: OperatorSettingsService) {}

  /**
   * Ask ONE consumer's configured provider, with its key, right now.
   *
   * Every setting is resolved per call through `resolveModelConfig`, exactly
   * as the adapters do since #344: a key or a provider an operator has just
   * saved must be reachable on the next request rather than the next restart,
   * and a second boot-time copy of either is the thing that made that untrue
   * before.
   *
   * The consumer is a required argument rather than one defaulting to the
   * supervisor (#423). A default here would be a third place that decides
   * which consumer is meant — after the query parameter and the settings key
   * — and the failure it produces is a dropdown quietly listing the wrong
   * provider's models, which looks exactly like a correct list.
   */
  async list(consumer: ModelConsumer): Promise<SupervisorModelCatalog> {
    const config = resolveModelConfig(this.settings, consumer);
    const listing = LISTINGS[config.provider];

    if (config.apiKey === '') {
      return this.answer(config, 'no_key', [
        `No API key is stored for the provider ${consumer} is set to, so`,
        `there is nothing to list yet. Save ${modelApiKeySettingKey(config.provider)}`,
        'and list again — listing models spends no tokens.',
      ]);
    }

    const url = `${config.baseUrl}${listing.path}`;

    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          ...listing.headers(config.apiKey),
          accept: 'application/json',
        },
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (error) {
      return this.unreachable(config, listing, error);
    }

    if (!response.ok) return this.rejected(config, listing, response);

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      return this.answer(config, 'failed', [
        `${listing.label} answered ${response.status} with a body that is not`,
        `JSON: ${errorMessage(error)}.`,
      ]);
    }

    const rows = modelRows(payload);

    if (rows === null) {
      return this.answer(config, 'failed', [
        `${listing.label} answered, but the body has no list of models in it.`,
        `If ${hostOf(config.baseUrl)} is a proxy or a gateway, it may not`,
        'implement the model catalogue.',
      ]);
    }

    const models = sortForSelection(
      rows
        .map((row) => listing.read(row))
        .filter((model): model is RawModel => model !== null)
        .map((model) => describe(config.provider, model)),
    );

    return this.answer(config, 'ok', [summarise(config, models)], models);
  }

  // -------------------------------------------------------------------------
  // Failure, told apart
  // -------------------------------------------------------------------------

  /**
   * Nothing answered.
   *
   * Deliberately NOT a key verdict. Telling an operator their credential is
   * bad when the real problem is DNS or an unreachable proxy is the kind of
   * wrong answer that costs an hour — `describeGitHubFailure` makes the same
   * distinction with its `status === 0` arm, for the same reason.
   */
  private unreachable(
    config: ModelConfig,
    listing: ProviderListing,
    error: unknown,
  ): SupervisorModelCatalog {
    const problem = isAbort(error)
      ? `no answer within ${config.timeoutMs}ms`
      : errorMessage(error);

    return this.answer(config, 'unreachable', [
      `${listing.label} could not be reached at ${hostOf(config.baseUrl)}:`,
      `${problem}. The request never got an answer, so this says nothing`,
      'about the key — check the network, the proxy, and the base URL.',
    ]);
  }

  /**
   * The provider answered, and the answer was no.
   *
   * The interesting branch is `wrong_provider`, and the signal it uses is the
   * KEY'S OWN SHAPE rather than anything in the response, because neither
   * vendor's 401 says "this looks like somebody else's credential" — both say
   * the key is invalid, which is true and useless. The prefixes are published
   * conventions (`sk-ant-` for one, `sk-` for the other), so a key that
   * announces itself as the other vendor's while the provider setting says
   * this one is very unlikely to be an expired key and very likely to be a
   * provider setting nobody changed.
   *
   * The shape is only consulted AFTER a rejection. Checking it up front and
   * refusing to call would break the documented base-URL override: a gateway
   * may perfectly well accept a credential in any format, and the endpoint
   * would then be refusing a configuration that works.
   */
  private rejected(
    config: ModelConfig,
    listing: ProviderListing,
    response: Response,
  ): Promise<SupervisorModelCatalog> {
    return errorDetail(response).then((raw) => {
      const host = hostOf(config.baseUrl);
      // The provider's own words, minus the credential. Neither vendor
      // echoes a key in full today and OpenAI masks the middle of one, but a
      // proxy sitting on `models.<provider>.baseUrl` is under nobody's control
      // and this string is rendered in the Control Center beside the field
      // the key was typed into, and logged on the way. Redacting once, here,
      // is cheaper than being sure of every hop.
      const detail = withoutKey(raw, config.apiKey);

      this.logger.warn(
        `Listing models on ${host} returned ${response.status}: ${detail}`,
      );

      const shaped = providerOfKeyShape(config.apiKey);

      if (
        (response.status === 401 || response.status === 403) &&
        shaped !== null &&
        shaped !== config.provider
      ) {
        return this.answer(config, 'wrong_provider', [
          `${host} rejected the key (${response.status}), and the key is`,
          `shaped like a ${LISTINGS[shaped].label} key while the configured`,
          `provider is ${listing.label}. That is far more likely to be a`,
          'provider setting that does not match the key than a bad key.',
          `Either select ${LISTINGS[shaped].label}, or paste a`,
          `${listing.label} key.`,
        ]);
      }

      if (response.status === 401) {
        return this.answer(config, 'invalid_key', [
          `${host} rejected the key (401): ${detail}. The key is wrong,`,
          'expired, or revoked.',
        ]);
      }

      if (response.status === 403) {
        return this.answer(config, 'refused', [
          `${host} accepted the key and refused the request (403): ${detail}.`,
          'The credential authenticates; it is not permitted to list models —',
          'usually a project, scope or region restriction rather than a bad',
          'key.',
        ]);
      }

      return this.answer(config, 'failed', [
        `${host} answered ${response.status}: ${detail}.`,
      ]);
    });
  }

  // -------------------------------------------------------------------------
  // Seams and assembly
  // -------------------------------------------------------------------------

  protected now(): number {
    return Date.now();
  }

  private answer(
    config: ModelConfig,
    status: ModelCatalogStatus,
    detail: readonly string[],
    models: readonly CatalogModel[] = [],
  ): SupervisorModelCatalog {
    return {
      consumer: config.consumer,
      provider: config.provider,
      status,
      detail: detail.join(' '),
      minimumVersion: formatModelVersion(MODEL_VERSION_FLOOR[config.provider]),
      // A constant, and deliberately still a field. See the header.
      spendsTokens: false,
      models,
      checkedAt: new Date(this.now()).toISOString(),
    };
  }
}

// ---------------------------------------------------------------------------
// The two catalogues
// ---------------------------------------------------------------------------

/** What one vendor's `data` entry gave us, before the version filter runs. */
interface RawModel {
  readonly id: string;
  readonly displayName: string | null;
  readonly createdAt: string | null;
}

interface ProviderListing {
  /** How the vendor is named in a sentence an operator reads. */
  readonly label: string;
  /** Appended to the resolved base URL. */
  readonly path: string;
  readonly headers: (apiKey: string) => Record<string, string>;
  /** One `data` entry, or null when it carries no usable id. */
  readonly read: (row: Record<string, unknown>) => RawModel | null;
}

const LISTINGS: Readonly<Record<SupervisorModelProvider, ProviderListing>> =
  Object.freeze({
    anthropic: {
      label: 'Anthropic',
      // 1000 is the documented maximum page size, and no vendor publishes
      // anything close to that many models — so one request is the whole
      // catalogue and there is no pagination loop to get wrong. The default
      // page size is 20, which WOULD truncate.
      path: '/v1/models?limit=1000',
      headers: (apiKey: string) => ({
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      }),
      read: (row) => {
        const id = text(row.id);
        return id === null
          ? null
          : {
              id,
              displayName: text(row.display_name),
              createdAt: isoFrom(row.created_at),
            };
      },
    },
    openai: {
      label: 'OpenAI',
      path: '/v1/models',
      headers: (apiKey: string) => ({ authorization: `Bearer ${apiKey}` }),
      read: (row) => {
        const id = text(row.id);
        return id === null
          ? null
          : {
              id,
              // OpenAI publishes no display name. Null rather than a copy of
              // the id, so the UI can tell "no label" from "labelled the
              // same".
              displayName: null,
              // Unix seconds here, an ISO string on the other vendor.
              createdAt: isoFrom(row.created),
            };
      },
    },
  });

/**
 * Which provider a key ANNOUNCES itself as, by prefix, or null.
 *
 * Order matters: every Anthropic key is also an `sk-` key, so the longer,
 * vendor-specific prefix has to be tested first. Null for anything else — a
 * gateway token, or a format either vendor introduces later — and null means
 * "no opinion", which is what keeps this from ever being the reason a
 * configuration is refused.
 */
export function providerOfKeyShape(
  apiKey: string,
): SupervisorModelProvider | null {
  if (apiKey.startsWith('sk-ant-')) return 'anthropic';
  if (apiKey.startsWith('sk-')) return 'openai';
  return null;
}

// ---------------------------------------------------------------------------
// Reading a list
// ---------------------------------------------------------------------------

/** `{ data: [...] }` — the envelope both vendors use. Null if it is missing. */
function modelRows(payload: unknown): Record<string, unknown>[] | null {
  if (payload === null || typeof payload !== 'object') return null;

  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;

  return data.filter(
    (row): row is Record<string, unknown> =>
      row !== null && typeof row === 'object',
  );
}

/** Classify one model. The one place the three states are attached. */
function describe(
  provider: SupervisorModelProvider,
  model: RawModel,
): CatalogModel {
  const { status, version } = classifyModelId(provider, model.id);

  return {
    id: model.id,
    displayName: model.displayName,
    version: version === null ? null : formatModelVersion(version),
    admission: status,
    createdAt: model.createdAt,
  };
}

/**
 * The order the dropdown is rendered in.
 *
 * Admitted first, then UNRECOGNISED, then below the floor. The middle position
 * is the deliberate one: an id that did not parse may well be the newest model
 * the vendor has, so burying it under forty superseded ones would undo most of
 * what returning it achieved. Within a group, newest version first, then id,
 * so the order is stable across calls.
 */
function sortForSelection(models: readonly CatalogModel[]): CatalogModel[] {
  const rank: Record<ModelAdmission, number> = {
    admitted: 0,
    version_unrecognised: 1,
    below_threshold: 2,
  };

  return [...models].sort((left, right) => {
    if (rank[left.admission] !== rank[right.admission]) {
      return rank[left.admission] - rank[right.admission];
    }

    const byVersion = versionKey(right) - versionKey(left);
    if (byVersion !== 0) return byVersion;

    return left.id.localeCompare(right.id);
  });
}

/** A sortable number for a `"5.4"`. Unparsed ids all tie and fall to the id. */
function versionKey(model: CatalogModel): number {
  if (model.version === null) return -1;
  const [major, minor] = model.version.split('.');
  // Not `Number('5.4')`: a minor of 10 must sort above a minor of 9, and 5.10
  // as a float is 5.1.
  return Number(major) * 1000 + Number(minor);
}

/** The success sentence, which is also the credential finding. */
function summarise(
  config: ModelConfig,
  models: readonly CatalogModel[],
): string {
  const label = LISTINGS[config.provider].label;
  const floor = formatModelVersion(MODEL_VERSION_FLOOR[config.provider]);

  if (models.length === 0) {
    return (
      `${label} accepted the key and listed no models at all. The credential ` +
      `works; it can reach nothing.`
    );
  }

  const admitted = models.filter((m) => m.admission === 'admitted').length;
  const unknown = models.filter(
    (m) => m.admission === 'version_unrecognised',
  ).length;

  const marked =
    unknown === 0
      ? ''
      : ` ${unknown} could not be version-checked and ${
          unknown === 1 ? 'is' : 'are'
        } listed marked rather than hidden.`;

  return (
    `${label} listed ${models.length} model${models.length === 1 ? '' : 's'}, ` +
    `${admitted} of them ${floor} or newer.${marked} Listing spends no ` +
    `tokens, so this also confirms the key authenticates.`
  );
}

// ---------------------------------------------------------------------------
// Small readers
// ---------------------------------------------------------------------------

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * An ISO timestamp from either spelling: a string, or Unix seconds.
 *
 * Null when it is neither, or when it is not a real date — a made-up timestamp
 * would sort a model into the wrong place in a list an operator is choosing
 * from, which is worse than showing no date at all.
 */
function isoFrom(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value * 1000);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  if (typeof value === 'string' && value !== '') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  return null;
}

/**
 * The provider's message with the configured key taken out of it.
 *
 * Whole-key only: a partial echo cannot be matched without guessing, and a
 * heuristic that redacted anything key-shaped would mangle the model ids and
 * the request ids that make a failure diagnosable. What this guarantees is the
 * one thing that can be guaranteed — the exact secret we sent never comes back
 * out.
 */
function withoutKey(detail: string, apiKey: string): string {
  if (apiKey.length < 8) return detail;
  return detail.split(apiKey).join('[redacted]');
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}
