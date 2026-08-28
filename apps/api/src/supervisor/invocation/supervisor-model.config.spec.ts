import { makeOperatorSettings } from '../../settings/operator-settings/operator-settings.test-double';
import {
  DEFAULT_SUPERVISOR_MODEL_PROVIDER,
  MODEL_CONSUMERS,
  PROVIDER_BASE_URLS,
  SUPERVISOR_MODEL_PROVIDERS,
  UNAVAILABLE_MODEL_NAME,
  UNCONFIGURED_MODEL_NAME,
  effectiveBaseUrl,
  modelMaxTokensSettingKey,
  modelNameEnvVar,
  modelNameSettingKey,
  modelProviderSettingKey,
  modelReadiness,
  modelTimeoutSettingKey,
  reportedModelName,
  resolveModelConfig,
  resolveSupervisorModelConfig,
  unavailableReason,
  type ModelConfig,
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
  const config = (apiKey: string, model: string): ModelConfig => ({
    consumer: 'supervisor',
    provider: 'openai',
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

// ---------------------------------------------------------------------------
// The second consumer (#423, epic #419)
// ---------------------------------------------------------------------------

/**
 * Two consumers, one set of credentials.
 *
 * The claim epic #419 makes is not that a chat can be configured — it is that
 * configuring the chat cannot disturb the supervisor, and that both reach the
 * one stored key for whichever vendor each of them names. So every assertion
 * below sets ONE consumer's keys and checks the other one as well.
 */
describe('resolveModelConfig, two consumers (#423)', () => {
  /** Both credentials stored at once, which is what #422 made possible. */
  function withBothKeys() {
    const settings = makeOperatorSettings();
    settings.setOverride('models.anthropic.apiKey', 'sk-ant-stored');
    settings.setOverride('models.openai.apiKey', 'sk-proj-stored');
    return settings;
  }

  it('lets the supervisor and the chat sit on different providers at once', () => {
    // THE acceptance criterion, in one test. Each consumer names a vendor,
    // and each resolves that vendor's own key and that vendor's own host —
    // neither the credential nor the endpoint follows the other consumer.
    const settings = withBothKeys();
    settings.setOverride('supervisor.model.provider', 'anthropic');
    settings.setOverride('supervisor.model.name', 'claude-opus-4-6');
    settings.setOverride('chat.model.provider', 'openai');
    settings.setOverride('chat.model.name', 'gpt-5.4');

    expect(resolveModelConfig(settings, 'supervisor')).toMatchObject({
      consumer: 'supervisor',
      provider: 'anthropic',
      apiKey: 'sk-ant-stored',
      model: 'claude-opus-4-6',
      baseUrl: PROVIDER_BASE_URLS.anthropic,
    });

    expect(resolveModelConfig(settings, 'chat')).toMatchObject({
      consumer: 'chat',
      provider: 'openai',
      apiKey: 'sk-proj-stored',
      model: 'gpt-5.4',
      baseUrl: PROVIDER_BASE_URLS.openai,
    });
  });

  it('shares the one credential when both name the same provider', () => {
    // The other half of the credential/consumer split: a key belongs to a
    // vendor, not to a consumer, so pointing both at one vendor must not need
    // the key entered twice — and must not stop them running different models.
    const settings = withBothKeys();
    settings.setOverride('supervisor.model.provider', 'anthropic');
    settings.setOverride('supervisor.model.name', 'claude-opus-4-6');
    settings.setOverride('chat.model.provider', 'anthropic');
    settings.setOverride('chat.model.name', 'claude-haiku-4-5');

    const supervisor = resolveModelConfig(settings, 'supervisor');
    const chat = resolveModelConfig(settings, 'chat');

    expect(chat.apiKey).toBe(supervisor.apiKey);
    expect(chat.baseUrl).toBe(supervisor.baseUrl);
    expect(chat.model).not.toBe(supervisor.model);
    expect(chat.model).toBe('claude-haiku-4-5');
  });

  it('leaves the supervisor exactly as it was when the chat is configured', () => {
    // The regression that would matter most: #423 must be invisible to a
    // deployment that never touches the chat. Resolved BEFORE and AFTER the
    // chat is pointed somewhere else entirely, and compared whole rather than
    // field by field, so a field added later is covered without being listed.
    const settings = withBothKeys();
    settings.setOverride('supervisor.model.name', 'claude-opus-4-6');

    const before = resolveSupervisorModelConfig(settings);

    settings.setOverride('chat.model.provider', 'openai');
    settings.setOverride('chat.model.name', 'gpt-5.4');
    settings.setOverride('chat.model.timeoutMs', 5_000);
    settings.setOverride('chat.model.defaultMaxTokens', 99);

    expect(resolveSupervisorModelConfig(settings)).toEqual(before);
    expect(before.timeoutMs).toBe(60_000);
    expect(before.defaultMaxTokens).toBe(1_024);
  });

  it('reads each consumer’s own timeout and ceiling, not one shared pair', () => {
    // Split rather than shared, deliberately: a chat turn somebody is waiting
    // on and an hourly judgement nobody is watching do not want the same
    // number. If these two keys were ever folded into one, this fails.
    const settings = makeOperatorSettings();
    settings.setOverride('supervisor.model.timeoutMs', 60_000);
    settings.setOverride('chat.model.timeoutMs', 9_000);
    settings.setOverride('supervisor.model.defaultMaxTokens', 1_024);
    settings.setOverride('chat.model.defaultMaxTokens', 4_096);

    expect(resolveModelConfig(settings, 'supervisor')).toMatchObject({
      timeoutMs: 60_000,
      defaultMaxTokens: 1_024,
    });
    expect(resolveModelConfig(settings, 'chat')).toMatchObject({
      timeoutMs: 9_000,
      defaultMaxTokens: 4_096,
    });
  });

  it('resolves the supervisor identically through either entry point', () => {
    // `resolveSupervisorModelConfig` is a delegation, not a second reader.
    // Asserted rather than assumed, because the day it stops being one is the
    // day the supervisor and everything reporting on it disagree.
    const settings = withBothKeys();
    settings.setOverride('supervisor.model.provider', 'openai');
    settings.setOverride('supervisor.model.name', 'gpt-5.4');

    expect(resolveSupervisorModelConfig(settings)).toEqual(
      resolveModelConfig(settings, 'supervisor'),
    );
  });

  it('reads every consumer’s keys on every call, so nothing is a stale copy', () => {
    const settings = makeOperatorSettings();

    for (const consumer of MODEL_CONSUMERS) {
      expect(resolveModelConfig(settings, consumer).model).toBe('');

      settings.setOverride(modelNameSettingKey(consumer), `${consumer}-model`);
      settings.setOverride(modelTimeoutSettingKey(consumer), 4_321);
      settings.setOverride(modelMaxTokensSettingKey(consumer), 33);

      expect(resolveModelConfig(settings, consumer)).toMatchObject({
        consumer,
        model: `${consumer}-model`,
        timeoutMs: 4_321,
        defaultMaxTokens: 33,
      });
    }
  });

  it('gives every declared consumer a provider setting that exists', () => {
    // The structural half. `settings.get` would not COMPILE for a consumer
    // with no registry rows, but a spec that only exercised the two known
    // consumers by name would not notice a third arriving — this one iterates
    // the list, so the day it grows, the new member is resolved here too.
    expect(MODEL_CONSUMERS.length).toBeGreaterThan(1);

    for (const consumer of MODEL_CONSUMERS) {
      const config = resolveModelConfig(makeOperatorSettings(), consumer);

      expect(config.consumer).toBe(consumer);
      expect(SUPERVISOR_MODEL_PROVIDERS).toContain(config.provider);
      expect(config.baseUrl).not.toBe('');
      expect(modelProviderSettingKey(consumer)).toBe(
        `${consumer}.model.provider`,
      );
    }
  });
});

describe('modelReadiness: inert, and saying so (#423, #324)', () => {
  it('reports an untouched chat as unavailable, naming the missing key', () => {
    // The requirement in one line: a chat nobody has configured must SAY it is
    // unconfigured, not fail at the first instruction. The default deployment
    // has neither a key nor a model name, and the sentence names the key —
    // the first of the two steps, not the second.
    const readiness = modelReadiness(
      resolveModelConfig(makeOperatorSettings(), 'chat'),
    );

    expect(readiness.available).toBe(false);
    expect(readiness.consumer).toBe('chat');
    expect(readiness.model).toBe(UNAVAILABLE_MODEL_NAME);
    expect(readiness.unavailableReason).toContain('models.anthropic.apiKey');
  });

  it('tells a chat pointed at an unkeyed provider which slot is empty', () => {
    // The mistake this exists for: an operator holding one vendor's key
    // selects the other for the chat. Nothing fails — the chat is simply
    // inert — and the sentence has to say WHICH credential is missing rather
    // than "not configured".
    const settings = makeOperatorSettings();
    settings.setOverride('models.anthropic.apiKey', 'sk-ant-stored');
    settings.setOverride('chat.model.provider', 'openai');
    settings.setOverride('chat.model.name', 'gpt-5.4');

    const readiness = modelReadiness(resolveModelConfig(settings, 'chat'));

    expect(readiness.available).toBe(false);
    expect(readiness.unavailableReason).toContain('models.openai.apiKey');
    expect(readiness.unavailableReason).not.toContain('models.anthropic');
    // And it offers a remedy the CHAT has. "Turn the supervisor off" is not
    // advice a chat can act on, and would send an operator to the wrong
    // switch entirely.
    expect(readiness.unavailableReason).toContain(
      'leave the chat unconfigured',
    );
    expect(readiness.unavailableReason).not.toContain(
      'turn the supervisor off',
    );
  });

  it('reports a keyed chat with no model named, naming CHAT_MODEL_NAME', () => {
    // The second of the two half-configured states, and the one the supervisor
    // has always distinguished: a key with no model is a deployment part way
    // through being set up, not one that decided against a chat.
    const settings = makeOperatorSettings();
    settings.setOverride('models.anthropic.apiKey', 'sk-ant-stored');

    const config = resolveModelConfig(settings, 'chat');
    const readiness = modelReadiness(config);

    expect(readiness.available).toBe(false);
    expect(readiness.model).toBe(UNCONFIGURED_MODEL_NAME);
    expect(readiness.unavailableReason).toContain(modelNameEnvVar('chat'));
    expect(modelNameEnvVar('chat')).toBe('CHAT_MODEL_NAME');
  });

  it('is available once the provider it names has a key and a model', () => {
    const settings = makeOperatorSettings();
    settings.setOverride('models.openai.apiKey', 'sk-proj-stored');
    settings.setOverride('chat.model.provider', 'openai');
    settings.setOverride('chat.model.name', 'gpt-5.4');

    expect(modelReadiness(resolveModelConfig(settings, 'chat'))).toEqual({
      consumer: 'chat',
      provider: 'openai',
      model: 'gpt-5.4',
      available: true,
      unavailableReason: null,
    });
  });

  it('is one predicate with the refusal an adapter throws', () => {
    // `unavailableReason` is what the adapters throw and what this reports, so
    // a caller that asks first and a call that refuses cannot disagree. Two
    // copies of the same condition is how they would.
    const settings = makeOperatorSettings();
    const config = resolveModelConfig(settings, 'chat');

    expect(modelReadiness(config).unavailableReason).toBe(
      unavailableReason(config)?.message,
    );
    expect(
      unavailableReason({ ...config, apiKey: 'sk', model: 'm' }),
    ).toBeNull();
  });

  it('leaves the supervisor’s own sentences byte for byte as they were', () => {
    // #423 rewords these messages per consumer. The supervisor's wording is
    // asserted here rather than trusted, because `operator-probes.service`
    // pins the second sentence and the decision log has been recording the
    // first for as long as ADR-0015 has shipped.
    const settings = makeOperatorSettings();
    const unkeyed = resolveSupervisorModelConfig(settings);

    expect(unavailableReason(unkeyed)?.message).toBe(
      'No API key is configured for Anthropic, so there is no model to ask. ' +
        'Set models.anthropic.apiKey — the "Anthropic API key" setting, ' +
        'MODEL_ANTHROPIC_API_KEY in the environment — to a separately metered ' +
        'credential, select a provider you have given a key to, or turn the ' +
        'supervisor off. A key set now takes effect on the next invocation; ' +
        'no restart is needed.',
    );

    settings.setOverride('models.anthropic.apiKey', 'sk-ant-stored');

    expect(
      unavailableReason(resolveSupervisorModelConfig(settings))?.message,
    ).toBe(
      'models.anthropic.apiKey is set but SUPERVISOR_MODEL_NAME is not, so ' +
        'there is no model to ask.',
    );
  });
});
