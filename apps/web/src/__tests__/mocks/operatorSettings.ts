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
 * #349 added the keys the Credentials section needs — the other two secrets,
 * the binaries and model name its probes depend on, and the two ceilings with
 * their windows — to THIS fixture rather than to a second one. There is one
 * `GET /api/operator-settings` and both sections render from it, so two
 * documents would let the sections be tested against a split that does not
 * exist in the deployment.
 *
 * The secrets are deliberately in different states, because those are the
 * states the section has to draw apart: `github.token` configured from the
 * environment (so there is nothing stored to clear),
 * `runners.claudeCodeLocal.oauthToken` configured from a stored row (so Clear
 * is live), and `models.anthropic.apiKey` not configured at all.
 *
 * #422 replaced the single `supervisor.model.apiKey` with one slot per
 * provider, and the fixture carries BOTH slots in opposite states —
 * `models.anthropic.apiKey` empty, `models.openai.apiKey` stored — precisely
 * so that "selecting one provider does not lose the other's key" is a claim a
 * test can make. A fixture with one slot could not distinguish a panel that
 * holds two credentials from one that quietly shows the selected one twice.
 *
 * #423 added the chat's own `chat.model.*` rows, because there are now TWO
 * consumers that each select a provider and a model. They are carried in the
 * default fixture rather than in a variant so that "the supervisor and the
 * chat are on different providers" is a change of one field in a test rather
 * than a second document — and so that the unconfigured chat, which is what
 * every deployment starts with, is the state the section is tested against by
 * default.
 *
 * Typed as `OperatorSettingsDocument`, so a change to the API's shape that the
 * frontend types follow fails this file at compile time rather than at the
 * assertion.
 */

import type {
  OperatorSetting,
  OperatorSettingsDocument,
} from '../../types/operatorSettings';

/**
 * The masked hint, exactly as `maskSecret` in
 * `apps/api/src/common/crypto/redact.ts` builds it: a FIXED-WIDTH eight-
 * asterisk mask (its length says nothing about the value's) followed by the
 * last four characters, and nothing at all for a value under sixteen
 * characters. A fixture that invented a longer mask would let a component be
 * written against a shape the API does not produce.
 */
