// =============================================================================
// Minimal structural types for post-processing the generated document
// =============================================================================
//
// `@nestjs/swagger` exports `OpenAPIObject` from its root but not
// `OperationObject`, and reaching into `@nestjs/swagger/dist/interfaces/...` to
// get it couples this code to that package's build layout.
//
// The passes in this directory read and write a handful of fields on operations
// and add vendor extensions, so a structural type with an index signature is
// both sufficient and more honest than the package's own — whose `responses` is
// required, which the generated object does not always satisfy mid-pass.
// =============================================================================

export interface DocOperation {
  summary?: string;
  description?: string;
  operationId?: string;
  tags?: string[];
  responses?: Record<string, unknown>;
  /** Entries are alternatives (OR), not a conjunction. */
  security?: Array<Record<string, string[]>>;
  /** Vendor extensions, including the `x-rbac` stamped by `@Auth()`. */
  [key: string]: unknown;
}

export type DocPathItem = Record<string, DocOperation | unknown>;

export interface MutableDocument {
  paths?: Record<string, DocPathItem | undefined>;
  [key: string]: unknown;
}

/** HTTP methods an OpenAPI path item may carry, in spec order. */
export const HTTP_METHODS = [
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
] as const;

/**
 * Visits every operation in the document.
 *
 * Shared by the post-processing passes so the "which keys on a path item are
 * operations" question is answered in exactly one place — `parameters` and
 * `servers` are siblings of the methods and must not be treated as operations.
 */
export function forEachOperation(
  document: MutableDocument,
  visit: (operation: DocOperation, path: string, method: string) => void,
): void {
  for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    for (const method of HTTP_METHODS) {
      const operation = (pathItem as Record<string, unknown>)[method];
      if (!operation || typeof operation !== 'object') continue;
      visit(operation as DocOperation, path, method);
    }
  }
}
