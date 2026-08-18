// =============================================================================
// OpenAPI 3.0 `nullable` → 3.1 type union (issue #53)
// =============================================================================
//
// The document is published as OpenAPI 3.1, because zod v4 emits JSON Schema
// 2020-12 and 3.0 rejects several of its keywords outright.
//
// But `@nestjs/swagger`'s `@ApiProperty({ nullable: true })` still emits the
// 3.0 spelling — a sibling `nullable: true` next to `type` — and 3.1 removed
// that keyword entirely. A 3.1 consumer does not "mostly ignore" it: it reads
// `type: "string"` and generates a non-nullable field, so a client is wrong
// about exactly the values most likely to break it.
//
// 3.1's spelling is a type union, `type: ["string", "null"]`, which is what this
// pass rewrites to. It runs over the whole document rather than being fixed at
// ~28 `@ApiProperty` call sites, because the next one written will use the 3.0
// spelling too — `nullable` is what the decorator's own types document.
// =============================================================================

import { MutableDocument } from './types';

type SchemaLike = Record<string, unknown>;

/**
 * Rewrites every `nullable: true` in the document into a 3.1 type union.
 *
 * Walks the whole document rather than just `components.schemas`: inline
 * parameter and response schemas carry the keyword too.
 */
export function applyNullableFor31(document: MutableDocument): MutableDocument {
  walk(document as SchemaLike, new Set());
  return document;
}

function walk(node: unknown, seen: Set<object>): void {
  if (!node || typeof node !== 'object') return;
  if (seen.has(node as object)) return;
  seen.add(node as object);

  if (Array.isArray(node)) {
    for (const item of node) walk(item, seen);
    return;
  }

  const schema = node as SchemaLike;
  if (schema.nullable === true) {
    rewrite(schema);
  }

  for (const value of Object.values(schema)) walk(value, seen);
}

function rewrite(schema: SchemaLike): void {
  const type = schema.type;

  if (typeof type === 'string') {
    schema.type = type === 'null' ? type : [type, 'null'];
    delete schema.nullable;
    return;
  }

  if (Array.isArray(type)) {
    if (!type.includes('null')) type.push('null');
    delete schema.nullable;
    return;
  }

  // No `type` to widen — the schema is a bare `$ref`, a composition, or
  // untyped. 3.1 expresses "this or null" as a one-of, which is also the only
  // form that works alongside a `$ref` (a `$ref` sibling is ignored in 3.0 and
  // merged in 3.1, so neither spelling of a sibling keyword is dependable).
  const ref = schema.$ref;
  if (typeof ref === 'string') {
    delete schema.$ref;
    schema.oneOf = [{ $ref: ref }, { type: 'null' }];
    delete schema.nullable;
    return;
  }

  // Nothing meaningful to rewrite into; drop the keyword rather than leave a
  // 3.0-only field in a 3.1 document.
  delete schema.nullable;
}
