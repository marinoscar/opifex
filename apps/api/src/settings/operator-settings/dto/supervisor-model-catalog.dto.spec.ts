import { Logger } from '@nestjs/common';

import { SupervisorModelCatalogService } from '../../../supervisor/invocation/model-catalog.service';
import { makeOperatorSettings } from '../operator-settings.test-double';
import { supervisorModelCatalogSchema } from './supervisor-model-catalog.dto';

/**
 * The published schema against what the service actually returns (#393).
 *
 * The DTO and `SupervisorModelCatalogService` declare the same shape in two
 * places — a zod schema here, TypeScript interfaces there — because the schema
 * has to import its enums FROM `supervisor/invocation/` (the provider seam
 * forbids restating them) and having the service import its own result type
 * back out of the settings layer would close that loop the wrong way round.
 *
 * Two declarations drift. So these cases run the real service, with `fetch`
 * stubbed, and parse its real output through the real schema: a field renamed
 * on one side and not the other fails here rather than in a client, and the
 * global `ZodValidationPipe` never sees a response its own schema rejects.
 */

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

function service(apiKey = 'sk-proj-test'): SupervisorModelCatalogService {
  return new SupervisorModelCatalogService(
    makeOperatorSettings({
      overrides: {
        'supervisor.model.provider': 'openai',
        'supervisor.model.apiKey': apiKey,
        'supervisor.model.baseUrl': 'https://api.openai.test',
      },
    }),
  );
}

function listResponse(...ids: string[]): Response {
  return new Response(
    JSON.stringify({
      object: 'list',
      data: ids.map((id) => ({ id, object: 'model', created: 1771459200 })),
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('supervisorModelCatalogSchema (#393)', () => {
  it('accepts a full catalogue, including an id it could not version', () => {
    // The unparseable row is the one that would be rejected by a schema that
    // made `version` a plain string — and a response the pipe rejects is a
    // 500 in place of the answer the operator asked for.
    fetchMock.mockResolvedValue(
      listResponse('gpt-5.4', 'daybreak-blue-latest'),
    );

    return service()
      .list()
      .then((catalogue) => {
        const parsed = supervisorModelCatalogSchema.safeParse(catalogue);

        expect(parsed.success).toBe(true);
        expect(
          parsed.success &&
            parsed.data.models.map((model) => model.admission).sort(),
        ).toEqual(['admitted', 'version_unrecognised']);
      });
  });

  it.each([
    ['no key at all', '', undefined],
    ['a rejected key', 'sk-proj-bad', 401],
    ['a key for the other provider', 'sk-ant-oops', 401],
    ['a refusal', 'sk-proj-x', 403],
    ['anything else', 'sk-proj-x', 500],
  ])('accepts the answer for %s', async (_label, apiKey, status) => {
    if (status !== undefined) {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ error: { message: 'no' } }), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }

    const catalogue = await service(apiKey).list();

    expect(supervisorModelCatalogSchema.safeParse(catalogue).success).toBe(
      true,
    );
  });

  it('accepts the answer when nothing answered at all', async () => {
    fetchMock.mockRejectedValue(new Error('ENOTFOUND'));

    const catalogue = await service().list();

    expect(supervisorModelCatalogSchema.safeParse(catalogue).success).toBe(
      true,
    );
  });

  it('refuses a state outside the three, so the wire cannot invent a fourth', async () => {
    fetchMock.mockResolvedValue(listResponse('gpt-5.4'));
    const catalogue = await service().list();

    const tampered = {
      ...catalogue,
      models: [{ ...catalogue.models[0], admission: 'hidden' }],
    };

    expect(supervisorModelCatalogSchema.safeParse(tampered).success).toBe(
      false,
    );
  });
});
