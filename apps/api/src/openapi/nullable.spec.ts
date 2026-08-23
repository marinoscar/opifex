import { applyNullableFor31 } from './nullable';
import { MutableDocument } from './types';

describe('applyNullableFor31', () => {
  it('widens a typed schema into a union', () => {
    const doc: MutableDocument = {
      components: { schemas: { A: { type: 'string', nullable: true } } },
    };
    applyNullableFor31(doc);

    expect(
      (doc.components as never as { schemas: { A: unknown } }).schemas.A,
    ).toEqual({
      type: ['string', 'null'],
    });
  });

  it('rewrites inline parameter and response schemas too, not only components', () => {
    const doc: MutableDocument = {
      paths: {
        '/api/thing': {
          get: {
            parameters: [
              { name: 'q', schema: { type: 'integer', nullable: true } },
            ],
            responses: {
              '200': {
                content: {
                  'application/json': {
                    schema: { type: 'boolean', nullable: true },
                  },
                },
              },
            },
          },
        },
      },
    };
    applyNullableFor31(doc);

    expect(JSON.stringify(doc)).not.toContain('nullable');
    expect(JSON.stringify(doc)).toContain('["integer","null"]');
    expect(JSON.stringify(doc)).toContain('["boolean","null"]');
  });

  it('adds null to an existing type union without duplicating it', () => {
    const doc: MutableDocument = {
      components: {
        schemas: { A: { type: ['string', 'null'], nullable: true } },
      },
    };
    applyNullableFor31(doc);

    expect(
      (doc.components as never as { schemas: { A: { type: string[] } } })
        .schemas.A.type,
    ).toEqual(['string', 'null']);
  });

  it('turns a nullable $ref into a one-of, the only form 3.1 honours', () => {
    const doc: MutableDocument = {
      components: {
        schemas: { A: { $ref: '#/components/schemas/B', nullable: true } },
      },
    };
    applyNullableFor31(doc);

    expect(
      (doc.components as never as { schemas: { A: unknown } }).schemas.A,
    ).toEqual({
      oneOf: [{ $ref: '#/components/schemas/B' }, { type: 'null' }],
    });
  });

  it('drops the keyword when there is nothing to widen', () => {
    const doc: MutableDocument = {
      components: { schemas: { A: { nullable: true } } },
    };
    applyNullableFor31(doc);

    expect(
      (doc.components as never as { schemas: { A: unknown } }).schemas.A,
    ).toEqual({});
  });

  it('terminates on a cyclic document', () => {
    const schema: Record<string, unknown> = { type: 'string', nullable: true };
    schema.self = schema;
    const doc: MutableDocument = { components: { schemas: { A: schema } } };

    expect(() => applyNullableFor31(doc)).not.toThrow();
    expect(schema.nullable).toBeUndefined();
  });
});
