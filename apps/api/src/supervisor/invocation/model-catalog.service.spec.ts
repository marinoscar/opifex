import { Logger } from '@nestjs/common';

import type { OperatorSettingsOverrides } from '../../settings/operator-settings/operator-settings.registry';
import { makeOperatorSettings } from '../../settings/operator-settings/operator-settings.test-double';
import {
  SupervisorModelCatalogService,
  providerOfKeyShape,
  type CatalogModel,
} from './model-catalog.service';

/**
 * The model catalogue endpoint's service half (#393, epic #391).
 *
 * `fetch` is stubbed throughout, for the reason the adapter suites give: a
 * suite that can only pass with a real credential is a suite that does not run
 * in CI, and error mapping exercised only against the live API is error
 * mapping that is never exercised at all.
 *
 * Two groups of case carry the issue's actual requirements:
 *
 * - **"an unparseable id is returned marked, and a test asserts it is not
 *   filtered out"** — `the three states` below. This is the one that would
 *   pass vacuously if the fixture happened to contain only ids that parse, so
 *   the fixture deliberately contains ids that do not.
 * - **failure told apart** — an invalid key, an unreachable host and a key for
 *   the OTHER provider are three findings with three remedies, and the third
 *   is the one that would otherwise be reported as the first.
 */

const ANTHROPIC_SETTINGS: OperatorSettingsOverrides = {
  'supervisor.model.provider': 'anthropic',
  'models.anthropic.apiKey': 'sk-ant-test-key',
  'models.anthropic.baseUrl': 'https://api.anthropic.test',
  'supervisor.model.timeoutMs': 5000,
};

const OPENAI_SETTINGS: OperatorSettingsOverrides = {
  'supervisor.model.provider': 'openai',
  'models.openai.apiKey': 'sk-proj-test-key',
  'models.openai.baseUrl': 'https://api.openai.test',
  'supervisor.model.timeoutMs': 5000,
};

/** A catalogue service whose clock does not move, so `checkedAt` is assertable. */
class FrozenCatalog extends SupervisorModelCatalogService {
  protected override now(): number {
    return Date.parse('2026-08-27T10:00:00.000Z');
  }
}

