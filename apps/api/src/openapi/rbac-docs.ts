import {
  RBAC_EXTENSION_KEY,
  RbacExtension,
} from '../auth/decorators/auth.decorator';
import { DocOperation, MutableDocument, forEachOperation } from './types';

/**
 * Marker prepended to every generated requirements line.
 *
 * Serves two purposes: it is the visible label a reader sees, and it makes the
 * pass idempotent — an operation whose description already contains it is left
 * alone, so running the enrichment twice (a test, a re-created document) can
 * never stack duplicate blocks.
 */
export const REQUIREMENTS_MARKER = '**Requires:**';

/**
 * Renders the `x-rbac` extension stamped by `@Auth()` into each operation's
 * description.
 *
 * This runs over the finished document rather than inside the decorator on
 * purpose. A decorator that wrote `description` directly would race the
 * controller's own `@ApiOperation({ description })` — decorators evaluate
 * bottom-up and `@nestjs/swagger` merges operation metadata shallowly, so
 * whichever ran last would silently clobber the other. Post-processing appends
 * instead, so hand-written prose and generated requirements coexist.
 */
export function applyRbacDocs(document: MutableDocument): MutableDocument {
  forEachOperation(document, (operation) => {
    const line = describeRequirements(operation);
    if (!line) return;

    const existing = operation.description ?? '';
    if (existing.includes(REQUIREMENTS_MARKER)) return;

    operation.description = existing ? `${existing}\n\n${line}` : line;
  });

  return document;
}

/**
 * The one-line requirements sentence for an operation, or `null` when the
 * operation is something this pass has nothing to say about.
 */
export function describeRequirements(operation: DocOperation): string | null {
  const rbac = operation[RBAC_EXTENSION_KEY] as RbacExtension | undefined;

  if (!rbac || rbac.authenticated !== true) {
    // No `@Auth()` on this handler. A few routes — on the auth and
    // device-authorization controllers — instead compose
    // `@UseGuards(JwtAuthGuard)` with a bare `@ApiBearerAuth('JWT-auth')`,
    // where the RBAC guards would have nothing to check. Those declare a
    // security requirement and nothing more, which is exactly what the
    // authentication-only line says.
    //
    // Everything else is `@Public()` or guarded by something bespoke: no
    // decorator metadata to render, and inventing a claim about it would be
    // worse than saying nothing.
    const declaresSecurity = (operation.security ?? []).length > 0;
    return declaresSecurity ? authenticationOnly() : null;
  }

  const clauses: string[] = [];
  const roles = rbac.roles ?? [];
  const permissions = rbac.permissions ?? [];

  if (roles.length === 1) {
    clauses.push(`system role ${code(roles[0])}`);
  } else if (roles.length > 1) {
    clauses.push(`any of the system roles ${roles.map(code).join(', ')}`);
  }

  if (permissions.length === 1) {
    clauses.push(`permission ${code(permissions[0])}`);
  } else if (permissions.length > 1) {
    // The guard requires ALL of them, so join with "and" rather than a bare
    // comma list that reads as alternatives.
    clauses.push(`permissions ${permissions.map(code).join(' and ')}`);
  }

  if (clauses.length === 0) {
    return authenticationOnly();
  }

  return `${REQUIREMENTS_MARKER} authentication, plus ${joinClauses(clauses)}.`;
}

function authenticationOnly(): string {
  return `${REQUIREMENTS_MARKER} authentication only — any signed-in user may call this.`;
}

function code(value: string): string {
  return `\`${value}\``;
}

function joinClauses(clauses: string[]): string {
  if (clauses.length === 1) return clauses[0];
  return `${clauses.slice(0, -1).join(', ')} and ${clauses[clauses.length - 1]}`;
}
