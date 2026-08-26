/**
 * A `GET /api/operator-settings` document, in the API's real shape
 * (#348, epic #332).
 *
 * A SUBSET of the registry, chosen so that every branch the Configuration
 * section has actually appears in it: all three `reload` values, all three
 * `source` values, a secret, an enum, a boolean, a bounded integer, and an
 * `acceptsNull` integer whose value really is null. The fixture is small on
 * purpose — a copy of all thirty-nine keys would go stale against the registry
 * and would be testing the copy rather than the rendering.
 *
 * Typed as `OperatorSettingsDocument`, so a change to the API's shape that the
 * frontend types follow fails this file at compile time rather than at the
 * assertion.
 */

import type {
  OperatorSetting,
  OperatorSettingsDocument,
} from '../../types/operatorSettings';

/** The keys the fixture carries, in the order the API lists them. */
export const OPERATOR_SETTINGS_FIXTURE: OperatorSetting[] = [
  {
    key: 'github.token',
    group: 'github',
    label: 'GitHub token',
    help: 'The token every GitHub read and write is made with.',
    type: 'string',
    reload: 'live',
    dangerous: true,
    source: 'env',
    envVar: 'GITHUB_TOKEN',
    acceptsNull: false,
    updatedAt: null,
    constraints: {},
    secret: true,
    configured: true,
    hint: '****************cdef',
  },
  {
    key: 'github.requestTimeoutMs',
    group: 'github',
    label: 'GitHub request timeout',
    help: 'How long a single GitHub request may take before it is abandoned.',
    type: 'integer',
    reload: 'live',
    dangerous: false,
    source: 'database',
    envVar: 'GITHUB_REQUEST_TIMEOUT_MS',
    acceptsNull: false,
    updatedAt: '2026-08-01T10:00:00.000Z',
    constraints: { min: 1000, max: 120000 },
    secret: false,
    value: 15000,
    default: 10000,
  },
  {
    key: 'github.apiBaseUrl',
    group: 'github',
    label: 'GitHub API base URL',
    help: 'Frozen in the client constructor, so a change needs a restart.',
    type: 'string',
    reload: 'restart',
    dangerous: false,
    source: 'default',
    envVar: 'GITHUB_API_BASE_URL',
    acceptsNull: false,
    updatedAt: null,
    constraints: { format: 'url' },
    secret: false,
    value: 'https://api.github.com',
    default: 'https://api.github.com',
  },
  {
    key: 'runners.claudeCodeLocal.enabled',
    group: 'runner',
    label: 'Local Claude Code runner enabled',
    help: 'Whether this runner may take dispatched work.',
    type: 'boolean',
    reload: 'live',
    dangerous: true,
    source: 'env',
    envVar: 'CLAUDE_CODE_ENABLED',
    acceptsNull: false,
    updatedAt: null,
    constraints: {},
    secret: false,
    value: true,
    default: false,
  },
  {
    key: 'runners.claudeCodeLocal.permissionMode',
    group: 'runner',
    label: 'Permission mode',
    help: 'What the agent may do without asking.',
    type: 'enum',
    reload: 'next-unit',
    dangerous: true,
    source: 'default',
    envVar: 'CLAUDE_CODE_PERMISSION_MODE',
    acceptsNull: false,
    updatedAt: null,
    constraints: { values: ['default', 'acceptEdits', 'bypassPermissions'] },
    secret: false,
    value: 'default',
    default: 'default',
  },
  {
    key: 'dispatch.maxConcurrent',
    group: 'dispatch',
    label: 'Maximum concurrent dispatches',
    help: 'Null means no ceiling beyond what the runners themselves impose.',
    type: 'integer',
    reload: 'next-unit',
    dangerous: false,
    source: 'default',
    envVar: 'DISPATCH_MAX_CONCURRENT',
    acceptsNull: true,
    updatedAt: null,
    constraints: { min: 1 },
    secret: false,
    value: null,
    default: null,
  },
];

/** The whole document, with anything a test needs to vary overridden. */
export function operatorSettingsFixture(
  overrides: Partial<OperatorSettingsDocument> = {},
): OperatorSettingsDocument {
  return {
    revision: 7,
    status: 'loaded',
    overlay: {
      loadedAt: '2026-08-01T10:00:00.000Z',
      attemptedAt: '2026-08-01T10:00:15.000Z',
      overriddenKeys: 1,
    },
    secretStorage: { configured: true },
    settings: OPERATOR_SETTINGS_FIXTURE,
    ...overrides,
  };
}
