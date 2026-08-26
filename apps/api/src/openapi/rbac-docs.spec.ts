import { RBAC_EXTENSION_KEY } from '../auth/decorators/auth.decorator';
import {
  applyRbacDocs,
  describeRequirements,
  REQUIREMENTS_MARKER,
} from './rbac-docs';
import { DocOperation, MutableDocument } from './types';

function operation(rbac?: unknown, description?: string): DocOperation {
  return {
    ...(description !== undefined ? { description } : {}),
    ...(rbac !== undefined ? { [RBAC_EXTENSION_KEY]: rbac } : {}),
  };
}

describe('describeRequirements', () => {
  it('says nothing about an operation with no @Auth() metadata', () => {
    expect(describeRequirements(operation())).toBeNull();
  });

  it('reports authentication-only routes as such', () => {
    const line = describeRequirements(
      operation({ authenticated: true, roles: [], permissions: [] }),
    );
    expect(line).toBe(
      `${REQUIREMENTS_MARKER} authentication only — any signed-in user may call this.`,
    );
  });

  it('names a single permission', () => {
    const line = describeRequirements(
      operation({
        authenticated: true,
        roles: [],
        permissions: ['users:read'],
      }),
    );
    expect(line).toBe(
      `${REQUIREMENTS_MARKER} authentication, plus permission \`users:read\`.`,
    );
  });

  it('joins multiple permissions with "and", because the guard requires all of them', () => {
    const line = describeRequirements(
      operation({
        authenticated: true,
        roles: [],
        permissions: ['users:read', 'rbac:manage'],
      }),
    );
    expect(line).toContain('permissions `users:read` and `rbac:manage`');
  });

  it('presents multiple roles as alternatives, because the guard requires any of them', () => {
    const line = describeRequirements(
      operation({
        authenticated: true,
        roles: ['admin', 'contributor'],
        permissions: [],
      }),
    );
    expect(line).toContain('any of the system roles `admin`, `contributor`');
  });

  it('combines role and permissions in one sentence', () => {
    const line = describeRequirements(
      operation({
        authenticated: true,
        roles: ['admin'],
        permissions: ['users:read', 'users:write'],
      }),
    );
    expect(line).toBe(
      `${REQUIREMENTS_MARKER} authentication, plus system role \`admin\` and ` +
        'permissions `users:read` and `users:write`.',
    );
  });

  it('reports an operation that only declares security as authentication-only', () => {
    // The auth and device-authorization controllers compose
    // `@UseGuards(JwtAuthGuard)` with a bare `@ApiBearerAuth('JWT-auth')`
    // rather than `@Auth()`, so there is no x-rbac to read.
    const line = describeRequirements({ security: [{ 'JWT-auth': [] }] });
    expect(line).toBe(
      `${REQUIREMENTS_MARKER} authentication only \u2014 any signed-in user may call this.`,
    );
  });
});

describe('the interactive-session requirement (#346)', () => {
  it('is rendered after the permissions, and names VISION §8', () => {
    // An operator writing a script against `PATCH /api/operator-settings`
    // should learn from the reference that their personal access token will
    // not work, rather than from a 403 at 2am.
    const line = describeRequirements(
      operation({
        authenticated: true,
        roles: [],
        permissions: ['system_settings:write'],
        interactive: true,
      }),
    );

    expect(line).toContain('`system_settings:write`');
    expect(line).toContain('an interactive session');
    expect(line).toContain('VISION §8');
    expect(line!.indexOf('`system_settings:write`')).toBeLessThan(
      line!.indexOf('an interactive session'),
    );
  });

  it('is absent from an operation that did not ask for it', () => {
    const line = describeRequirements(
      operation({
        authenticated: true,
        roles: [],
        permissions: ['system_settings:read'],
      }),
    );

    expect(line).not.toContain('interactive');
  });

  it('is stated even when nothing else is required', () => {
    // Nothing declares this combination today, but the clause list is what
    // decides between the two sentences, so an interactive-only route must not
    // fall through to "any signed-in user may call this".
    const line = describeRequirements(
      operation({
        authenticated: true,
        roles: [],
        permissions: [],
        interactive: true,
      }),
    );

    expect(line).toContain('an interactive session');
  });
});

describe('applyRbacDocs', () => {
  function documentWith(op: DocOperation): MutableDocument {
    return { paths: { '/api/thing': { get: op } } };
  }

  it('appends to a hand-written description instead of replacing it', () => {
    const doc = documentWith(
      operation(
        { authenticated: true, roles: [], permissions: ['users:read'] },
        'Lists things.',
      ),
    );
    applyRbacDocs(doc);

    const description = (doc.paths!['/api/thing'] as { get: DocOperation }).get
      .description!;
    expect(description).toContain('Lists things.');
    expect(description).toContain('`users:read`');
  });

  it('is idempotent, so re-running never stacks duplicate blocks', () => {
    const doc = documentWith(
      operation({
        authenticated: true,
        roles: [],
        permissions: ['users:read'],
      }),
    );
    applyRbacDocs(doc);
    applyRbacDocs(doc);

    const description = (doc.paths!['/api/thing'] as { get: DocOperation }).get
      .description!;
    expect(description.match(/\*\*Requires:\*\*/g)).toHaveLength(1);
  });

  it('ignores non-operation keys on a path item', () => {
    const doc: MutableDocument = {
      paths: {
        '/api/thing': {
          parameters: [{ name: 'id', in: 'path' }],
          get: operation({ authenticated: true, roles: [], permissions: [] }),
        },
      },
    };
    expect(() => applyRbacDocs(doc)).not.toThrow();
    expect(
      (doc.paths!['/api/thing'] as Record<string, unknown>).parameters,
    ).toEqual([{ name: 'id', in: 'path' }]);
  });
});
