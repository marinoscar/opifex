import type { FactoryProvider } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import type { OperatorSettingsOverrides } from '../../settings/operator-settings/operator-settings.registry';
import { OperatorSettingsService } from '../../settings/operator-settings/operator-settings.service';
import { makeOperatorSettings } from '../../settings/operator-settings/operator-settings.test-double';
import { DecisionLogService } from '../decision-log/decision-log.service';
import type { InvocationDraft } from '../decision-log/decision-log.types';
import { SnapshotService } from '../snapshot/snapshot.service';
import type { SnapshotInput } from '../snapshot/snapshot.types';
import { SupervisorModule } from '../supervisor.module';
import { AnthropicSupervisorModel } from './anthropic-supervisor-model';
import { SupervisorModelError } from './supervisor-model.config';
import {
  ProviderRoutingSupervisorModel,
  createSupervisorModel,
} from './supervisor-model.factory';
import {
  SUPERVISOR_MODEL,
  UnavailableSupervisorModel,
  type SupervisorModel,
} from './supervisor-model.port';
import {
  SUPERVISOR_PROPOSERS,
  type SupervisorProposer,
} from './supervisor-proposer.port';
import { SupervisorService } from './supervisor.service';
import { SupervisorSpendCeilingService } from './supervisor-spend-ceiling';
import { SupervisorSpendLedgerService } from './supervisor-spend-ledger.service';

/**
 * The supervisor's model adapter (ADR-0015, #230).
 *
 * `fetch` is stubbed throughout. Nothing in this file may reach the network:
 * a suite that can only pass with a credential is a suite that does not run in
 * CI, and an adapter whose error mapping is only exercised against the real
 * API is an adapter whose error mapping is never exercised at all.
 */

const MODEL = 'claude-haiku-4-5';

const SETTINGS: OperatorSettingsOverrides = {
  'supervisor.model.apiKey': 'sk-ant-test',
  'supervisor.model.name': MODEL,
  'supervisor.model.baseUrl': 'https://api.anthropic.test',
  'supervisor.model.timeoutMs': 5000,
  'supervisor.model.defaultMaxTokens': 1024,
};

function operatorSettings(overrides: OperatorSettingsOverrides = {}) {
  return makeOperatorSettings({ overrides: { ...SETTINGS, ...overrides } });
}

/**
 * The adapter as production builds it — through the factory, so every
 * assertion below is about the object `SupervisorModule` actually binds.
 *
 * With `supervisor.model.provider` at its default the router selects the
 * Anthropic adapter, which is what makes this suite still a suite about that
 * adapter after #392 put a router in front of it.
 */
function adapter(overrides: OperatorSettingsOverrides = {}) {
  return createSupervisorModel(operatorSettings(overrides));
}

/** The Anthropic adapter alone, with no router in the way. */
function bareAdapter(overrides: OperatorSettingsOverrides = {}) {
  return new AnthropicSupervisorModel(operatorSettings(overrides));
}

/**
 * A Messages API response.
 *
 * Built fresh per call rather than shared, because a `Response` body can only
 * be read once and the second read fails several frames from the cause.
 */
function messageResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function answer(text: string, inputTokens = 1000, outputTokens = 500): unknown {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: MODEL,
    content: [{ type: 'text', text }],
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
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

describe('AnthropicSupervisorModel (ADR-0015)', () => {
  describe('the request', () => {
    it('posts one message to the Messages API with the version header', async () => {
      fetchMock.mockImplementation(async () => messageResponse(answer('hi')));

      await adapter().ask({ snapshot: 'STATE', instruction: 'ASK' });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://api.anthropic.test/v1/messages',
      );

      const init = callInit();
      expect(init.method).toBe('POST');
      expect(init.headers).toMatchObject({
        'x-api-key': 'sk-ant-test',
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      });
    });

    it('sends the snapshot and the instruction as one user turn', async () => {
      fetchMock.mockImplementation(async () => messageResponse(answer('hi')));

      await adapter().ask({ snapshot: 'STATE', instruction: 'ASK' });

      expect(sentBody()).toMatchObject({
        model: MODEL,
        messages: [{ role: 'user', content: 'STATE\n\nASK' }],
      });
    });

    it('sends no tools, ever', async () => {
      // #90: execution must be structurally impossible, not merely
      // unimplemented. A tool definition on this request would make the
      // supervisor an executor with extra steps.
      fetchMock.mockImplementation(async () => messageResponse(answer('hi')));

      await adapter().ask({ snapshot: 'STATE', instruction: 'ASK' });

      expect(sentBody()).not.toHaveProperty('tools');
      expect(sentBody()).not.toHaveProperty('tool_choice');
    });

    it('sends the model name verbatim, whatever it is', async () => {
      // Sent as configured, not normalised or validated against a list: the
      // string in the log has to be the string that was actually sent.
      fetchMock.mockImplementation(async () => messageResponse(answer('hi')));
      const model = adapter({ 'supervisor.model.name': 'some-future-model' });

      await model.ask({ snapshot: 'S', instruction: 'I' });

      expect(sentBody().model).toBe('some-future-model');
      expect(model.name).toBe('some-future-model');
    });

    it('uses the configured default when a proposer sets no ceiling', async () => {
      fetchMock.mockImplementation(async () => messageResponse(answer('hi')));

      await adapter({ 'supervisor.model.defaultMaxTokens': 777 }).ask({
        snapshot: 'S',
        instruction: 'I',
      });

      expect(sentBody().max_tokens).toBe(777);
    });

    it("honours a proposer's own ceiling", async () => {
      // One proposer must not be able to spend the whole invocation.
      fetchMock.mockImplementation(async () => messageResponse(answer('hi')));

      await adapter().ask({
        snapshot: 'S',
        instruction: 'I',
        maxOutputTokens: 400,
      });

      expect(sentBody().max_tokens).toBe(400);
    });

    it('does not double the slash when the base URL ends in one', async () => {
      fetchMock.mockImplementation(async () => messageResponse(answer('hi')));

      await adapter({
        'supervisor.model.baseUrl': 'https://api.anthropic.test/',
      }).ask({ snapshot: 'S', instruction: 'I' });

      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://api.anthropic.test/v1/messages',
      );
    });
  });

  describe('the response', () => {
    it('returns the text, the tokens and the cost', async () => {
      fetchMock.mockImplementation(async () =>
        messageResponse(answer('the answer', 1000, 500)),
      );

      const response = await adapter().ask({ snapshot: 'S', instruction: 'I' });

      expect(response).toEqual({
        text: 'the answer',
        // 1000 in at $1/M plus 500 out at $5/M.
        costUsd: 0.0035,
        tokensInput: 1000,
        tokensOutput: 500,
      });
    });

    it('concatenates the text blocks and ignores the rest', async () => {
      fetchMock.mockImplementation(async () =>
        messageResponse({
          content: [
            { type: 'text', text: 'first' },
            { type: 'thinking', thinking: 'not an answer' },
            { type: 'text', text: ' second' },
          ],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );

      const response = await adapter().ask({ snapshot: 'S', instruction: 'I' });

      expect(response.text).toBe('first second');
    });

    it('reports costUsd null for a model the price table has no rate for', async () => {
      // The one that protects metric 5. An unknown model must not be priced at
      // zero and must not be guessed at from a neighbour — unknown and free
      // are different facts (VISION §6), and the tokens are still reported so
      // the call is visibly measured but unpriced.
      fetchMock.mockImplementation(async () =>
        messageResponse(answer('the answer', 1000, 500)),
      );

      const response = await adapter({
        'supervisor.model.name': 'claude-model-invented-tomorrow',
      }).ask({ snapshot: 'S', instruction: 'I' });

      expect(response.costUsd).toBeNull();
      expect(response.costUsd).not.toBe(0);
      expect(response.tokensInput).toBe(1000);
      expect(response.tokensOutput).toBe(500);
    });

    it('reports null tokens and null cost when usage is missing', async () => {
      fetchMock.mockImplementation(async () =>
        messageResponse({ content: [{ type: 'text', text: 'hi' }] }),
      );

      const response = await adapter().ask({ snapshot: 'S', instruction: 'I' });

      expect(response.tokensInput).toBeNull();
      expect(response.tokensOutput).toBeNull();
      expect(response.costUsd).toBeNull();
    });
  });

  describe('failure', () => {
    it('throws with the status and the API message when the call is rejected', async () => {
      fetchMock.mockImplementation(async () =>
        messageResponse(
          { type: 'error', error: { message: 'invalid x-api-key' } },
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
        message: expect.stringContaining('invalid x-api-key'),
      });
    });

    it('never answers empty text in place of an error', async () => {
      // An empty answer would be recorded as a supervisor that ran and had
      // nothing to say, which is a lie the approval rate would average over.
      fetchMock.mockImplementation(async () =>
        messageResponse({ error: { message: 'overloaded' } }, 529),
      );

      await expect(
        adapter().ask({ snapshot: 'S', instruction: 'I' }),
      ).rejects.toThrow(/529/);
    });

    it('does not retry', async () => {
      // ADR-0015: exactly one fetch per ask(). The next scheduled tick is the
      // retry, so a loop here would only spend a second call on the same
      // outage.
      fetchMock.mockImplementation(async () =>
        messageResponse({ error: { message: 'boom' } }, 500),
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

      // One second, which is the registry's floor for this key rather than an
      // arbitrarily small number. A second of real waiting is the honest price
      // of exercising a real `AbortSignal.timeout`; going under the floor
      // would mean asserting against a value production can never hold.
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

    it('throws when the body is not a message', async () => {
      fetchMock.mockImplementation(
        async () => new Response('<html>gateway</html>', { status: 200 }),
      );

      await expect(
        adapter().ask({ snapshot: 'S', instruction: 'I' }),
      ).rejects.toThrow(SupervisorModelError);
    });

    it('throws when the message has no content array', async () => {
      fetchMock.mockImplementation(async () =>
        messageResponse({ usage: { input_tokens: 1, output_tokens: 1 } }),
      );

      await expect(
        adapter().ask({ snapshot: 'S', instruction: 'I' }),
      ).rejects.toThrow(/no content array/);
    });

    it('refuses, naming the setting to change, when there is no API key', async () => {
      // #344. This refusal used to be a missing DI binding; it is per call
      // now, and what an operator reads has to be actionable rather than an
      // instruction to bind a provider.
      const model = adapter({ 'supervisor.model.apiKey': '' });

      await expect(
        model.ask({ snapshot: 'S', instruction: 'I' }),
      ).rejects.toThrow(SupervisorModelError);
      await expect(
        model.ask({ snapshot: 'S', instruction: 'I' }),
      ).rejects.toThrow(/SUPERVISOR_MODEL_API_KEY/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('refuses to ask anything when no model is named', async () => {
      // A key with no SUPERVISOR_MODEL_NAME beside it is half-configured, and
      // it says so once an invocation rather than falling back to the
      // refusing default, which would make a typo indistinguishable from a
      // deliberate decision not to run a supervisor.
      // Empty, not absent: empty IS the registry's default for this key, so
      // it is what a deployment with a key and no model name resolves to.
      const model = adapter({ 'supervisor.model.name': '' });

      await expect(
        model.ask({ snapshot: 'S', instruction: 'I' }),
      ).rejects.toThrow(/SUPERVISOR_MODEL_NAME is not/);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});

describe('createSupervisorModel (ADR-0015, #344, #392)', () => {
  it('builds the adapter when an API key is configured', () => {
    const model = createSupervisorModel(operatorSettings());

    expect(model).toBeInstanceOf(ProviderRoutingSupervisorModel);
    expect(model.name).toBe(MODEL);
  });

  it('builds the adapter when the API key is unset', () => {
    // The whole of #344. An adapter that is not built cannot be built later,
    // so a key set at runtime would reach a process that had already decided
    // there was no model.
    expect(
      createSupervisorModel(
        operatorSettings({ 'supervisor.model.apiKey': '' }),
      ),
    ).toBeInstanceOf(ProviderRoutingSupervisorModel);
  });

  it('does not throw when nothing at all is configured', () => {
    // A missing key must never stop the API booting. No overrides and a
    // hermetic environment, so this is the registry's own defaults.
    const empty = makeOperatorSettings();
    expect(() => createSupervisorModel(empty)).not.toThrow();
    expect(createSupervisorModel(empty)).toBeInstanceOf(
      ProviderRoutingSupervisorModel,
    );
  });

  it('reports the same three names whether or not the router is in the way', () => {
    // The router delegates `name` rather than resolving it itself, so that the
    // decision log's `model` column comes from the object that made the call.
    // If it ever stopped delegating, these would drift apart silently.
    expect(adapter().name).toBe(bareAdapter().name);
    expect(adapter({ 'supervisor.model.name': '' }).name).toBe(
      bareAdapter({ 'supervisor.model.name': '' }).name,
    );
    expect(adapter({ 'supervisor.model.apiKey': '' }).name).toBe(
      bareAdapter({ 'supervisor.model.apiKey': '' }).name,
    );
  });

  it('reports the same name as UnavailableSupervisorModel when there is no key', () => {
    // Not a coincidence to be asserted loosely: the decision-log `model`
    // column for an unconfigured supervisor has to read after #344 exactly
    // what it read when no adapter was bound at all. If either string moves,
    // this is where the two stop agreeing.
    expect(adapter({ 'supervisor.model.apiKey': '' }).name).toBe(
      new UnavailableSupervisorModel().name,
    );
    expect(adapter({ 'supervisor.model.apiKey': '' }).name).toBe('none');
  });

  it("reports 'unconfigured' for a key that names no model, and the name otherwise", () => {
    // Three states, kept apart: no key at all, a key with no model beside it,
    // and a working configuration. ADR-0015's argument is that a typo in a
    // model name must not read like a decision not to run a supervisor.
    expect(adapter({ 'supervisor.model.name': '' }).name).toBe('unconfigured');
    expect(adapter().name).toBe(MODEL);
  });
});

describe('per-call configuration (#344)', () => {
  it('picks up a key supplied after the adapter was built', async () => {
    // The failure #344 exists to close, at the adapter's own level: the same
    // object refuses, then calls, with no reconstruction in between.
    const settings = operatorSettings({ 'supervisor.model.apiKey': '' });
    const model = createSupervisorModel(settings);

    await expect(
      model.ask({ snapshot: 'S', instruction: 'I' }),
    ).rejects.toThrow(/SUPERVISOR_MODEL_API_KEY/);
    expect(model.name).toBe('none');

    fetchMock.mockImplementation(async () => messageResponse(answer('hi')));
    settings.setOverride('supervisor.model.apiKey', 'sk-ant-set-later');

    await expect(
      model.ask({ snapshot: 'S', instruction: 'I' }),
    ).resolves.toMatchObject({ text: 'hi' });
    expect(model.name).toBe(MODEL);
    expect(callInit().headers).toMatchObject({
      'x-api-key': 'sk-ant-set-later',
    });
  });

  it('stops calling when the key is removed again', async () => {
    fetchMock.mockImplementation(async () => messageResponse(answer('hi')));
    const settings = operatorSettings();
    const model = createSupervisorModel(settings);

    await model.ask({ snapshot: 'S', instruction: 'I' });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    settings.setOverride('supervisor.model.apiKey', '');

    await expect(
      model.ask({ snapshot: 'S', instruction: 'I' }),
    ).rejects.toThrow(/SUPERVISOR_MODEL_API_KEY/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('resolves the model name, base URL and token ceiling per call, not once', async () => {
    fetchMock.mockImplementation(async () => messageResponse(answer('hi')));
    const settings = operatorSettings();
    const model = createSupervisorModel(settings);

    await model.ask({ snapshot: 'S', instruction: 'I' });

    settings.setOverride('supervisor.model.name', 'claude-sonnet-4-5');
    settings.setOverride('supervisor.model.baseUrl', 'https://proxy.test');
    settings.setOverride('supervisor.model.defaultMaxTokens', 99);

    await model.ask({ snapshot: 'S', instruction: 'I' });

    expect(sentBody(0)).toMatchObject({ model: MODEL, max_tokens: 1024 });
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.anthropic.test/v1/messages',
    );
    expect(sentBody(1)).toMatchObject({
      model: 'claude-sonnet-4-5',
      max_tokens: 99,
    });
    expect(fetchMock.mock.calls[1][0]).toBe('https://proxy.test/v1/messages');
    // Reported from the same read that was sent, so the decision log cannot
    // name a model other than the one that answered.
    expect(model.name).toBe('claude-sonnet-4-5');
  });
});

// ---------------------------------------------------------------------------
// The module wiring
// ---------------------------------------------------------------------------

const NOW = new Date('2026-08-25T12:00:00.000Z');

function snapshotState(): SnapshotInput {
  return {
    generatedAt: NOW,
    windowDays: 1,
    totals: {
      runsRunning: 0,
      runsStalled: 0,
      runsBlocked: 0,
      runsSucceededInWindow: 0,
      runsFailedInWindow: 0,
      workOrdersQueued: 0,
      workOrdersHeld: 0,
      workOrdersQuarantined: 0,
      escalationsOutstanding: 0,
    },
    attentionRuns: [],
    recentRuns: [],
    queuedWorkOrders: [],
    quarantinedWorkOrders: [],
    escalations: [],
    specRejections: [],
  };
}

/** A proposer that does nothing but ask, so the model is actually exercised. */
const askingProposer: SupervisorProposer = {
  actionClass: 'run-diagnosis',
  name: 'asking-proposer',
  async propose(context) {
    const response = await context.model.ask({
      snapshot: context.snapshot,
      instruction: 'why?',
      maxOutputTokens: 400,
    });
    return [
      {
        actionClass: 'run-diagnosis',
        outcome: 'proposed',
        summary: response.text,
        reasoning: response.text,
        targetKind: 'factory',
      },
    ];
  },
};

/**
 * The REAL provider object off `SupervisorModule`'s metadata.
 *
 * Taken from the module rather than restated here, so this suite cannot pass
 * against a copy of the wiring while the module itself binds something else.
 */
function supervisorModelProvider() {
  const providers = Reflect.getMetadata('providers', SupervisorModule) as
    unknown[] | undefined;
  const found = (providers ?? []).find(
    (provider) =>
      provider !== null &&
      typeof provider === 'object' &&
      (provider as { provide?: unknown }).provide === SUPERVISOR_MODEL,
  );
  if (found === undefined) {
    throw new Error('SupervisorModule binds no SUPERVISOR_MODEL provider');
  }
  return found as FactoryProvider<ReturnType<typeof createSupervisorModel>>;
}

async function buildSupervisor(overrides: OperatorSettingsOverrides) {
  const record = jest
    .fn()
    .mockResolvedValue({ invocationId: 'inv-1', proposalIds: [] });
  const settings = operatorSettings(overrides);

  const moduleRef = await Test.createTestingModule({
    providers: [
      {
        provide: OperatorSettingsService,
        useValue: settings,
      },
      {
        provide: SnapshotService,
        useValue: { collect: jest.fn().mockResolvedValue(snapshotState()) },
      },
      { provide: DecisionLogService, useValue: { record } },
      // A ceiling with room, and a window with nothing in it. Since ADR-0017
      // a tick refuses before it reaches the model unless both are present,
      // and this suite is about which model it reaches — not about the
      // ceiling, which has its own tests.
      {
        provide: SupervisorSpendCeilingService,
        useValue: { value: { limitUsd: 5, windowDays: 1, malformed: null } },
      },
      {
        provide: SupervisorSpendLedgerService,
        useValue: {
          tally: jest.fn().mockResolvedValue({
            reportedUsd: 0,
            unpricedCalls: 0,
            invocations: 0,
            window: { from: new Date(), to: new Date(), days: 1 },
          }),
        },
      },
      { provide: SUPERVISOR_PROPOSERS, useValue: [askingProposer] },
      supervisorModelProvider(),
      SupervisorService,
    ],
  }).compile();

  return {
    service: moduleRef.get(SupervisorService),
    bound: moduleRef.get<SupervisorModel>(SUPERVISOR_MODEL, { strict: false }),
    settings,
    record,
    recorded: (index = 0) => record.mock.calls[index][0] as InvocationDraft,
  };
}

describe('SupervisorModule binding (ADR-0015)', () => {
  it('binds SUPERVISOR_MODEL through the factory', () => {
    const provider = supervisorModelProvider();

    expect(provider.useFactory).toBe(createSupervisorModel);
    expect(provider.inject).toEqual([OperatorSettingsService]);
  });

  it('hands SupervisorService the adapter when a key is configured', async () => {
    fetchMock.mockImplementation(async () =>
      messageResponse(answer('because the runner died', 1000, 500)),
    );

    const { service, bound, recorded } = await buildSupervisor({
      'supervisor.enabled': true,
    });

    expect(bound).toBeInstanceOf(ProviderRoutingSupervisorModel);
    await service.invoke(NOW);

    const draft = recorded();
    expect(draft.outcome).toBe('completed');
    // The exact string that was sent, so "runs on a small model" is checkable
    // against the log rather than against the config file.
    expect(draft.model).toBe(MODEL);
    expect(draft.costUsd).toBe(0.0035);
    expect(draft.tokensInput).toBe(1000);
    expect(draft.tokensOutput).toBe(500);
  });

  it('records the same refusal it always did when no key is configured', async () => {
    const { service, bound, recorded } = await buildSupervisor({
      'supervisor.enabled': true,
      'supervisor.model.apiKey': '',
    });

    // #344: the adapter IS in the graph now — that is the change — and the row
    // it produces is the one an unconfigured deployment produced before, when
    // @Optional() saw undefined and `?? new UnavailableSupervisorModel()` won.
    expect(bound).toBeInstanceOf(ProviderRoutingSupervisorModel);

    await service.invoke(NOW);

    const draft = recorded();
    // The refusal is RECORDED, not swallowed: a supervisor that appears to be
    // running and is not is the failure the decision log exists to prevent.
    expect(draft.model).toBe('none');
    expect(draft.outcome).toBe('partial');
    expect(draft.failureReason).not.toBeNull();
    expect(draft.costUsd).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reaches the adapter on the next invocation after a key is set at runtime', async () => {
    // The acceptance criterion #344 is actually for: no restart, no second
    // module, no new SupervisorService. One process, one adapter, one operator
    // typing a key into the Control Center between two ticks.
    const { service, settings, record, recorded } = await buildSupervisor({
      'supervisor.enabled': true,
      'supervisor.model.apiKey': '',
    });

    await service.invoke(NOW);
    expect(recorded(0).model).toBe('none');
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockImplementation(async () =>
      messageResponse(answer('because the runner died', 1000, 500)),
    );
    settings.setOverride('supervisor.model.apiKey', 'sk-ant-set-in-the-ui');

    await service.invoke(NOW);

    expect(record).toHaveBeenCalledTimes(2);
    const draft = recorded(1);
    expect(draft.outcome).toBe('completed');
    expect(draft.model).toBe(MODEL);
    expect(draft.costUsd).toBe(0.0035);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(callInit().headers).toMatchObject({
      'x-api-key': 'sk-ant-set-in-the-ui',
    });
  });

  it('records a rejected API call as a failure rather than letting it escape', async () => {
    fetchMock.mockImplementation(async () =>
      messageResponse({ error: { message: 'invalid x-api-key' } }, 401),
    );

    const { service, recorded } = await buildSupervisor({
      'supervisor.enabled': true,
    });

    // invoke() never throws. The proposer's failure is recorded and the
    // invocation still writes a row, because a gap in the log is
    // indistinguishable from a tick that silently failed.
    await expect(service.invoke(NOW)).resolves.toBe('inv-1');

    const draft = recorded();
    expect(draft.outcome).toBe('partial');
    expect(draft.model).toBe(MODEL);
    // Nothing was billed for an answer that never arrived.
    expect(draft.costUsd).toBeNull();
  });
});
