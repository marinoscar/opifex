import { makeOperatorSettings } from '../../settings/operator-settings/operator-settings.test-double';
import {
  DEFAULT_SUPERVISOR_MODEL_PROVIDER,
  PROVIDER_BASE_URLS,
  SUPERVISOR_MODEL_PROVIDERS,
  UNAVAILABLE_MODEL_NAME,
  UNCONFIGURED_MODEL_NAME,
  effectiveBaseUrl,
  reportedModelName,
  resolveSupervisorModelConfig,
} from './supervisor-model.config';
import { UnavailableSupervisorModel } from './supervisor-model.port';

/**
 * The vendor-neutral half of a supervisor model adapter (#392).
 *
 * The base-URL rule is the subtle part of the issue and gets most of the file:
 * it decides which HOST an operator's API key is posted to, and getting it
 * wrong sends a credential somewhere it was not meant to go.
 */

describe('effectiveBaseUrl (#392)', () => {
  it('follows the provider when nothing is configured', () => {
    // The registry's default for `models.<provider>.baseUrl` is empty, so this
    // is what an untouched deployment resolves to on either provider.
    expect(effectiveBaseUrl('anthropic', '')).toBe(
      PROVIDER_BASE_URLS.anthropic,
    );
    expect(effectiveBaseUrl('openai', '')).toBe(PROVIDER_BASE_URLS.openai);
  });

  it('follows the provider when the configured host is another provider’s own', () => {
    // THE migration case, and the reason "overridden" is a property of the
    // value rather than of where the value came from. Every deployment that
    // copied SUPERVISOR_MODEL_BASE_URL=https://api.anthropic.com out of
    // `.env.example` has that string set explicitly; without this rule, all of
    // them would switch provider in the UI and still reach Anthropic — with an
    // OpenAI key, once an hour, in the decision log.
    expect(effectiveBaseUrl('openai', PROVIDER_BASE_URLS.anthropic)).toBe(
      PROVIDER_BASE_URLS.openai,
    );
    expect(effectiveBaseUrl('anthropic', PROVIDER_BASE_URLS.openai)).toBe(
      PROVIDER_BASE_URLS.anthropic,
    );
  });

  it('keeps a real override, on whichever provider is selected', () => {
    // A proxy, a gateway or a test double is the thing this key exists for,
    // and following the provider past one would break the override entirely.
    expect(effectiveBaseUrl('openai', 'https://proxy.internal')).toBe(
      'https://proxy.internal',
    );
    expect(effectiveBaseUrl('anthropic', 'https://proxy.internal')).toBe(
      'https://proxy.internal',
    );
  });

  it('never returns empty, so no adapter has to handle a hostless URL', () => {
    for (const provider of SUPERVISOR_MODEL_PROVIDERS) {
      for (const configured of ['', '   ', '/']) {
        expect(effectiveBaseUrl(provider, configured)).not.toBe('');
      }
    }
  });

  it('trims a trailing slash so an adapter does not double it', () => {
    expect(effectiveBaseUrl('openai', 'https://proxy.internal/')).toBe(
      'https://proxy.internal',
    );
    // And a canonical host with a slash is still canonical, which it would not
    // be if the comparison ran before the trim.
    expect(effectiveBaseUrl('openai', `${PROVIDER_BASE_URLS.anthropic}/`)).toBe(
      PROVIDER_BASE_URLS.openai,
    );
  });
});

describe('resolveSupervisorModelConfig (#344, #392)', () => {
  it('defaults to the provider ADR-0015 shipped, so an existing deployment is unchanged', () => {
    // No overrides and a hermetic environment: the registry's own defaults.
    const config = resolveSupervisorModelConfig(makeOperatorSettings());

    expect(config.provider).toBe(DEFAULT_SUPERVISOR_MODEL_PROVIDER);
    expect(config.provider).toBe('anthropic');
    expect(config.baseUrl).toBe(PROVIDER_BASE_URLS.anthropic);
  });

  it('resolves the base URL from the provider that is set right now', () => {
    const settings = makeOperatorSettings();

    expect(resolveSupervisorModelConfig(settings).baseUrl).toBe(
      PROVIDER_BASE_URLS.anthropic,
    );

    // The operator switches provider and touches nothing else, which is the
    // acceptance criterion in as few lines as it can be written.
    settings.setOverride('supervisor.model.provider', 'openai');

    expect(resolveSupervisorModelConfig(settings).baseUrl).toBe(
      PROVIDER_BASE_URLS.openai,
    );
  });

  it('reads every key on every call, so nothing is a stale copy (#344)', () => {
    const settings = makeOperatorSettings();
    expect(resolveSupervisorModelConfig(settings).apiKey).toBe('');

    settings.setOverride('models.anthropic.apiKey', 'sk-set-later');
    settings.setOverride('supervisor.model.name', 'a-model');
    settings.setOverride('supervisor.model.timeoutMs', 1234);
    settings.setOverride('supervisor.model.defaultMaxTokens', 77);

    expect(resolveSupervisorModelConfig(settings)).toMatchObject({
      apiKey: 'sk-set-later',
      model: 'a-model',
      timeoutMs: 1234,
      defaultMaxTokens: 77,
    });
  });
});

describe('reportedModelName (#89, ADR-0015)', () => {
  const config = (apiKey: string, model: string) => ({
    provider: 'openai' as const,
    apiKey,
    model,
    baseUrl: PROVIDER_BASE_URLS.openai,
    timeoutMs: 1000,
    defaultMaxTokens: 16,
  });

  it('reports the model string verbatim, whatever it is', () => {
    // #89: "runs on a small model" has to be checkable against the log rather
    // than against a config file's claim about what it would have sent.
    expect(reportedModelName(config('sk', 'some-future-model'))).toBe(
      'some-future-model',
    );
  });

  it('keeps "a key naming no model" apart from "no key at all"', () => {
    // ADR-0015's argument: a typo in a model name must not read like a
    // deliberate decision not to run a supervisor.
    expect(reportedModelName(config('sk', ''))).toBe(UNCONFIGURED_MODEL_NAME);
    expect(reportedModelName(config('', ''))).toBe(UNAVAILABLE_MODEL_NAME);
    expect(UNCONFIGURED_MODEL_NAME).not.toBe(UNAVAILABLE_MODEL_NAME);
  });

  it('says "no key" with the same word the unbound default says', () => {
    // Not a coincidence to be asserted loosely: the decision-log `model`
    // column for an unconfigured supervisor has to read what it read when no
    // adapter was bound at all. If either string moves, this is where the two
    // stop agreeing.
    expect(reportedModelName(config('', 'anything'))).toBe(
      new UnavailableSupervisorModel().name,
    );
  });
});
