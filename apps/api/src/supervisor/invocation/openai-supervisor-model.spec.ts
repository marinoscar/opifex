import type { OperatorSettingsOverrides } from '../../settings/operator-settings/operator-settings.registry';
import { makeOperatorSettings } from '../../settings/operator-settings/operator-settings.test-double';
import { AnthropicSupervisorModel } from './anthropic-supervisor-model';
import { OpenAiSupervisorModel } from './openai-supervisor-model';
import {
  PROVIDER_BASE_URLS,
  modelApiKeySettingKey,
  SupervisorModelError,
} from './supervisor-model.config';
import { createSupervisorModel } from './supervisor-model.factory';

/**
 * The supervisor's OpenAI adapter (#392, epic #391).
 *
 * `fetch` is stubbed throughout. Nothing in this file may reach the network:
 * a suite that can only pass with a credential is a suite that does not run in
 * CI, and an adapter whose error mapping is only exercised against the real
 * API is an adapter whose error mapping is never exercised at all.
 *
 * Written against `anthropic-supervisor-model.spec.ts` deliberately, case for
 * case, because the claim #392 makes is that the SEAM did not change — and the
 * cheapest way to keep that claim honest is for the two suites to be legible
 * side by side.
 */

const MODEL = 'gpt-5.6-luna';

const SETTINGS: OperatorSettingsOverrides = {
  'supervisor.model.provider': 'openai',
  'models.openai.apiKey': 'sk-openai-test',
  'supervisor.model.name': MODEL,
  'models.openai.baseUrl': 'https://api.openai.test',
  'supervisor.model.timeoutMs': 5000,
  'supervisor.model.defaultMaxTokens': 1024,
};

function operatorSettings(overrides: OperatorSettingsOverrides = {}) {
  return makeOperatorSettings({ overrides: { ...SETTINGS, ...overrides } });
}

/** Through the factory, so every case is about the object production binds. */
function adapter(overrides: OperatorSettingsOverrides = {}) {
  return createSupervisorModel(operatorSettings(overrides));
}

/**
 * A Chat Completions response.
 *
 * Built fresh per call rather than shared, because a `Response` body can only
 * be read once and the second read fails several frames from the cause.
 */
function chatResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function answer(text: string, inputTokens = 1000, outputTokens = 500): unknown {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    model: MODEL,
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content: text, refusal: null },
      },
    ],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  };
}

let fetchMock: jest.Mock;
const realFetch = global.fetch;

beforeEach(() => {
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = realFetch;
  jest.restoreAllMocks();
});

/** The `init` of the nth `fetch` call, typed. */
function callInit(index = 0): RequestInit {
  return fetchMock.mock.calls[index][1] as RequestInit;
}

function sentBody(index = 0): Record<string, unknown> {
  return JSON.parse(String(callInit(index).body)) as Record<string, unknown>;
}