function catalog(overrides: OperatorSettingsOverrides): FrozenCatalog {
  return new FrozenCatalog(makeOperatorSettings({ overrides }));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Anthropic's `/v1/models` shape: ISO `created_at`, and a `display_name`. */
function anthropicList(...ids: string[]): unknown {
  return {
    data: ids.map((id) => ({
      type: 'model',
      id,
      display_name: `Display ${id}`,
      created_at: '2026-02-19T00:00:00Z',
    })),
    has_more: false,
  };
}

/** OpenAI's `/v1/models` shape: Unix-seconds `created`, and no label. */
function openAiList(...ids: string[]): unknown {
  return {
    object: 'list',
    data: ids.map((id) => ({
      id,
      object: 'model',
      created: 1771459200,
      owned_by: 'system',
    })),
  };
}

let fetchMock: jest.Mock;
const realFetch = global.fetch;

beforeEach(() => {
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  global.fetch = realFetch;
  jest.restoreAllMocks();
});

function requestInit(index = 0): RequestInit {
  return fetchMock.mock.calls[index][1] as RequestInit;
}

function byId(models: readonly CatalogModel[], id: string): CatalogModel {
  const found = models.find((model) => model.id === id);
  if (!found) throw new Error(`${id} is not in the catalogue`);
  return found;
}

describe('SupervisorModelCatalogService (#393)', () => {
  describe('the request it makes', () => {
    it("asks Anthropic's catalogue with Anthropic's headers", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(anthropicList('claude-opus-4-6')),
      );

      await catalog(ANTHROPIC_SETTINGS).list('supervisor');

      expect(fetchMock).toHaveBeenCalledTimes(1);
      // `limit`, because the default page size is 20 and a truncated
      // catalogue would silently hide the newest model on a busy account.
      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://api.anthropic.test/v1/models?limit=1000',
      );
      expect(requestInit().headers).toMatchObject({
        'x-api-key': 'sk-ant-test-key',
        'anthropic-version': '2023-06-01',
      });
      expect(requestInit().headers).not.toHaveProperty('authorization');
      expect(requestInit().method).toBeUndefined();
    });

    it("asks OpenAI's catalogue with OpenAI's header", async () => {
      fetchMock.mockResolvedValue(jsonResponse(openAiList('gpt-5.4')));

      await catalog(OPENAI_SETTINGS).list('supervisor');

      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://api.openai.test/v1/models',
      );
      expect(requestInit().headers).toMatchObject({
        authorization: 'Bearer sk-proj-test-key',
      });
      // The other vendor's header on this request would mean the two
      // listings had been copied rather than written.
      expect(requestInit().headers).not.toHaveProperty('x-api-key');
    });

    it('follows the provider setting rather than a boot-time copy of it', async () => {
      // #344's rule, carried into this endpoint: an operator who switches
      // provider must reach the new one on the NEXT request, not the next
      // restart. With no base URL configured the host derives from the
      // provider, which is what makes that observable here.
      fetchMock.mockResolvedValue(jsonResponse(openAiList('gpt-5.4')));

      await catalog({
        ...OPENAI_SETTINGS,
        'models.openai.baseUrl': '',
      }).list('supervisor');

      expect(String(fetchMock.mock.calls[0][0])).toContain('api.openai.com');
    });

    it('does not call anything at all when there is no key', async () => {
      const result = await catalog({
        ...ANTHROPIC_SETTINGS,
        'models.anthropic.apiKey': '',
      }).list('supervisor');

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.status).toBe('no_key');
      expect(result.models).toEqual([]);
      // "Nothing to list yet", not an error the UI has to interpret.
      expect(result.detail).toContain('nothing to list yet');
    });
  });

  describe('what it returns on success', () => {
    it("reads Anthropic's ids, labels and dates", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(anthropicList('claude-sonnet-5')),
      );

      const result = await catalog(ANTHROPIC_SETTINGS).list('supervisor');

      expect(result.status).toBe('ok');
      expect(result.provider).toBe('anthropic');
      expect(result.models).toEqual([
        {
          id: 'claude-sonnet-5',
          displayName: 'Display claude-sonnet-5',
          version: '5.0',
          admission: 'admitted',
          createdAt: '2026-02-19T00:00:00.000Z',
        },
      ]);
    });

    it("reads OpenAI's Unix timestamp and its absent label", async () => {
      fetchMock.mockResolvedValue(jsonResponse(openAiList('gpt-5.4')));

      const result = await catalog(OPENAI_SETTINGS).list('supervisor');

      expect(result.models).toEqual([
        {
          id: 'gpt-5.4',
          // Null rather than a copy of the id: the UI can then tell "this
          // vendor publishes no label" from "the label equals the id".
          displayName: null,
          version: '5.4',
          admission: 'admitted',
          createdAt: '2026-02-19T00:00:00.000Z',
        },
      ]);
    });

    it('publishes the floor it applied, per provider', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(anthropicList('claude-opus-4-6')),
      );
      expect(
        (await catalog(ANTHROPIC_SETTINGS).list('supervisor')).minimumVersion,
      ).toBe('4.6');

      fetchMock.mockResolvedValue(jsonResponse(openAiList('gpt-5.4')));
      expect(
        (await catalog(OPENAI_SETTINGS).list('supervisor')).minimumVersion,
      ).toBe('5.4');
    });

    it('says the call spent nothing, as a field and not only as prose', async () => {
      // The distinction from the Test button, which spends real money and is
      // rate limited for it. A UI that had to know which routes are free
      // would be hard-coding a fact about this endpoint.
      fetchMock.mockResolvedValue(jsonResponse(openAiList('gpt-5.4')));

      const result = await catalog(OPENAI_SETTINGS).list('supervisor');

      expect(result.spendsTokens).toBe(false);
      expect(result.detail).toContain('spends no tokens');
      expect(result.checkedAt).toBe('2026-08-27T10:00:00.000Z');
    });

    it('reports a key that works and can reach nothing, rather than an error', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ data: [] }));

      const result = await catalog(OPENAI_SETTINGS).list('supervisor');

      expect(result.status).toBe('ok');
      expect(result.models).toEqual([]);
      expect(result.detail).toContain('listed no models');
    });

    it('skips an entry carrying no id, since there is nothing to select', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ data: [{ id: 'gpt-5.4' }, { object: 'model' }, null] }),
      );

      const result = await catalog(OPENAI_SETTINGS).list('supervisor');

      expect(result.models.map((model) => model.id)).toEqual(['gpt-5.4']);
    });
  });

  describe('the three states', () => {
    const IDS = [
      'gpt-5.6-luna', // admitted
      'gpt-5.4', // admitted, exactly the floor
      'gpt-4.1', // below the floor
      'gpt-4o', // does not parse
      'daybreak-blue-latest', // does not parse
    ];

    async function listed(): Promise<readonly CatalogModel[]> {
      fetchMock.mockResolvedValue(jsonResponse(openAiList(...IDS)));
      return (await catalog(OPENAI_SETTINGS).list('supervisor')).models;
    }

    it('RETURNS an id it could not parse, marked — never drops it', async () => {
      // THE requirement of #393. Failing open is the decision: a vendor that
      // changes its naming scheme must not make its newest model vanish from
      // the dropdown, leaving the operator no explanation and no way to pick
      // it. A filter that dropped these would pass every other test here.
      const models = await listed();

      expect(byId(models, 'gpt-4o').admission).toBe('version_unrecognised');
      expect(byId(models, 'gpt-4o').version).toBeNull();
      expect(byId(models, 'daybreak-blue-latest').admission).toBe(
        'version_unrecognised',
      );
    });

    it('returns every id the provider offered, whatever its state', async () => {
      const models = await listed();

      expect(models.map((model) => model.id).sort()).toEqual([...IDS].sort());
    });

    it('marks each of the three states, so the UI can tell them apart', async () => {
      const models = await listed();

      expect(byId(models, 'gpt-5.4').admission).toBe('admitted');
      expect(byId(models, 'gpt-4.1').admission).toBe('below_threshold');
      expect(byId(models, 'gpt-4o').admission).toBe('version_unrecognised');
    });

    it('counts the marked ones in the sentence an operator reads', async () => {
      fetchMock.mockResolvedValue(jsonResponse(openAiList(...IDS)));

      const result = await catalog(OPENAI_SETTINGS).list('supervisor');

      expect(result.detail).toContain('5 models');
      expect(result.detail).toContain('2 of them 5.4 or newer');
      expect(result.detail).toContain('2 could not be version-checked');
    });

    it('orders admitted first, unrecognised next, superseded last', async () => {
      // The middle position is the deliberate one. An id that did not parse
      // may be the newest model there is, so burying it under the superseded
      // ones would undo most of what returning it achieved.
      const models = await listed();

      expect(models.map((model) => model.id)).toEqual([
        'gpt-5.6-luna',
        'gpt-5.4',
        'daybreak-blue-latest',
        'gpt-4o',
        'gpt-4.1',
      ]);
    });

    it('sorts 5.10 above 5.9, so the order is not a float comparison', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(anthropicList('claude-opus-5-9', 'claude-opus-5-10')),
      );

      const result = await catalog(ANTHROPIC_SETTINGS).list('supervisor');

      expect(result.models.map((model) => model.id)).toEqual([
        'claude-opus-5-10',
        'claude-opus-5-9',
      ]);
    });
  });

  describe('failure, told apart', () => {
    it('reports a rejected key as a rejected key', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ error: { message: 'invalid x-api-key' } }, 401),
      );

      const result = await catalog(ANTHROPIC_SETTINGS).list('supervisor');

      expect(result.status).toBe('invalid_key');
      expect(result.detail).toContain('invalid x-api-key');
      expect(result.models).toEqual([]);
    });

    it('reports the other vendor’s key as the wrong PROVIDER, not a bad key', async () => {
      // The most likely real mistake once there are two providers, and the
      // one "invalid key" would describe misleadingly — sending an operator
      // to reissue a credential that was never the problem.
      fetchMock.mockResolvedValue(
        jsonResponse({ error: { message: 'Incorrect API key provided' } }, 401),
      );

      const result = await catalog({
        ...OPENAI_SETTINGS,
        'models.openai.apiKey': 'sk-ant-api03-something',
      }).list('supervisor');

      expect(result.status).toBe('wrong_provider');
      expect(result.detail).toContain('Anthropic');
      expect(result.detail).toContain('OpenAI');
    });

    it('spots it in the other direction too', async () => {
      fetchMock.mockResolvedValue(jsonResponse({}, 401));

      const result = await catalog({
        ...ANTHROPIC_SETTINGS,
        'models.anthropic.apiKey': 'sk-proj-something',
      }).list('supervisor');

      expect(result.status).toBe('wrong_provider');
    });

    it('keeps its opinion to itself for a key shaped like neither', async () => {
      // A gateway token, or a format a vendor introduces later. "No opinion"
      // has to mean the ordinary answer, or the shape check would start
      // being the reason a working configuration is refused.
      fetchMock.mockResolvedValue(jsonResponse({}, 401));

      const result = await catalog({
        ...OPENAI_SETTINGS,
        'models.openai.apiKey': 'gateway-token-abc',
      }).list('supervisor');

      expect(result.status).toBe('invalid_key');
    });

    it('never checks the key’s shape before calling, so a gateway still works', async () => {
      // Refusing up front would break the documented base-URL override: a
      // proxy may accept a credential in any format at all.
      fetchMock.mockResolvedValue(jsonResponse(openAiList('gpt-5.4')));

      const result = await catalog({
        ...OPENAI_SETTINGS,
        'models.openai.apiKey': 'sk-ant-a-key-the-gateway-accepts',
      }).list('supervisor');

      expect(result.status).toBe('ok');
    });

    it('tells a 403 apart from a 401: it authenticated and was refused', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(
          { error: { message: 'Project does not have access' } },
          403,
        ),
      );

      const result = await catalog(OPENAI_SETTINGS).list('supervisor');

      expect(result.status).toBe('refused');
      expect(result.detail).toContain('accepted the key');
    });

    it('reports an unreachable host as unreachable, and says so about the key', async () => {
      fetchMock.mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));

      const result = await catalog(ANTHROPIC_SETTINGS).list('supervisor');

      expect(result.status).toBe('unreachable');
      expect(result.detail).toContain('api.anthropic.test');
      expect(result.detail).toContain('says nothing');
    });

    it('names the timeout rather than reporting a dead network', async () => {
      // `AbortSignal.timeout` rejects with a DOMException, which is not an
      // `instanceof Error` in Node — getting that wrong sends whoever reads
      // this looking at DNS instead of at the timeout they set.
      const timeout = new DOMException(
        'The operation timed out',
        'TimeoutError',
      );
      fetchMock.mockRejectedValue(timeout);

      const result = await catalog(ANTHROPIC_SETTINGS).list('supervisor');

      expect(result.status).toBe('unreachable');
      expect(result.detail).toContain('no answer within 5000ms');
    });

    it('reports anything else with the status the provider gave', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ error: { message: 'slow down' } }, 429),
      );

      const result = await catalog(OPENAI_SETTINGS).list('supervisor');

      expect(result.status).toBe('failed');
      expect(result.detail).toContain('429');
      expect(result.detail).toContain('slow down');
    });

    it('reports a body that is not JSON without throwing', async () => {
      fetchMock.mockResolvedValue(
        new Response('<html>gateway</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      );

      const result = await catalog(OPENAI_SETTINGS).list('supervisor');

      expect(result.status).toBe('failed');
      expect(result.models).toEqual([]);
    });

    it('reports a 200 with no model list in it', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ object: 'list' }));

      const result = await catalog(OPENAI_SETTINGS).list('supervisor');

      expect(result.status).toBe('failed');
      expect(result.detail).toContain('no list of models');
    });

    it('answers with the same shape whatever went wrong', async () => {
      // #393 asks that the UI not have to interpret an error. Every arm
      // therefore carries provider, floor, timestamp and an empty list — a
      // client renders one shape or none.
      const failures = [
        () => fetchMock.mockRejectedValue(new Error('down')),
        () => fetchMock.mockResolvedValue(jsonResponse({}, 401)),
        () => fetchMock.mockResolvedValue(jsonResponse({}, 500)),
      ];

      for (const arrange of failures) {
        arrange();
        const result = await catalog(OPENAI_SETTINGS).list('supervisor');

        expect(result.provider).toBe('openai');
        expect(result.minimumVersion).toBe('5.4');
        expect(result.models).toEqual([]);
        expect(result.spendsTokens).toBe(false);
        expect(result.checkedAt).toBe('2026-08-27T10:00:00.000Z');
        expect(result.detail.length).toBeGreaterThan(20);
      }
    });

    it('never puts the key in the answer', async () => {
      // The reply is rendered in the Control Center beside the field the key
      // was typed into, and `operator-settings-secret-leak.spec.ts` makes the
      // same claim of the settings document.
      const key = 'sk-ant-super-secret-value';
      const responses = [
        jsonResponse(anthropicList('claude-opus-4-6')),
        jsonResponse({ error: { message: `invalid key ${key}` } }, 401),
      ];

      for (const response of responses) {
        fetchMock.mockResolvedValue(response);
        const result = await catalog({
          ...ANTHROPIC_SETTINGS,
          'models.anthropic.apiKey': key,
        }).list('supervisor');

        expect(JSON.stringify(result)).not.toContain('super-secret-value');
      }
    });
  });

  describe('per consumer (#423, epic #419)', () => {
    /**
     * Both consumers configured, on OPPOSITE providers, with both keys stored.
     *
     * The state the whole issue is about, and the one where a service that
     * ignored its `consumer` argument would still look correct on one of the
     * two calls.
     */
    const SPLIT: OperatorSettingsOverrides = {
      'supervisor.model.provider': 'anthropic',
      'models.anthropic.apiKey': 'sk-ant-test-key',
      'models.anthropic.baseUrl': 'https://api.anthropic.test',
      'chat.model.provider': 'openai',
      'models.openai.apiKey': 'sk-proj-test-key',
      'models.openai.baseUrl': 'https://api.openai.test',
    };

    it('lists the chat’s provider when the chat is the one asked about', () => {
      fetchMock.mockResolvedValue(jsonResponse(openAiList('gpt-5.4')));

      return catalog(SPLIT)
        .list('chat')
        .then((result) => {
          // OpenAI's endpoint, OpenAI's header, OpenAI's key — while the
          // supervisor on the same deployment is pointed at Anthropic.
          expect(fetchMock.mock.calls[0][0]).toBe(
            'https://api.openai.test/v1/models',
          );
          expect(requestInit().headers).toMatchObject({
            authorization: 'Bearer sk-proj-test-key',
          });
          expect(result).toMatchObject({
            consumer: 'chat',
            provider: 'openai',
            status: 'ok',
          });
        });
    });

    it('lists the supervisor’s provider on the same deployment, unchanged', () => {
      fetchMock.mockResolvedValue(
        jsonResponse(anthropicList('claude-opus-4-6')),
      );

      return catalog(SPLIT)
        .list('supervisor')
        .then((result) => {
          expect(fetchMock.mock.calls[0][0]).toBe(
            'https://api.anthropic.test/v1/models?limit=1000',
          );
          expect(requestInit().headers).toMatchObject({
            'x-api-key': 'sk-ant-test-key',
          });
          expect(result).toMatchObject({
            consumer: 'supervisor',
            provider: 'anthropic',
          });
        });
    });

    it('reports no_key against the slot the CHAT’s provider needs', () => {
      // The mistake this endpoint has to describe well: an operator holding
      // one vendor's key selects the other for the chat. Nothing is asked at
      // all, and the sentence has to name the empty slot rather than say the
      // key is bad — a remedy that would send them to reissue a working
      // credential.
      return catalog({
        'models.anthropic.apiKey': 'sk-ant-test-key',
        'chat.model.provider': 'openai',
      })
        .list('chat')
        .then((result) => {
          expect(fetchMock).not.toHaveBeenCalled();
          expect(result).toMatchObject({
            consumer: 'chat',
            provider: 'openai',
            status: 'no_key',
            models: [],
          });
          expect(result.detail).toContain('models.openai.apiKey');
          expect(result.detail).toContain('chat');
        });
    });

    it('uses the asked-for consumer’s own timeout', () => {
      // The timeouts are split, so the catalogue call has to take the one
      // belonging to the consumer it was asked about. Reading the
      // supervisor's here would abort a chat listing on a number the chat's
      // operator never set.
      const abort = jest
        .spyOn(AbortSignal, 'timeout')
        .mockReturnValue(AbortSignal.timeout(50_000));
      fetchMock.mockResolvedValue(jsonResponse(openAiList('gpt-5.4')));

      return catalog({
        ...SPLIT,
        'supervisor.model.timeoutMs': 60_000,
        'chat.model.timeoutMs': 7_000,
      })
        .list('chat')
        .then(() => {
          expect(abort).toHaveBeenCalledWith(7_000);
          abort.mockRestore();
        });
    });
  });

  describe('providerOfKeyShape', () => {
    it('reads the vendor-specific prefix before the shared one', () => {
      // Every Anthropic key is also an `sk-` key, so testing `sk-` first
      // would attribute every Anthropic key to the other vendor.
      expect(providerOfKeyShape('sk-ant-api03-x')).toBe('anthropic');
      expect(providerOfKeyShape('sk-proj-x')).toBe('openai');
      expect(providerOfKeyShape('sk-x')).toBe('openai');
    });

    it('has no opinion about anything else', () => {
      expect(providerOfKeyShape('')).toBeNull();
      expect(providerOfKeyShape('gateway-token')).toBeNull();
      expect(providerOfKeyShape('ANTHROPIC')).toBeNull();
    });
  });
});
