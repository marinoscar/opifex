import { Type, applyDecorators } from '@nestjs/common';
import { ApiExtraModels, ApiResponse, getSchemaPath } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';

/**
 * Which of this API's two list-body shapes an endpoint returns.
 *
 * Both are offset-paginated and both are wrapped in the `{ data: … }` envelope
 * by the global interceptor; they differ in where the counts sit *inside*
 * `data`. Note that neither puts `meta` as a SIBLING of `data` — the envelope's
 * own `meta` carries only the server timestamp.
 *
 *  - `flat`   — `GET /api/users`, `GET /api/allowlist`:
 *               `{ items, total, page, pageSize, totalPages }`
 *  - `nested` — `GET /api/storage/objects`:
 *               `{ items, meta: { page, pageSize, totalItems, totalPages } }`
 *
 * Two shapes for the same concept is a defect, not a design; it is described
 * faithfully here (and in `info.description`) rather than smoothed over,
 * because unifying them is a breaking change tracked separately and a client
 * written against this document has to handle what the server sends today.
 */
export type DataResponsePagination = 'flat' | 'nested';

export interface ApiDataResponseOptions {
  status?: number;
  description?: string;
  /** Wrap the model in an array: `{ data: [T] }`. */
  isArray?: boolean;
  /** Describe `data` as a paginated list of the model in the given shape. */
  pagination?: DataResponsePagination;
}

const ITEMS = (model: Type<unknown>) => ({
  type: 'array' as const,
  items: { $ref: getSchemaPath(model) },
});

const FLAT_COUNTS = {
  total: { type: 'integer', description: 'Total matching rows across all pages.', example: 42 },
  page: { type: 'integer', description: 'One-based page number.', example: 1 },
  pageSize: { type: 'integer', example: 20 },
  totalPages: { type: 'integer', example: 3 },
} as const;

const NESTED_META_SCHEMA = {
  type: 'object',
  description:
    'Pagination counts. Note this is nested inside `data` and is a different object from the ' +
    'envelope\'s own `meta`, which carries the server timestamp. Note also that the total is ' +
    'named `totalItems` here, where a flat list names it `total`.',
  required: ['page', 'pageSize', 'totalItems', 'totalPages'],
  properties: {
    page: { type: 'integer', description: 'One-based page number.', example: 1 },
    pageSize: { type: 'integer', example: 20 },
    totalItems: { type: 'integer', example: 42 },
    totalPages: { type: 'integer', example: 3 },
  },
} as const;

/**
 * Documents a response that wraps its payload in the `{ data: … }` envelope the
 * global `TransformInterceptor` produces.
 *
 * Exists because the two were routinely out of sync: a handler returning
 * `{ data: { … } }` documented with `@ApiResponse({ type: Dto })` advertises the
 * bare inner object, so a generated client, a Postman import, or anyone reading
 * the sample gets a shape the server never sends. Declaring the envelope once,
 * here, removes the opportunity to describe it wrongly.
 *
 * Most operations need nothing: `applyDataEnvelope` performs the same wrapping
 * over the whole finished document. Reach for this decorator where the payload
 * has no DTO to point at — the paginated lists, whose envelope contents are
 * assembled in the service rather than declared by a type.
 *
 * @example
 * @ApiDataResponse(UserResponseDto, { pagination: 'flat', description: 'Paginated user list' })
 *
 * @example
 * @ApiDataResponse(ObjectResponseDto, { pagination: 'nested' })
 */
export function ApiDataResponse(
  model: Type<unknown>,
  options: ApiDataResponseOptions = {},
) {
  const { status = 200, description, isArray = false, pagination } = options;

  let dataSchema: Record<string, unknown>;

  if (pagination === 'flat') {
    dataSchema = {
      type: 'object',
      required: ['items', 'total', 'page', 'pageSize', 'totalPages'],
      properties: { items: ITEMS(model), ...FLAT_COUNTS },
    };
  } else if (pagination === 'nested') {
    dataSchema = {
      type: 'object',
      required: ['items', 'meta'],
      properties: { items: ITEMS(model), meta: NESTED_META_SCHEMA },
    };
  } else if (isArray) {
    dataSchema = ITEMS(model);
  } else {
    dataSchema = { $ref: getSchemaPath(model) };
  }

  return applyDecorators(
    ApiExtraModels(model),
    ApiResponse({
      status,
      description,
      // Cast because `SchemaObject.properties` is typed against @nestjs/swagger's
      // own node types, which the plain JSON-Schema literals above satisfy
      // structurally but cannot be inferred as.
      schema: {
        type: 'object',
        required: ['data'],
        properties: { data: dataSchema },
      } as SchemaObject,
    }),
  );
}