export function maskedHint(value: string): string {
  return value.length < 16 ? '********' : `********${value.slice(-4)}`;
}

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
    hint: '********cdef',
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
    key: 'runners.claudeCodeLocal.oauthToken',
    group: 'runner',
    label: 'Claude Code OAuth token',
    help: 'The credential the local runner authenticates every dispatched run with.',
    type: 'string',
    reload: 'next-unit',
    dangerous: true,
    source: 'database',
    envVar: 'CLAUDE_CODE_OAUTH_TOKEN',
    acceptsNull: false,
    updatedAt: '2026-08-02T09:30:00.000Z',
    constraints: {},
    secret: true,
    configured: true,
    hint: '********wxyz',
  },
  {
    key: 'runners.claudeCodeLocal.binary',
    group: 'runner',
    label: 'Claude binary',
    help: 'The executable the runner spawns.',
    type: 'string',
    reload: 'next-unit',
    dangerous: false,
    source: 'default',
    envVar: 'CLAUDE_CODE_BINARY',
    acceptsNull: false,
    updatedAt: null,
    constraints: {},
    secret: false,
    value: 'claude',
    default: 'claude',
  },
  {
    // Generated by `modelCredentialSettings()` in the API's registry, one
    // slot per entry in SUPERVISOR_MODEL_PROVIDERS — which is why the fixture
    // carries two of them and would carry a third the day an adapter is added.
    key: 'models.anthropic.apiKey',
    group: 'models',
    label: 'Anthropic API key',
    help: 'A separately metered Anthropic credential — NOT the subscription the agent authenticates with (ADR-0015). It is held independently of every other provider’s key.',
    type: 'string',
    reload: 'live',
    dangerous: false,
    source: 'default',
    envVar: 'MODEL_ANTHROPIC_API_KEY',
    acceptsNull: false,
    updatedAt: null,
    constraints: {},
    secret: true,
    configured: false,
    hint: null,
  },
  {
    key: 'models.anthropic.baseUrl',
    group: 'models',
    label: 'Anthropic base URL',
    // EMPTY by default, and empty MEANS "follow the provider" — not "unset".
    // The API's registry says so and the panel renders it as that.
    help: 'Leave empty and Anthropic is called at its own endpoint. Set it only for a proxy, a gateway or a test server: the Anthropic API key above is sent to whatever host is named here.',
    type: 'string',
    reload: 'live',
    dangerous: true,
    source: 'default',
    envVar: 'MODEL_ANTHROPIC_BASE_URL',
    acceptsNull: false,
    updatedAt: null,
    constraints: { format: 'url' },
    secret: false,
    value: '',
    default: '',
  },
  {
    // STORED, while the selected provider's slot is empty. The whole point of
    // #422 is that this key survives selecting the other vendor, so the
    // fixture is the state where losing it would be visible.
    key: 'models.openai.apiKey',
    group: 'models',
    label: 'OpenAI API key',
    help: 'A separately metered OpenAI credential — NOT the subscription the agent authenticates with (ADR-0015). It is held independently of every other provider’s key.',
    type: 'string',
    reload: 'live',
    dangerous: false,
    source: 'database',
    envVar: 'MODEL_OPENAI_API_KEY',
    acceptsNull: false,
    updatedAt: '2026-08-03T11:15:00.000Z',
    constraints: {},
    secret: true,
    configured: true,
    hint: '********mnop',
  },
  {
    key: 'models.openai.baseUrl',
    group: 'models',
    label: 'OpenAI base URL',
    help: 'Leave empty and OpenAI is called at its own endpoint. Set it only for a proxy, a gateway or a test server: the OpenAI API key above is sent to whatever host is named here.',
    type: 'string',
    reload: 'live',
    dangerous: true,
    source: 'default',
    envVar: 'MODEL_OPENAI_BASE_URL',
    acceptsNull: false,
    updatedAt: null,
    constraints: { format: 'url' },
    secret: false,
    value: '',
    default: '',
  },
  {
    key: 'supervisor.model.provider',
    group: 'supervisor',
    label: 'Supervisor model provider',
    help: 'Which vendor the supervisor asks. Since #422 this SELECTS a credential rather than being paired with one: the key and the base URL come from the Model credentials section’s slot for the provider named here, so switching provider neither requires re-entering a key nor destroys the one you had.',
    type: 'enum',
    reload: 'live',
    dangerous: true,
    source: 'default',
    envVar: 'SUPERVISOR_MODEL_PROVIDER',
    acceptsNull: false,
    updatedAt: null,
    // The API takes these from SUPERVISOR_MODEL_PROVIDERS in
    // `supervisor/invocation/supervisor-model.config.ts`. The picker is
    // populated from this, never from a list in `apps/web`.
    constraints: { values: ['anthropic', 'openai'] },
    secret: false,
    value: 'anthropic',
    default: 'anthropic',
  },
  {
    key: 'supervisor.model.name',
    group: 'supervisor',
    label: 'Supervisor model name',
    help: 'Which model the supervisor asks. Unset leaves the key unbound.',
    type: 'string',
    reload: 'live',
    dangerous: false,
    source: 'env',
    envVar: 'SUPERVISOR_MODEL_NAME',
    acceptsNull: false,
    updatedAt: null,
    constraints: {},
    secret: false,
    value: 'claude-sonnet-4-5',
    default: '',
  },
  // The second consumer (#423, epic #419), in the state a deployment that has
  // never configured it is in: the provider at its default and the model name
  // EMPTY. That pair is the chat's off switch — there is no `chat.enabled` —
  // so a fixture that named a model here would make the inert default
  // untestable, which is the one state every deployment starts in.
  {
    key: 'chat.model.provider',
    group: 'chat',
    label: 'Chat model provider',
    help: 'Which vendor the steering chat asks, chosen independently of the supervisor. It SELECTS a credential rather than being paired with one.',
    type: 'enum',
    reload: 'live',
    dangerous: true,
    source: 'default',
    envVar: 'CHAT_MODEL_PROVIDER',
    acceptsNull: false,
    updatedAt: null,
    constraints: { values: ['anthropic', 'openai'] },
    secret: false,
    value: 'anthropic',
    default: 'anthropic',
  },
  {
    key: 'chat.model.name',
    group: 'chat',
    label: 'Chat model',
    help: 'Sent verbatim as the request’s model field. EMPTY IS THE CHAT’S OFF SWITCH: with no model named the chat is inert and reports itself unconfigured rather than failing at the first instruction.',
    type: 'string',
    reload: 'live',
    dangerous: true,
    source: 'default',
    envVar: 'CHAT_MODEL_NAME',
    acceptsNull: false,
    updatedAt: null,
    constraints: {},
    secret: false,
    value: '',
    default: '',
  },
  {
    // Not promoted to the Credentials tab: a timeout is not part of choosing
    // a model, so it stays a generated row — which is also what gives the
    // Chat group something to render beneath its signpost.
    key: 'chat.model.timeoutMs',
    group: 'chat',
    label: 'Chat model timeout (ms)',
    help: 'How long one chat turn may wait for the model before it is abandoned.',
    type: 'integer',
    reload: 'live',
    dangerous: false,
    source: 'default',
    envVar: 'CHAT_MODEL_TIMEOUT_MS',
    acceptsNull: false,
    updatedAt: null,
    constraints: { min: 1000, max: 55000 },
    secret: false,
    value: 30000,
    default: 30000,
  },
  {
    key: 'dispatch.hardSpendCeilingUsd',
    group: 'dispatch',
    label: 'Hard spend ceiling (USD)',
    // A STRING setting, so a malformed figure stays distinguishable from an
    // unset one. See `config/spendCeilings.ts` and the registry header.
    help: 'The most the factory may spend on runs per window, and the limit no trust grant may raise.',
    type: 'string',
    reload: 'next-unit',
    dangerous: true,
    source: 'database',
    envVar: 'OPIFEX_HARD_SPEND_CEILING_USD',
    acceptsNull: false,
    updatedAt: '2026-08-01T10:00:00.000Z',
    constraints: {},
    secret: false,
    value: '25',
    default: '',
  },
  {
    key: 'dispatch.hardSpendCeilingWindowDays',
    group: 'dispatch',
    label: 'Hard spend ceiling window (days)',
    help: 'The rolling window the ceiling is measured over.',
    type: 'integer',
    reload: 'next-unit',
    dangerous: true,
    source: 'default',
    envVar: 'OPIFEX_HARD_SPEND_CEILING_WINDOW_DAYS',
    acceptsNull: false,
    updatedAt: null,
    constraints: { min: 1 },
    secret: false,
    value: 30,
    default: 30,
  },
  {
    key: 'supervisor.hardSpendCeilingUsd',
    group: 'supervisor',
    label: 'Supervisor hard spend ceiling (USD)',
    help: 'The most supervision may spend per window, on the separately metered model key.',
    type: 'string',
    reload: 'next-unit',
    dangerous: true,
    source: 'default',
    envVar: 'SUPERVISOR_HARD_SPEND_CEILING_USD',
    acceptsNull: false,
    updatedAt: null,
    constraints: {},
    secret: false,
    value: '',
    default: '',
  },
  {
    key: 'supervisor.hardSpendCeilingWindowDays',
    group: 'supervisor',
    label: 'Supervisor ceiling window (days)',
    help: 'ONE day by default, because supervisor spend is near-constant per tick.',
    type: 'integer',
    reload: 'next-unit',
    dangerous: true,
    source: 'default',
    envVar: 'SUPERVISOR_HARD_SPEND_CEILING_WINDOW_DAYS',
    acceptsNull: false,
    updatedAt: null,
    constraints: { min: 1 },
    secret: false,
    value: 1,
    default: 1,
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
      // Four entries above carry `source: 'database'`; the count the API
      // reports is the same fact and must not contradict them.
      overriddenKeys: 4,
    },
    secretStorage: { configured: true },
    settings: OPERATOR_SETTINGS_FIXTURE,
    ...overrides,
  };
}
