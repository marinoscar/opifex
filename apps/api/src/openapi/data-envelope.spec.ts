import { applyDataEnvelope } from './data-envelope';
import { MutableDocument } from './types';

function documentWith(
  responses: Record<string, unknown>,
  schemas: Record<string, unknown> = {},
): MutableDocument {
  return {
    components: { schemas },
    paths: { '/api/thing': { get: { responses } } },
  };
}

function schemaOf(
  doc: MutableDocument,
  status: string,
): Record<string, unknown> | undefined {
  const op = (
    doc.paths!['/api/thing'] as Record<
      string,
      { responses: Record<string, unknown> }
    >
  ).get;
  const response = op.responses[status] as {
    content?: Record<string, { schema?: Record<string, unknown> }>;
  };
  return response.content?.['application/json']?.schema;
}

const jsonResponse = (schema: Record<string, unknown>) => ({
  description: 'ok',
  content: { 'application/json': { schema } },
});

describe('applyDataEnvelope', () => {
  it('wraps a 2xx JSON response in the envelope the global interceptor produces', () => {
    const doc = documentWith(
      { '200': jsonResponse({ $ref: '#/components/schemas/Thing' }) },
      { Thing: { type: 'object', properties: { id: { type: 'string' } } } },
    );
    applyDataEnvelope(doc);

    expect(schemaOf(doc, '200')).toEqual({
      type: 'object',
      required: ['data'],
      properties: {
        data: { $ref: '#/components/schemas/Thing' },
        meta: expect.objectContaining({ type: 'object' }),
      },
    });
  });

  it('leaves error responses alone — the exception filter bypasses interceptors', () => {
    const doc = documentWith({
      '404': jsonResponse({ $ref: '#/components/schemas/ErrorDto' }),
      default: jsonResponse({ $ref: '#/components/schemas/ErrorDto' }),
    });
    applyDataEnvelope(doc);

    expect(schemaOf(doc, '404')).toEqual({
      $ref: '#/components/schemas/ErrorDto',
    });
    expect(schemaOf(doc, 'default')).toEqual({
      $ref: '#/components/schemas/ErrorDto',
    });
  });

  it('leaves a schemaless response alone — that is the byte-proxy and 204 case', () => {
    const doc = documentWith({ '204': { description: 'No content' } });
    expect(() => applyDataEnvelope(doc)).not.toThrow();
    expect(schemaOf(doc, '204')).toBeUndefined();
  });

  it('does not double-wrap a schema that already declares data', () => {
    const already = {
      type: 'object',
      properties: { data: { type: 'string' } },
    };
    const doc = documentWith({ '200': jsonResponse(already) });
    applyDataEnvelope(doc);

    expect(schemaOf(doc, '200')).toEqual(already);
  });

  it('follows a $ref before deciding, so an envelope DTO is not wrapped twice', () => {
    const doc = documentWith(
      { '200': jsonResponse({ $ref: '#/components/schemas/Envelope' }) },
      {
        Envelope: { type: 'object', properties: { data: { type: 'string' } } },
      },
    );
    applyDataEnvelope(doc);

    expect(schemaOf(doc, '200')).toEqual({
      $ref: '#/components/schemas/Envelope',
    });
  });

  it('leaves composed schemas alone rather than guessing at their shape', () => {
    const composed = { allOf: [{ $ref: '#/components/schemas/A' }] };
    const doc = documentWith({ '200': jsonResponse(composed) });
    applyDataEnvelope(doc);

    expect(schemaOf(doc, '200')).toEqual(composed);
  });

  it('leaves an unresolvable $ref alone', () => {
    const doc = documentWith({
      '200': jsonResponse({ $ref: '#/components/schemas/Missing' }),
    });
    applyDataEnvelope(doc);

    expect(schemaOf(doc, '200')).toEqual({
      $ref: '#/components/schemas/Missing',
    });
  });

  it('only touches application/json', () => {
    const doc: MutableDocument = {
      components: { schemas: {} },
      paths: {
        '/api/thing': {
          get: {
            responses: {
              '200': {
                description: 'bytes',
                content: {
                  'image/jpeg': {
                    schema: { type: 'string', format: 'binary' },
                  },
                },
              },
            },
          },
        },
      },
    };
    applyDataEnvelope(doc);

    const op = (
      doc.paths!['/api/thing'] as Record<
        string,
        { responses: Record<string, unknown> }
      >
    ).get;
    const response = op.responses['200'] as {
      content: Record<string, { schema: unknown }>;
    };
    expect(response.content['image/jpeg'].schema).toEqual({
      type: 'string',
      format: 'binary',
    });
  });
});