describe('OpenAiSupervisorModel (#392)', () => {
  describe('the request', () => {
    it('posts one message to Chat Completions with a bearer token', async () => {
      fetchMock.mockImplementation(async () => chatResponse(answer('hi')));

      await adapter().ask({ snapshot: 'STATE', instruction: 'ASK' });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://api.openai.test/v1/chat/completions',
      );

      const init = callInit();
      expect(init.method).toBe('POST');
      expect(init.headers).toMatchObject({
        authorization: 'Bearer sk-openai-test',
        'content-type': 'application/json',
      });
      // Anthropic's header, on OpenAI's request, would mean the two adapters
      // had been copied rather than written.
      expect(init.headers).not.toHaveProperty('x-api-key');
    });

    it('sends the snapshot and the instruction as one user turn', async () => {
      fetchMock.mockImplementation(async () => chatResponse(answer('hi')));

      await adapter().ask({ snapshot: 'STATE', instruction: 'ASK' });

      expect(sentBody()).toMatchObject({
        model: MODEL,
        messages: [{ role: 'user', content: 'STATE\n\nASK' }],
      });
      // VISION §7: the supervisor holds no state in its context. One turn, no
      // system message, no conversation id.
      expect((sentBody().messages as unknown[]).length).toBe(1);
    });

    it('sends no tools, ever', async () => {
      // #90: execution must be structurally impossible, not merely
      // unimplemented. A tool definition on this request would make the
      // supervisor an executor with extra steps.
      fetchMock.mockImplementation(async () => chatResponse(answer('hi')));

      await adapter().ask({ snapshot: 'STATE', instruction: 'ASK' });

      expect(sentBody()).not.toHaveProperty('tools');
      expect(sentBody()).not.toHaveProperty('tool_choice');
      expect(sentBody()).not.toHaveProperty('functions');
    });

    it('sends the model name verbatim, whatever it is', async () => {
      // Sent as configured, not normalised or validated against a list: the
      // string in the log has to be the string that was actually sent (#89).
      fetchMock.mockImplementation(async () => chatResponse(answer('hi')));
      const model = adapter({ 'supervisor.model.name': 'some-future-model' });

      await model.ask({ snapshot: 'S', instruction: 'I' });

      expect(sentBody().model).toBe('some-future-model');
      expect(model.name).toBe('some-future-model');
    });

    it('names the token ceiling max_completion_tokens, not max_tokens', async () => {
      // `max_tokens` is gone from the current request schema and is rejected
      // outright by the reasoning models this adapter is mostly pointed at, so
      // the older spelling would turn the supervisor's own token ceiling into
      // a 400 once an hour.
      fetchMock.mockImplementation(async () => chatResponse(answer('hi')));

      await adapter({ 'supervisor.model.defaultMaxTokens': 777 }).ask({
        snapshot: 'S',
        instruction: 'I',
      });

      expect(sentBody().max_completion_tokens).toBe(777);
      expect(sentBody()).not.toHaveProperty('max_tokens');
    });

    it("honours a proposer's own ceiling", async () => {
      // One proposer must not be able to spend the whole invocation.
      fetchMock.mockImplementation(async () => chatResponse(answer('hi')));

      await adapter().ask({
        snapshot: 'S',
        instruction: 'I',
        maxOutputTokens: 400,
      });

      expect(sentBody().max_completion_tokens).toBe(400);
    });

    it('does not double the slash when the base URL ends in one', async () => {
      fetchMock.mockImplementation(async () => chatResponse(answer('hi')));

      await adapter({
        'models.openai.baseUrl': 'https://api.openai.test/',
      }).ask({ snapshot: 'S', instruction: 'I' });

      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://api.openai.test/v1/chat/completions',
      );
    });
  });

  describe('the response', () => {
    it('returns the text, the tokens and the cost', async () => {
      fetchMock.mockImplementation(async () =>
        chatResponse(answer('the answer', 1000, 500)),
      );

      const response = await adapter().ask({ snapshot: 'S', instruction: 'I' });

      expect(response).toEqual({
        text: 'the answer',
        // 1000 in at $0.20/M plus 500 out at $1.20/M.
        costUsd: 0.0008,
        tokensInput: 1000,
        tokensOutput: 500,
      });
    });

    it('reports costUsd null for a model the price table has no rate for', async () => {
      // The one that protects metric 5, restated for the second vendor. An
      // unknown model must not be priced at zero and must not be guessed at
      // from a neighbour — unknown and free are different facts (VISION §6) —
      // and the tokens are still reported, so the call is visibly measured but
      // unpriced.
      fetchMock.mockImplementation(async () =>
        chatResponse(answer('the answer', 1000, 500)),
      );

      const response = await adapter({
        'supervisor.model.name': 'gpt-model-invented-tomorrow',
      }).ask({ snapshot: 'S', instruction: 'I' });

      expect(response.costUsd).toBeNull();
      expect(response.costUsd).not.toBe(0);
      expect(response.tokensInput).toBe(1000);
      expect(response.tokensOutput).toBe(500);
    });

    it('reports null tokens and null cost when usage is missing', async () => {
      fetchMock.mockImplementation(async () =>
        chatResponse({
          choices: [{ message: { content: 'hi' } }],
        }),
      );

      const response = await adapter().ask({ snapshot: 'S', instruction: 'I' });

      expect(response.tokensInput).toBeNull();
      expect(response.tokensOutput).toBeNull();
      expect(response.costUsd).toBeNull();
    });

    it('reads the first choice and does not concatenate several', async () => {
      // `n` is never sent, so there is one choice; reading past it would be
      // reading something this adapter did not ask for.
      fetchMock.mockImplementation(async () =>
        chatResponse({
          choices: [
            { index: 0, message: { content: 'first' } },
            { index: 1, message: { content: 'second' } },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      );

      const response = await adapter().ask({ snapshot: 'S', instruction: 'I' });

      expect(response.text).toBe('first');
    });
  });

  describe('failure', () => {
    it('throws with the status and the API message when the call is rejected', async () => {
      fetchMock.mockImplementation(async () =>
        chatResponse(
          {
            error: {
              message: 'Incorrect API key provided',
              code: 'invalid_api_key',
            },
          },
          401,
        ),
      );

      await expect(
        adapter().ask({ snapshot: 'S', instruction: 'I' }),
      ).rejects.toThrow(SupervisorModelError);

      await expect(
        adapter().ask({ snapshot: 'S', instruction: 'I' }),
      ).rejects.toMatchObject({
        // 401 rather than "request failed": the difference between a
        // credential to fix and an outage to wait out.
        status: 401,
        message: expect.stringContaining('Incorrect API key provided'),
      });
    });

    it('never answers empty text in place of an error', async () => {
      // An empty answer would be recorded as a supervisor that ran and had
      // nothing to say, which is a lie the approval rate would average over.
      fetchMock.mockImplementation(async () =>
        chatResponse({ error: { message: 'server had an error' } }, 500),
      );

      await expect(
        adapter().ask({ snapshot: 'S', instruction: 'I' }),
      ).rejects.toThrow(/500/);
    });

    it('throws rather than answering empty when the model refuses', async () => {
      // A refusal sets `content` to null and puts the reason in `refusal`.
      // Returning '' would record a supervisor that looked and declined, which
      // #90 says must mean something else entirely.
      fetchMock.mockImplementation(async () =>
        chatResponse({
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: { content: null, refusal: 'I cannot help with that.' },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      );

      await expect(
        adapter().ask({ snapshot: 'S', instruction: 'I' }),
      ).rejects.toThrow(/refused to answer: I cannot help with that\./);
    });

    it('does not retry', async () => {
      // Exactly one fetch per ask(). The next scheduled tick is the retry, so
      // a loop here would only spend a second call on the same outage.
      fetchMock.mockImplementation(async () =>
        chatResponse({ error: { message: 'boom' } }, 500),
      );

      await expect(
        adapter().ask({ snapshot: 'S', instruction: 'I' }),
      ).rejects.toThrow();

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('aborts when the model does not answer in time', async () => {
      // A real AbortSignal.timeout, not a faked clock: the timeout is the only
      // thing that ends a call that never returns, which is why there is no
      // watchdog around this adapter.
      fetchMock.mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              reject((init.signal as AbortSignal).reason);
            });
          }),
      );

      // One second, the registry's floor for this key rather than an
      // arbitrarily small number: going under the floor would mean asserting
      // against a value production can never hold.
      const started = Date.now();
      await expect(
        adapter({ 'supervisor.model.timeoutMs': 1_000 }).ask({
          snapshot: 'S',
          instruction: 'I',
        }),
      ).rejects.toThrow(/did not answer within 1000ms/);

      expect(Date.now() - started).toBeLessThan(5000);
      expect(callInit().signal).toBeInstanceOf(AbortSignal);
    });

    it('reports a network failure as such', async () => {
      fetchMock.mockImplementation(async () => {
        throw new TypeError('fetch failed');
      });

      await expect(
        adapter().ask({ snapshot: 'S', instruction: 'I' }),
      ).rejects.toThrow(/could not be reached: fetch failed/);
    });

    it('throws when the body is not a completion', async () => {
      fetchMock.mockImplementation(
        async () => new Response('<html>gateway</html>', { status: 200 }),
      );

      await expect(
        adapter().ask({ snapshot: 'S', instruction: 'I' }),
      ).rejects.toThrow(SupervisorModelError);
    });

    it('throws when the completion has no choices', async () => {
      fetchMock.mockImplementation(async () =>
        chatResponse({ usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      );

      await expect(
        adapter().ask({ snapshot: 'S', instruction: 'I' }),
      ).rejects.toThrow(/no choices/);
    });

    it('refuses, naming the setting to change, when there is no API key', async () => {
      // The same refusal the other adapter gives, per call, naming the setting
      // rather than telling whoever reads the log to bind a provider (#344).
      const model = adapter({ 'models.openai.apiKey': '' });

      await expect(
        model.ask({ snapshot: 'S', instruction: 'I' }),
      ).rejects.toThrow(SupervisorModelError);
      await expect(
        model.ask({ snapshot: 'S', instruction: 'I' }),
      ).rejects.toThrow(/models\.openai\.apiKey/);
      expect(model.name).toBe('none');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('refuses to ask anything when no model is named', async () => {
      // #392's last acceptance criterion, on this provider: a key with no
      // SUPERVISOR_MODEL_NAME beside it is half-configured, and it says so once
      // an invocation rather than falling back to a default nobody chose.
      const model = adapter({ 'supervisor.model.name': '' });

      await expect(
        model.ask({ snapshot: 'S', instruction: 'I' }),
      ).rejects.toThrow(/SUPERVISOR_MODEL_NAME is not/);
      expect(model.name).toBe('unconfigured');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});

describe('provider selection (#392)', () => {
  it('routes to the provider that is set, per call and not per process', async () => {
    // The whole of the "resolved per call" criterion. One object, one process,
    // no reconstruction: an operator switches provider between two ticks and
    // the second tick goes somewhere else.
    // Answers in the shape of whichever API was actually called — which is
    // itself part of the assertion: a router that sent an Anthropic request to
    // OpenAI's path, or the reverse, would fail here on the response reading
    // rather than pass with a body neither vendor would return.
    fetchMock.mockImplementation(async (url: string) =>
      String(url).endsWith('/v1/messages')
        ? new Response(
            JSON.stringify({
              content: [{ type: 'text', text: 'hi' }],
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        : chatResponse(answer('hi')),
    );
    // Two DIFFERENT credentials, held at the same time (#422). Distinct
    // values rather than one shared `sk-either`, because with one key both
    // arms would pass on a router that ignored the credential split entirely
    // — the switch has to select the OTHER stored key, not merely the other
    // host.
    const settings = makeOperatorSettings({
      overrides: {
        'models.anthropic.apiKey': 'sk-ant-held',
        'models.openai.apiKey': 'sk-openai-held',
        'supervisor.model.name': MODEL,
      },
    });
    const model = createSupervisorModel(settings);

    await model.ask({ snapshot: 'S', instruction: 'I' });
    // Default provider, default base URL: Anthropic's Messages API.
    expect(fetchMock.mock.calls[0][0]).toBe(
      `${PROVIDER_BASE_URLS.anthropic}/v1/messages`,
    );
    expect(callInit(0).headers).toMatchObject({ 'x-api-key': 'sk-ant-held' });

    settings.setOverride('supervisor.model.provider', 'openai');
    await model.ask({ snapshot: 'S', instruction: 'I' });

    expect(fetchMock.mock.calls[1][0]).toBe(
      `${PROVIDER_BASE_URLS.openai}/v1/chat/completions`,
    );
    expect(callInit(1).headers).toMatchObject({
      authorization: 'Bearer sk-openai-held',
    });

    // And neither key was consumed by the switch: going back reaches the
    // first credential again, with nothing re-entered in between.
    settings.setOverride('supervisor.model.provider', 'anthropic');
    await model.ask({ snapshot: 'S', instruction: 'I' });
    expect(callInit(2).headers).toMatchObject({ 'x-api-key': 'sk-ant-held' });
  });

  it('reaches the right host when the operator switches provider and forgets the URL', async () => {
    // #392's second acceptance criterion, stated against the state a real
    // deployment is in: SUPERVISOR_MODEL_BASE_URL was set explicitly from
    // `.env.example`, and the operator changes the provider and nothing else.
    fetchMock.mockImplementation(async () => chatResponse(answer('hi')));
    const model = createSupervisorModel(
      makeOperatorSettings({
        overrides: {
          'supervisor.model.provider': 'openai',
          'models.openai.apiKey': 'sk-openai',
          'supervisor.model.name': MODEL,
          'models.openai.baseUrl': PROVIDER_BASE_URLS.anthropic,
        },
      }),
    );

    await model.ask({ snapshot: 'S', instruction: 'I' });

    expect(fetchMock.mock.calls[0][0]).toBe(
      `${PROVIDER_BASE_URLS.openai}/v1/chat/completions`,
    );
  });

  it('does not fall back to the other provider when a call fails', async () => {
    // Deliberately not a fallback. Trying the other vendor would spend a
    // second credential on the same tick and record a `model` the operator did
    // not ask for, which is exactly the claim #89 wants the log to settle.
    fetchMock.mockImplementation(async () =>
      chatResponse({ error: { message: 'nope' } }, 401),
    );

    await expect(
      adapter().ask({ snapshot: 'S', instruction: 'I' }),
    ).rejects.toThrow(/401/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports a key that names no model as such on BOTH providers', async () => {
    // #392's last acceptance criterion, stated where it can actually fail: the
    // two adapters answer from the same `reportedModelName`, so a provider
    // switch must not change what an unconfigured supervisor's decision-log
    // row says. If either adapter grew its own opinion, this is where the two
    // would stop agreeing.
    const settings = operatorSettings({ 'supervisor.model.name': '' });
    const model = createSupervisorModel(settings);

    for (const provider of ['anthropic', 'openai'] as const) {
      const slot = modelApiKeySettingKey(provider);
      settings.setOverride('supervisor.model.provider', provider);
      settings.setOverride(slot, 'sk-either');

      expect(model.name).toBe('unconfigured');
      await expect(
        model.ask({ snapshot: 'S', instruction: 'I' }),
      ).rejects.toThrow(/SUPERVISOR_MODEL_NAME is not/);

      settings.setOverride(slot, '');
      expect(model.name).toBe('none');
      settings.setOverride(slot, 'sk-either');
    }

    // Nothing was billed on either provider, which is the other half of it.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is the object both adapter classes sit behind', () => {
    // The router holds one of each and picks by lookup rather than by
    // construction. Built lazily from the boot-time setting, the stale copy
    // #344 removed would be back — and `routes to the provider that is set`
    // above is what would catch that, so this only pins the two classes as the
    // things being routed BETWEEN.
    const bothAdapters = [
      new AnthropicSupervisorModel(operatorSettings()),
      new OpenAiSupervisorModel(operatorSettings()),
    ];

    expect(bothAdapters.map((each) => each.name)).toEqual([MODEL, MODEL]);
  });
});
