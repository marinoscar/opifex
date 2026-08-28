import { z } from 'zod';

import { PERMISSION_MODES } from '../../runners/claude-code-local/claude-code-invocation';
import {
  DEFAULT_SUPERVISOR_MODEL_PROVIDER,
  PROVIDER_LABELS,
  SUPERVISOR_MODEL_PROVIDERS,
  modelApiKeyEnvVar,
  modelApiKeySettingKey,
  modelBaseUrlEnvVar,
  modelBaseUrlSettingKey,
  type ModelApiKeySettingKey,
  type ModelBaseUrlSettingKey,
} from '../../supervisor/invocation/supervisor-model.config';

// =============================================================================
// The operator settings registry (#335, epic #332)
// =============================================================================
//
// WHY THIS FILE EXISTS
// --------------------
// `common/schemas/user-settings-namespaces.schema.ts` opens with the argument
// this file is the system-settings half of: a shape hand-maintained in several
// places drifts, and the drift is silent. The operator-facing configuration is
// worse off than the user-facing one was, because it is not declared anywhere
// at all — an env var is read in `configuration.ts`, parsed there, defaulted
// there, and then re-defaulted at every call site with a `?? 3` that nothing
// checks against the first default.
//
// So every operator-managed key is declared exactly ONCE, here, with:
//
//   envVar   the environment variable it is read from today
//   schema   how the value is parsed and validated — see PARSING below
//   default  the value used when nothing is set
//   secret   whether the value must never be returned or logged in the clear
//   reload   when a change takes effect — see RELOAD SEMANTICS below
//   group    which section of the Control Center it belongs to
//   label    the human name for it
//   help     what it does and what changing it costs
//   dangerous  changing it can spend money, act outwardly, or widen a boundary
//
// The TypeScript type of every value is DERIVED from `schema` via `z.infer`
// (see `OperatorSettingValue`). There is deliberately no hand-written parallel
// type: a second declaration of the same shape is exactly the thing this file
// exists to prevent.
//
// PARSING LIVES HERE, AND THAT IS THE POINT
// -----------------------------------------
// A value arrives either as an environment string (`'true'`) or, from #336
// onward, as a database JSON value (`true`). Those must resolve to the SAME
// typed result, because today they do not: seven call sites compare
// `=== true` and one compares `!== 'false'`, so a JSON `true` reaching the
// first group reads as `false` and an env `'true'` reaching the second reads
// as `true`. Every schema below therefore accepts both forms and normalizes
// to one output type, and `operator-settings.registry.spec.ts` asserts the
// parity per key.
//
// RELOAD SEMANTICS: THREE VALUES, AND THE THIRD IS THE POINT
// ----------------------------------------------------------
//   'live'      Nothing anywhere holds a copy. The next read decides, and no
//               work in flight contradicts the new value.
//   'next-unit' The next read decides for work not yet started, but work
//               ALREADY in flight carries a copy of the old value — in an
//               armed timer, in a spawned process's argv, in a workspace's
//               git config, or as occupancy that a lowered ceiling cannot
//               retroactively shrink. Lowering CLAUDE_CODE_MAX_CONCURRENCY
//               from 4 to 1 does not kill three running agents.
//   'restart'   There is no read path that would see a change, or changing it
//               mid-process would corrupt state built under the old value.
//
// `reload` states the contract each key MUST have once its consumers read
// through `OperatorSettingsService`. For most keys that is what the consumer
// already does. For a few it is not YET: `github.*` is frozen in
// `GitHubHttpService`'s constructor until #341 resolves it per use, and the
// supervisor model settings are read by a provider factory until #344 binds
// the adapter unconditionally. Those issues
// exist BECAUSE the value declared here is the one an operator is owed; a key
// whose consumer cannot honour it is a bug in the consumer, not a licence to
// weaken the declaration. Keys where the freeze is inherent — not incidental —
// say `restart` and say why in `help`.
//
// WHAT IS DELIBERATELY ABSENT
// ---------------------------
// `POSTGRES_*`, `JWT_*`, `COOKIE_SECRET`, `GOOGLE_*`, AWS/S3, `OTEL_*`, ports
// and URLs, `LOG_LEVEL`, `DEVICE_*`, `STORAGE_*` and the VAPID key pair are
// out of scope for epic #332: they are set once and forgotten, and the
// database credential structurally cannot live in the database.
//
// The four hard spend ceilings — OPIFEX_HARD_SPEND_CEILING_USD,
// OPIFEX_HARD_SPEND_CEILING_WINDOW_DAYS, SUPERVISOR_HARD_SPEND_CEILING_USD and
// SUPERVISOR_HARD_SPEND_CEILING_WINDOW_DAYS — WERE absent for a different and
// much stronger reason, and are present now. Until #345 they were read from
// `process.env` into `readonly` fields with no setter anywhere, so that no
// runtime path to a higher ceiling existed at all: VISION §8, "a limit an agent
// can raise is not a limit". #345 made them managed keys deliberately, under
// ADR-0018 §6, which is where the reversal is argued — the guarantee moved from
// structural (no setter exists) to access-controlled (a setter exists and the
// agent provably cannot reach it), and that is a real downgrade, named as one.
// It was only defensible once BOTH containment barriers landed: #334's scrub of
// the agent subprocess's environment, and #346's refusal of non-interactive
// credentials on this write path. `operator-settings.registry.spec.ts` used to
// assert all four names were absent; it now asserts they are present AND marked
// `dangerous`, and says why it changed.
//
// =============================================================================

/** When a change to a setting takes effect. See the header. */
export const RELOAD_SEMANTICS = ['live', 'next-unit', 'restart'] as const;
export type ReloadSemantics = (typeof RELOAD_SEMANTICS)[number];

/** Which section of the Control Center a setting belongs to. */
export const OPERATOR_SETTING_GROUPS = [
  'github',
  'runner',
  'dispatch',
  'reconciler',
  // Model CREDENTIALS, one slot per provider — separate from `supervisor`
  // deliberately (#422). A credential belongs to a vendor; a consumer selects
  // a vendor. Filing the keys under the one consumer that exists today would
  // make the second consumer #419 adds look like a supervisor setting.
  'models',
  'supervisor',
  'promotion',
  'notifications',
] as const;
export type OperatorSettingGroup = (typeof OPERATOR_SETTING_GROUPS)[number];

/**
 * The shape of the value, for anything that has to render or generate one.
 *
 * Carried explicitly rather than reflected off the zod schema. Two consumers
 * need it and neither can introspect a `z.union(...).pipe(...)` reliably:
 * #348's settings sections, which must choose a control, and this module's own
 * parity spec, which generates a representative value per key so that adding a
 * key cannot quietly skip the parity assertion.
 */
export const OPERATOR_SETTING_KINDS = [
  'boolean',
  'integer',
  'string',
  'enum',
] as const;
export type OperatorSettingKind = (typeof OPERATOR_SETTING_KINDS)[number];

/** One managed key. See the file header for what each field means. */
export interface OperatorSettingDefinition<T> {
  readonly envVar: string;
  /**
   * A SUPERSEDED variable, still read when `envVar` is unset (#422).
   *
   * Not an alias for convenience. `SUPERVISOR_MODEL_API_KEY` is one of the
   * three keys that still requires a plain `.env` edit, because the
   * Credentials UI (#349) has not shipped — so a release that simply renamed
   * it would take the supervisor of every env-configured deployment offline at
   * the restart, silently, which is the one outcome #422 rules out. The
   * resolver reads it only after the new variable comes back unset, and warns
   * once naming the replacement.
   */
  readonly legacyEnvVar?: string;
  readonly kind: OperatorSettingKind;
  /** Whether `null` is a legal value distinct from "use the default". */
  readonly nullable: boolean;
  /** Accepts the env-string form AND the JSON form; outputs one typed value. */
  readonly schema: z.ZodType<T>;
  readonly default: T;
  readonly secret: boolean;
  readonly reload: ReloadSemantics;
  readonly group: OperatorSettingGroup;
  readonly label: string;
  readonly help: string;
  readonly dangerous?: boolean;
  readonly min?: number;
  readonly max?: number;
  readonly values?: readonly string[];
  /** For string settings, the shape the value has to have. */
  readonly format?: 'url' | 'email';
}

/** Any definition, for code that iterates the registry without caring about T. */
export type AnyOperatorSettingDefinition = OperatorSettingDefinition<unknown>;

// ---------------------------------------------------------------------------
// Schema builders
//
// Each one produces a schema whose INPUT is "an env string or the JSON form"
// and whose OUTPUT is a single settled type. Parity between the two input
// forms is a property of these six functions rather than of 39 hand-written
// schemas, which is why it can be asserted for every key at once.
// ---------------------------------------------------------------------------

/**
 * `true` | `false` | `'true'` | `'false'`, and nothing else.
 *
 * Case-sensitive and exact, which is not fussiness — it REPRODUCES both of
 * today's contradictory idioms exactly, and reconciles them. `configuration.ts`
 * compares `=== 'true'` for the eight switches that default off and
 * `!== 'false'` for `SUPERVISOR_STAND_DOWN_WHEN_BLOCKED`, which defaults on.
 * Under "anything unrecognized falls back to the declared default", `'TRUE'`,
 * `'yes'`, `'1'` and `''` resolve to false for the first group and true for the
 * second — the same values they resolve to today, from one rule instead of two.
 */
function booleanSetting(
  fields: Omit<
    OperatorSettingDefinition<boolean>,
    'kind' | 'schema' | 'nullable'
  >,
): OperatorSettingDefinition<boolean> {
  return {
    ...fields,
    kind: 'boolean',
    nullable: false,
    schema: z.union([
      z.boolean(),
      z
        .string()
        .trim()
        .pipe(z.enum(['true', 'false']))
        .transform((value) => value === 'true'),
    ]),
  };
}

/** A base-10 integer, as a number or as its decimal string. */
function integerBody(min?: number, max?: number): z.ZodType<number> {
  let checks = z.number().int();
  if (min !== undefined) checks = checks.min(min);
  if (max !== undefined) checks = checks.max(max);

  return z
    .union([
      z.number(),
      // Deliberately stricter than `parseInt`, which reads '10 agents' as 10
      // and 'lots' as NaN — and a NaN timeout is how a setting silently stops
      // being a setting. Anything not wholly an integer is rejected here and
      // falls back to the declared default with a warning.
      z
        .string()
        .trim()
        .regex(/^[+-]?\d+$/)
        .transform((value) => Number(value)),
    ])
    .pipe(checks);
}

function integerSetting(
  fields: Omit<
    OperatorSettingDefinition<number>,
    'kind' | 'schema' | 'nullable'
  >,
): OperatorSettingDefinition<number> {
  return {
    ...fields,
    kind: 'integer',
    nullable: false,
    schema: integerBody(fields.min, fields.max),
  };
}

/**
 * An integer, or `null` meaning "no ceiling".
 *
 * The env form of `null` is the literal string `'null'`. It has to have one:
 * an operator who sets `dispatch.maxConcurrent` in the UI and then clears it
 * must land back on `null`, and the epic's exit criteria say that must yield
 * "a number, then absent — never the string `'undefined'`". Absent env is not
 * that expression, because absent means "use the default" and for
 * `defaultTimeoutMinutes` the default is 60.
 */
function nullableIntegerSetting(
  fields: Omit<
    OperatorSettingDefinition<number | null>,
    'kind' | 'schema' | 'nullable'
  >,
): OperatorSettingDefinition<number | null> {
  return {
    ...fields,
    kind: 'integer',
    nullable: true,
    schema: z.union([
      z.null(),
      z.literal('null').transform(() => null),
      integerBody(fields.min, fields.max),
    ]),
  };
}

/**
 * A non-empty trimmed string.
 *
 * `allowEmpty` is for the keys where empty genuinely means "not configured" —
 * credentials and the fallback webhook — so that clearing one in the UI is
 * expressible rather than being swallowed as "use the default".
 */
function stringSetting(
  fields: Omit<
    OperatorSettingDefinition<string>,
    'kind' | 'schema' | 'nullable'
  > & { allowEmpty?: boolean; format?: 'url' | 'email' },
): OperatorSettingDefinition<string> {
  const { allowEmpty, format, ...rest } = fields;

  // Annotated with BOTH generics: a `z.ZodType<string>` defaults its input to
  // `unknown`, which then cannot be the target of `.pipe()` from a string.
  const formatted: z.ZodType<string, string> =
    format === 'url' ? z.url() : format === 'email' ? z.email() : z.string();

  const body: z.ZodType<string, string> = allowEmpty
    ? z.union([z.literal(''), formatted])
    : z.string().min(1).pipe(formatted);

  return {
    ...rest,
    format,
    kind: 'string',
    nullable: false,
    schema: z.string().trim().pipe(body),
  };
}

/** One of a closed set of strings. */
function enumSetting<const V extends readonly [string, ...string[]]>(
  fields: Omit<
    OperatorSettingDefinition<V[number]>,
    'kind' | 'schema' | 'nullable' | 'values'
  > & { values: V },
): OperatorSettingDefinition<V[number]> {
  return {
    ...fields,
    kind: 'enum',
    nullable: false,
    schema: z.string().trim().pipe(z.enum(fields.values)),
  };
}

// ---------------------------------------------------------------------------
// The model credential slots (#422, epic #419)
// ---------------------------------------------------------------------------

/**
 * The variable that used to hold the ONE model credential.
 *
 * Kept as `models.<default provider>.apiKey`'s `legacyEnvVar` rather than
 * deleted. See that field's own doc comment for why a rename alone would have
 * been a silent outage, and `legacy-model-settings.migration.ts` for the
 * matching treatment of the stored row, which is a harder problem because a
 * sealed row cannot simply be re-pointed.
 */
export const LEGACY_MODEL_API_KEY_ENV = 'SUPERVISOR_MODEL_API_KEY';

/** The same, for the base URL. */
export const LEGACY_MODEL_BASE_URL_ENV = 'SUPERVISOR_MODEL_BASE_URL';

/** One credential slot per provider, plus its endpoint. */
type ModelCredentialSettings = {
  [
    K in ModelApiKeySettingKey | ModelBaseUrlSettingKey
  ]: OperatorSettingDefinition<string>;
};

/**
 * Generate a credential slot for every provider there is an adapter for.
 *
 * GENERATED and not written out, which is the point rather than a convenience.
 * `supervisor-model.port.ts` says nothing outside `invocation/` may name a
 * model provider, and `test/governing/supervisor-provider-seam.spec.ts`
 * asserts it over the source — so two hand-written `models.anthropic.*` /
 * `models.openai.*` blocks here would be the settings layer growing its own
 * copy of the vendor list, which is the drift this whole file exists to
 * remove. Iterating `SUPERVISOR_MODEL_PROVIDERS` means a third adapter gets
 * its key field, its base-URL field, its env variables and its Control Center
 * card with no edit here at all.
 *
 * The LEGACY variables attach to the DEFAULT provider's slot only, and never
 * to both. `SUPERVISOR_MODEL_API_KEY` is a single ambiguous name and mapping
 * it onto every slot would put an Anthropic key in the OpenAI slot, so that
 * selecting OpenAI posts an `sk-ant-` credential to OpenAI — the exact
 * confusion this issue exists to remove, reintroduced by the compatibility
 * shim meant to smooth it over. The default provider is the one every
 * deployment configured before #392 is pointed at, so it is the arm that
 * covers essentially everybody; a deployment that set the old variable AND
 * selected a non-default provider is told so, by name, at boot
 * (`legacy-model-settings.migration.ts`).
 */
function modelCredentialSettings(): ModelCredentialSettings {
  const slots = {} as Record<string, OperatorSettingDefinition<string>>;

  for (const provider of SUPERVISOR_MODEL_PROVIDERS) {
    const vendor = PROVIDER_LABELS[provider];
    const isDefault = provider === DEFAULT_SUPERVISOR_MODEL_PROVIDER;

    slots[modelApiKeySettingKey(provider)] = stringSetting({
      envVar: modelApiKeyEnvVar(provider),
      ...(isDefault ? { legacyEnvVar: LEGACY_MODEL_API_KEY_ENV } : {}),
      default: '',
      allowEmpty: true,
      secret: true,
      // Live, as `supervisor.model.apiKey` was since #344: the adapter is
      // bound unconditionally and resolves the credential per call, so a key
      // saved in the Control Center answers the next invocation rather than
      // the next restart.
      reload: 'live',
      group: 'models',
      label: `${vendor} API key`,
      help:
        `A separately metered ${vendor} credential — NOT the subscription the ` +
        `agent authenticates with (ADR-0015). It is held independently of ` +
        `every other provider's key, so switching a consumer between vendors ` +
        `neither requires re-entering a credential nor destroys one. Empty ` +
        `means nothing can call ${vendor}, and each invocation that tries ` +
        `records that refusal in the decision log.`,
    });

    slots[modelBaseUrlSettingKey(provider)] = stringSetting({
      envVar: modelBaseUrlEnvVar(provider),
      ...(isDefault ? { legacyEnvVar: LEGACY_MODEL_BASE_URL_ENV } : {}),
      // EMPTY, not a host — #392's rule, now per provider. Empty means
      // "follow the provider", which is both the honest default and the only
      // way an operator can EXPRESS "follow it" after typing something here.
      default: '',
      allowEmpty: true,
      format: 'url',
      secret: false,
      reload: 'live',
      group: 'models',
      label: `${vendor} base URL`,
      dangerous: true,
      help:
        `Leave empty and ${vendor} is called at its own endpoint. Set it only ` +
        `for a proxy, a gateway or a test server: the ${vendor} API key above ` +
        `is sent to whatever host is named here. Naming a provider's own ` +
        `published host is treated as empty, so a deployment that pinned one ` +
        `before switching provider still reaches the right vendor.`,
    });
  }

  return slots as ModelCredentialSettings;
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

export const OPERATOR_SETTINGS = {
  // -------------------------------------------------------------------------
  // GitHub (epic #15)
  // -------------------------------------------------------------------------

  'github.token': stringSetting({
    envVar: 'GITHUB_TOKEN',
    default: '',
    allowEmpty: true,
    secret: true,
    // #341. Today the token is read once in `GitHubHttpService`'s constructor
    // (github-http.service.ts:83) while `RunWorkspaceService` reads it live
    // (run-workspace.service.ts:287,358) — so a rotation today applies to git
    // and not to the API, which is the single most confusing state this whole
    // epic has to fix.
    reload: 'live',
    group: 'github',
    label: 'GitHub token',
    help: 'A fine-grained personal access token (ADR-0001). Empty means GitHub is unconfigured: registration and the reconciler report it rather than the API refusing to boot. A rotation applies to the next API call and the next git command.',
  }),

  'github.writesEnabled': booleanSetting({
    envVar: 'GITHUB_WRITES_ENABLED',
    default: false,
    secret: false,
    // #341. Frozen at construction today (github-write.service.ts:79), which
    // is the epic's exit criterion "toggling writes actually changes behaviour
    // rather than logging as though it did".
    reload: 'live',
    group: 'github',
    label: 'GitHub writes enabled',
    dangerous: true,
    help: 'The global write kill switch. Off records what a write WOULD have done without performing it — VISION §12 requires the reconciler to observe for a week before it may act. Turning it on lets the factory change labels, comments and pull requests on real repositories.',
  }),

  'github.requestTimeoutMs': integerSetting({
    envVar: 'GITHUB_REQUEST_TIMEOUT_MS',
    default: 15_000,
    min: 1_000,
    max: 120_000,
    secret: false,
    reload: 'live',
    group: 'github',
    label: 'GitHub request timeout (ms)',
    help: 'How long a single GitHub API request may take before it is abandoned. Applies to the next request; a request already in flight keeps its own signal.',
  }),

  'github.maxRetries': integerSetting({
    envVar: 'GITHUB_MAX_RETRIES',
    default: 3,
    min: 0,
    max: 10,
    secret: false,
    reload: 'live',
    group: 'github',
    label: 'GitHub max retries',
    help: 'Retries for transient failures only — 5xx and timeouts. Rate-limit exhaustion is never retried into.',
  }),

  'github.rateLimitReserve': integerSetting({
    envVar: 'GITHUB_RATE_LIMIT_RESERVE',
    default: 100,
    min: 0,
    max: 5_000,
    secret: false,
    reload: 'live',
    group: 'github',
    label: 'Rate-limit reserve',
    help: 'Requests held back from the reconciler so your own interactive use keeps working — VISION §11 has automated runs competing with a human for one budget.',
  }),

  'github.etagCacheMaxEntries': integerSetting({
    envVar: 'GITHUB_ETAG_CACHE_MAX',
    default: 2_000,
    min: 1,
    max: 100_000,
    secret: false,
    // The cache is CONSTRUCTED at this size by a module factory
    // (github.module.ts:32) and its bound is a property of the data structure,
    // not of a read. Resizing a live cache is not the same operation as
    // building one, and pretending otherwise is how a bound silently stops
    // being enforced.
    reload: 'restart',
    group: 'github',
    label: 'ETag cache size',
    help: 'Bounds the in-memory conditional-request cache: roughly watched repositories x pollable resources x pages. The cache is built at this size when the process starts, so a change needs a restart.',
  }),

  'github.apiBaseUrl': stringSetting({
    envVar: 'GITHUB_API_BASE_URL',
    default: 'https://api.github.com',
    format: 'url',
    secret: false,
    // The ETag cache is keyed by PATH, not by host. Swapping hosts inside a
    // live process would replay one host's ETags against another and receive
    // 304s for resources it has never read — a cache returning another
    // server's answers, which is worse than a stale one.
    reload: 'restart',
    group: 'github',
    label: 'GitHub API base URL',
    dangerous: true,
    help: 'For GitHub Enterprise, or a proxy. Requires a restart: the ETag cache is keyed by path rather than by host, so changing hosts in a running process would replay one host’s ETags against another. Note that the GitHub token is sent to whatever host is named here.',
  }),

  'github.userAgent': stringSetting({
    envVar: 'GITHUB_USER_AGENT',
    default: 'opifex',
    secret: false,
    reload: 'live',
    group: 'github',
    label: 'GitHub User-Agent',
    help: 'GitHub rejects requests without a User-Agent. Identifies this deployment in GitHub’s own logs.',
  }),

  // -------------------------------------------------------------------------
  // The claude-code-local runner (epic #18, #61, ADR-0008)
  // -------------------------------------------------------------------------

  'runners.claudeCodeLocal.oauthToken': stringSetting({
    envVar: 'CLAUDE_CODE_OAUTH_TOKEN',
    default: '',
    allowEmpty: true,
    secret: true,
    // The CLI authenticates from the environment it is spawned with
    // (claude-code-invocation.ts `buildInvocationEnv`: the child inherits
    // `process.env` for "whatever authenticates the CLI"). A rotation reaches
    // the next spawn; an agent already running holds the credential it
    // started with and cannot be handed a new one.
    reload: 'next-unit',
    group: 'runner',
    label: 'Claude subscription token',
    help: 'Use Connect Claude account on the Credentials section (#386) — it runs `claude setup-token` for you on a pseudo-terminal and seals the result here, so there is no shell to get into and nothing to copy by hand. Automated runs compete with your own interactive use for one subscription quota (VISION §11) — the concurrency ceiling below is what leaves you room. Empty means the runner is unauthenticated and every dispatch fails at spawn. A rotation applies to the next agent started, not to agents already running.',
  }),

  'runners.claudeCodeLocal.enabled': booleanSetting({
    envVar: 'CLAUDE_CODE_LOCAL_ENABLED',
    default: false,
    secret: false,
    // A gate, read at the moment it gates: registration refreshes
    // (runner-registration.service.ts), the dispatch admission path, and the
    // poll tick — which since #343 registers its interval unconditionally is
    // reachable by the same flip as the other two, rather than admitting work
    // no poller exists to conclude. Nothing holds a copy: turning it off makes
    // the runner undispatchable at once, though agents already running are not
    // killed by it.
    reload: 'live',
    group: 'runner',
    label: 'Local Claude Code runner enabled',
    dangerous: true,
    help: 'Whether this runner is dispatchable at all. Turning it on lets the control plane spawn Claude Code processes on this machine, which spends real subscription quota. Turning it off stops new dispatches immediately and leaves agents already running alone.',
  }),

  'runners.claudeCodeLocal.binary': stringSetting({
    envVar: 'CLAUDE_CODE_BINARY',
    default: 'claude',
    secret: false,
    // Read per spawn and per version probe (claude-code-local.runner.ts:776).
    // A process already spawned obviously keeps the binary it was spawned
    // from.
    reload: 'next-unit',
    group: 'runner',
    label: 'Claude Code binary',
    dangerous: true,
    help: 'Resolved on PATH unless an absolute path is given; name it explicitly to pin a version. This is the executable the control plane runs — treat changing it as equivalent to granting code execution on this host.',
  }),

  'runners.claudeCodeLocal.maxConcurrency': integerSetting({
    envVar: 'CLAUDE_CODE_MAX_CONCURRENCY',
    default: 2,
    min: 1,
    max: 32,
    secret: false,
    // claude-code-local.runner.ts:130 reads it as the ceiling on ACCEPTING a
    // submission. Lowering it from 4 to 1 does not kill three running agents;
    // it stops the fourth from starting. That gap is exactly what 'next-unit'
    // exists to say out loud.
    reload: 'next-unit',
    group: 'runner',
    label: 'Max concurrent agents',
    help: 'How many Claude Code processes may run at once on this machine. VISION §11: automated runs share one subscription quota with your interactive use. Lowering this does not stop agents already running — it stops the next one from starting.',
  }),

  'runners.claudeCodeLocal.permissionMode': enumSetting({
    envVar: 'CLAUDE_CODE_PERMISSION_MODE',
    // The single declaration of the legal modes lives in
    // `claude-code-invocation.ts`, next to the argv it is written into.
    // Re-listing them here would be the second declaration point this file
    // exists to argue against.
    values: PERMISSION_MODES,
    default: 'acceptEdits',
    secret: false,
    // Read per spawn to build argv (claude-code-local.runner.ts:172, 810), so
    // a running agent keeps the mode it was launched under.
    reload: 'next-unit',
    group: 'runner',
    label: 'Permission mode',
    dangerous: true,
    help: 'How much the agent may do without asking. `acceptEdits` is the narrow end and the default: a mode broad enough never to ask is only safe behind a sandbox, and sandboxing is #113. Applies to the next agent started.',
  }),

  // ---------------------------------------------------------------------
  // The tier -> model mapping (#420, epic #419)
  //
  // WHY THESE ARE SETTINGS AND NOT A CONSTANT
  // -----------------------------------------
  // `tier:small|standard|large` is a POLICY vocabulary — "small work uses the
  // cheap model" — and which model satisfies that policy moves as models ship,
  // on Anthropic's schedule rather than this repository's. A constant in the
  // runner would make adopting a newly released cheap model a code change, a
  // build and a deploy, for a decision that is entirely the operator's: they
  // are the ones who know what their subscription includes and what their
  // spend looks like. Three keys is the whole cost, and `permissionMode` and
  // `binary` — the two other values that end up in the same argv — are already
  // keys here for the same reason.
  //
  // WHY FULL MODEL NAMES AND NOT `haiku` / `sonnet` / `opus`
  // -------------------------------------------------------
  // The CLI accepts either (`claude --help`, 2.1.243). An alias would never rot
  // into an invalid id, which is a real advantage — but an alias silently
  // repoints, and these tiers exist to BOUND SPEND. `model-pricing.ts` makes
  // the same argument for the same reason and refuses to key a rate on a
  // moving alias: a value that changes what it means without changing what it
  // says is exactly what makes a cost control stop controlling. A pinned name
  // that is eventually retired fails LOUDLY, on the first dispatch of that
  // tier, with the CLI's own error on the run's `run.failed` event — and the
  // fix is a form field rather than a release, which is the other half of why
  // these are settings.
  //
  // THE DEFAULTS, AND HOW THEY WERE ESTABLISHED
  // -------------------------------------------
  // Checked 2026-08-28 against the model table compiled into `claude` 2.1.243
  // (the pinned CLI is 2.1.246), where these three are the CURRENT member of
  // each family — Opus 4.8 and Sonnet 4.6 are labelled "Previous version"
  // beside them — and cross-checked against `supervisor/invocation/model-
  // pricing.ts`, which prices all three. They form a strictly increasing cost
  // ladder ($1/$5, $2/$10, $5/$25 per million tokens), which is the property
  // that makes the tier vocabulary mean what it claims; the spec asserts it,
  // so a default edited to a model that breaks the ladder fails there.
  //
  // `standard` is deliberately NOT the same as declaring no tier. An untiered
  // work order is invoked with no `--model` at all and floats with whatever
  // the CLI defaults to; `tier:standard` PINS a model. The two happen to
  // resolve to the same model today, and that is a coincidence of this
  // release rather than a thing to simplify away.
  //
  // Empty means "this tier gets the CLI's own default", which is how an
  // operator expresses "I do not want a model pinned for this tier" in a
  // field that cannot hold null.
  // ---------------------------------------------------------------------

  'runners.claudeCodeLocal.model.small': stringSetting({
    envVar: 'CLAUDE_CODE_MODEL_SMALL',
    default: 'claude-haiku-4-5',
    allowEmpty: true,
    secret: false,
    // Written into argv at spawn (claude-code-local.runner.ts), like
    // `permissionMode`, so an agent already running keeps the model it was
    // launched on.
    reload: 'next-unit',
    group: 'runner',
    label: 'Model for tier:small',
    dangerous: true,
    help: 'The model a work order labelled `tier:small` runs on. An alias (`haiku`) or a full name (`claude-haiku-4-5`) — a full name by default, so the tier keeps meaning one thing across a release that repoints the alias. Leave it empty to let the CLI choose for this tier. Changing it changes what every small work order costs.',
  }),

  'runners.claudeCodeLocal.model.standard': stringSetting({
    envVar: 'CLAUDE_CODE_MODEL_STANDARD',
    default: 'claude-sonnet-5',
    allowEmpty: true,
    secret: false,
    reload: 'next-unit',
    group: 'runner',
    label: 'Model for tier:standard',
    dangerous: true,
    help: 'The model a work order labelled `tier:standard` runs on. Note that this is NOT the same as a work order with no tier: an untiered one is invoked with no model flag and follows the CLI’s own default, while `tier:standard` pins this value. Leave it empty to make the two behave alike.',
  }),

  'runners.claudeCodeLocal.model.large': stringSetting({
    envVar: 'CLAUDE_CODE_MODEL_LARGE',
    default: 'claude-opus-5',
    allowEmpty: true,
    secret: false,
    reload: 'next-unit',
    group: 'runner',
    label: 'Model for tier:large',
    dangerous: true,
    help: 'The model a work order labelled `tier:large` runs on. The most expensive of the three by design — VISION §11 has these runs sharing one subscription quota with your interactive use, so a tier pointed at a bigger model spends that quota faster. Leave it empty to let the CLI choose for this tier.',
  }),

  'runners.claudeCodeLocal.workspaceRoot': stringSetting({
    envVar: 'RUNNER_WORKSPACE_ROOT',
    default: '/var/tmp/opifex/workspaces',
    secret: false,
    // `RunWorkspaceService` re-reads this per call (run-workspace.service.ts:72),
    // so it would APPEAR live — which is precisely the trap. Every live run's
    // directory sits under the old root, and the reaper looks under the new
    // one: the change orphans running work rather than moving it.
    reload: 'restart',
    group: 'runner',
    label: 'Workspace root',
    dangerous: true,
    help: 'One directory per work order lives under here, and the reaper DELETES directories beneath it. Requires a restart: changing it while runs are live orphans their workspaces where nothing can find or clean them.',
  }),

  'runners.claudeCodeLocal.committerName': stringSetting({
    envVar: 'RUNNER_COMMITTER_NAME',
    default: 'Opifex Factory',
    secret: false,
    // Written into a workspace's local git config when the workspace is set up
    // (run-workspace.service.ts:321). A run already set up keeps the identity
    // its clone was configured with.
    reload: 'next-unit',
    group: 'runner',
    label: 'Committer name',
    help: 'The factory’s own commit identity, not any person’s — attribution proper lives in the commit trailers (#26), which are structured and cannot be mistaken for a human having written the code.',
  }),

  'runners.claudeCodeLocal.committerEmail': stringSetting({
    envVar: 'RUNNER_COMMITTER_EMAIL',
    default: 'factory@opifex.local',
    format: 'email',
    secret: false,
    reload: 'next-unit',
    group: 'runner',
    label: 'Committer email',
    help: 'Written into each workspace’s local git config at setup. Without an identity `git commit` fails deep inside the agent, where the reason arrives as an opaque non-zero exit.',
  }),

  'runners.claudeCodeLocal.defaultTimeoutMinutes': nullableIntegerSetting({
    envVar: 'RUNNER_DEFAULT_TIMEOUT_MINUTES',
    default: 60,
    min: 1,
    max: 24 * 60,
    secret: false,
    // The authoritative timer is ARMED at submit with a copy of this value
    // (claude-code-local.runner.ts:191 -> armDeadline:436), and an armed timer
    // does not move. See `help` for the control-plane sweep, which does re-read
    // it — the honest summary is that lowering this cannot shorten a running
    // agent's own timer but can still get the run cancelled from outside.
    reload: 'next-unit',
    group: 'runner',
    label: 'Default run timeout (minutes)',
    help: 'The wall-clock ceiling for a work order that names none. `null` means genuinely unbounded, which is a deliberate choice: VISION §1’s origin story is four hours dead, and that is what an unbounded run looks like when it wedges. A run already started keeps the deadline it was armed with — though the control-plane sweep re-reads this each poll tick, so lowering it can still cancel a run that is already over the new ceiling.',
  }),

  'runners.deadlineGraceMinutes': integerSetting({
    envVar: 'RUNNER_DEADLINE_GRACE_MINUTES',
    default: 2,
    min: 0,
    max: 120,
    secret: false,
    // Read once per poll tick and applied to live runs
    // (run-poller.service.ts:427). Nothing holds a copy of it at all.
    reload: 'live',
    group: 'runner',
    label: 'Deadline grace (minutes)',
    help: 'How long past a run’s own ceiling before the CONTROL PLANE cancels it (#180). A margin rather than zero, so this is a backstop and not a race with the runner’s own timer. Applied on the next poll tick, including to runs already in flight.',
  }),

  'runners.claudeCodeLocal.killGraceMs': integerSetting({
    envVar: 'RUNNER_KILL_GRACE_MS',
    default: 10_000,
    min: 0,
    max: 300_000,
    secret: false,
    // Handed to the supervisor at spawn (claude-code-local.runner.ts:178), so
    // the value a process will be killed under is fixed when it starts.
    reload: 'next-unit',
    group: 'runner',
    label: 'Kill grace (ms)',
    help: 'How long a SIGTERMed agent has to flush before SIGKILL. Fixed for each process when it is spawned.',
  }),

  'runners.claudeCodeLocal.gitBinary': stringSetting({
    envVar: 'GIT_BINARY',
    default: 'git',
    secret: false,
    // Unlike `binary`, this one is resolved afresh for EVERY git invocation
    // (run-workspace.service.ts:347), including the clone, the committer
    // config and the push of a run already in progress. Nothing carries a
    // copy, so 'live' is what is true — and `dangerous` is what makes that
    // uncomfortable fact visible rather than reassuring.
    reload: 'live',
    group: 'runner',
    label: 'Git binary',
    dangerous: true,
    help: 'The git executable used for clone, commit and push. Resolved for every git command, so a change takes effect inside runs already in progress. This is an executable path — treat changing it as granting code execution on this host.',
  }),

  'runners.claudeCodeLocal.gitRemoteBaseUrl': stringSetting({
    envVar: 'GIT_REMOTE_BASE_URL',
    default: 'https://github.com',
    format: 'url',
    secret: false,
    // Read when the remote URL is built for a clone
    // (run-workspace.service.ts:340) and then written into that workspace's
    // git config, so a live run keeps pushing where it cloned from.
    reload: 'next-unit',
    group: 'runner',
    label: 'Git remote base URL',
    dangerous: true,
    help: 'Where workspaces clone from and push to — for GitHub Enterprise, or a local fixture in tests. The GitHub token is sent to whatever host is named here. Workspaces already cloned keep the remote they were created with.',
  }),

  // -------------------------------------------------------------------------
  // Dispatch (epic #18, #64)
  // -------------------------------------------------------------------------

  'dispatch.enabled': booleanSetting({
    envVar: 'DISPATCH_ENABLED',
    default: false,
    secret: false,
    // A gate evaluated at the moment of the decision
    // (run-executor.service.ts:272, fleet-state.service.ts:496). No copy is
    // held anywhere; the next tick decides.
    reload: 'live',
    group: 'dispatch',
    label: 'Dispatch enabled',
    dangerous: true,
    help: 'The switch that lets the factory actually spend money. Off, the executor still runs the whole decision and records what it WOULD have dispatched — VISION §12’s observation posture applied to execution. On, the next tick starts real agents against a real subscription, and starting one is not reversible.',
  }),

  'dispatch.maxConcurrent': nullableIntegerSetting({
    envVar: 'DISPATCH_MAX_CONCURRENT',
    default: null,
    min: 1,
    max: 128,
    secret: false,
    // Read per dispatch decision (dispatch.service.ts:96) and compared against
    // runs already live — so a lowered ceiling is immediately BINDING on new
    // work while existing work is over it. That gap is 'next-unit'.
    reload: 'next-unit',
    group: 'dispatch',
    label: 'Fleet concurrency ceiling',
    help: 'A ceiling across the whole fleet, on top of each runner’s own limit. `null` means no global ceiling. Lowering it below the number of runs already live does not stop them; it stops the next dispatch until the count falls back under it.',
  }),

  'dispatch.allowPreviewRunner': booleanSetting({
    envVar: 'DISPATCH_ALLOW_PREVIEW_RUNNER',
    default: false,
    secret: false,
    // Read per dispatch decision (dispatch.service.ts:99); nothing holds a
    // copy.
    reload: 'live',
    group: 'dispatch',
    label: 'Allow preview-tier runner',
    dangerous: true,
    help: 'Lets a preview-tier runner be load-bearing when no GA fallback exists (ADR-0007). With a single runner the fallback cannot exist, so without this every work order queues forever. It is a safety rule’s bypass — turn it back off once a GA runner exists.',
  }),

  'dispatch.retryCeiling': integerSetting({
    envVar: 'DISPATCH_RETRY_CEILING',
    default: 3,
    min: 1,
    max: 20,
    secret: false,
    // #342. The reconciler used to read this once in its CONSTRUCTOR, with a
    // real reason: the projection is pure and a value that changed mid-tick
    // would make two identical observations produce different desired states.
    // It is now snapshotted once per TICK (`ReconcilerService.snapshotSettings`),
    // which keeps that reason and still lets the next tick see a change —
    // `RunSummaryService` reads the same key live, so the two agree to within
    // one tick interval rather than until the next restart.
    reload: 'live',
    group: 'dispatch',
    label: 'Attempts per work order',
    help: 'How many attempts a work order gets before it is quarantined (#66). Three is deliberately low: VISION §10 reads a rising attempt count as evidence of bad decomposition, and a generous ceiling hides exactly that signal. Snapshotted once per reconciler tick, so a change never takes effect halfway through one.',
  }),

  // -------------------------------------------------------------------------
  // The dispatch hard spend ceiling (#65, #345, ADR-0018 §6)
  //
  // These two were absent from this registry on purpose until #345, and the
  // header above still says what the absence was protecting. What changed is
  // NOT the risk — ADR-0018 §6 is explicit that "both were right about the
  // risk they were defending against, and nothing about that risk has
  // changed" — but which guarantee holds it off. It was structural: no setter
  // existed anywhere in the process, for anyone, so there was nothing inside
  // the process to compromise. It is now access-controlled: the only write
  // path is `PATCH /api/operator-settings`, which needs `system_settings:write`
  // AND an interactive session — #346 refuses a personal access token or a
  // device token whatever permissions it carries — while the agent subprocess
  // inherits no credential to authenticate with in the first place (#334).
  // Both barriers are preconditions of this decision, not defence in depth:
  // ADR-0018 §6 says either one missing invalidates it rather than merely
  // weakening it.
  //
  // WHY THE DOLLAR FIGURE IS DECLARED AS A STRING AND NOT A NUMBER
  //
  // `parseHardCeiling` distinguishes THREE states where a number can carry
  // only two: a figure, an UNSET ceiling, and a MALFORMED one — a value
  // somebody set and mistyped. The third is the operator-facing signal the
  // whole mechanism turns on. Unset and malformed both refuse to spend, and
  // only one of them means somebody believed they had set a limit, so the
  // refusal quotes the offending text back at them. A numeric schema here
  // would reject `50O` at the registry, resolve the key to its default, and
  // replace that text with "expected number" — trading the most specific
  // diagnostic in the system for a generic one, and collapsing malformed into
  // unset at exactly the layer built to keep them apart. So the registry
  // carries the raw string and `parseHardCeiling` stays the single parser of
  // record. It is the one key shape here that deliberately validates less than
  // it could, and `hard-spend-ceiling.ts` is where the validation lives.
  // -------------------------------------------------------------------------

  'dispatch.hardSpendCeilingUsd': stringSetting({
    envVar: 'OPIFEX_HARD_SPEND_CEILING_USD',
    default: '',
    allowEmpty: true,
    secret: false,
    // `HardSpendCeilingService` holds no boot-time copy since #345 — it
    // re-reads on every change this service announces. What a lowered ceiling
    // cannot do is stop a run that is already spending, because the gate is at
    // admission and a dispatched agent is not recalled. That gap is
    // 'next-unit', the same one `dispatch.maxConcurrent` declares.
    reload: 'next-unit',
    group: 'dispatch',
    label: 'Hard spend ceiling (USD)',
    dangerous: true,
    help: 'The most the factory may spend on runs per window, and the limit no trust grant may raise (VISION §8). Empty means NO ceiling is configured, which refuses every dispatch rather than permitting unlimited spend — an unset ceiling is not an unlimited one. Anything that is not a non-negative number is reported as malformed and also refuses, because somebody who mistyped a ceiling believes they set one. Lowering it binds the next dispatch, not a run already under way.',
  }),

  'dispatch.hardSpendCeilingWindowDays': integerSetting({
    envVar: 'OPIFEX_HARD_SPEND_CEILING_WINDOW_DAYS',
    // `DEFAULT_CEILING_WINDOW_DAYS`. Not imported: `hard-spend-ceiling.ts`
    // reads this registry through `OperatorSettingsService`, so importing its
    // constant back into the registry would close an import cycle through the
    // resolver. `operator-settings.registry.spec.ts` pins the two together
    // instead, which is drift-proof without the cycle.
    default: 30,
    // No maximum, matching `positiveIntOr`: any positive integer is a window
    // somebody may mean, and a cap here would silently substitute 30 for a
    // deliberate 400 rather than refusing it.
    min: 1,
    secret: false,
    reload: 'next-unit',
    group: 'dispatch',
    label: 'Hard spend ceiling window (days)',
    dangerous: true,
    help: 'The rolling window the ceiling is measured over. Thirty days by default, because a ceiling with no window is a lifetime cap that stops the factory permanently the first time it is reached and can only be recovered from by raising the limit. Shortening the window makes the same figure permit more spend per month, so it is as much a budget change as the figure is.',
  }),

  // -------------------------------------------------------------------------
  // Reconciler (epic #16)
  // -------------------------------------------------------------------------

  'reconciler.enabled': booleanSetting({
    envVar: 'RECONCILER_ENABLED',
    default: false,
    secret: false,
    // Read per tick, in two places: `ReconcilerTask.runOnce` gates the whole
    // loop on it, and `reconciler.service.ts` records `skipped-disabled`
    // behind it. The interval itself is registered unconditionally (#343), so
    // nothing holds a boot-time copy of this.
    reload: 'live',
    group: 'reconciler',
    label: 'Reconciler enabled',
    help: 'Whether the reconcile tick observes GitHub and projects desired state. Off, nothing is polled and no rate-limit budget is spent. The next tick honours a change.',
  }),

  'reconciler.intervalMs': integerSetting({
    envVar: 'RECONCILER_INTERVAL_MS',
    default: 60_000,
    min: 5_000,
    max: 3_600_000,
    secret: false,
    // `setInterval` fixes its period at the call that created it, so this is
    // the one key here a check inside the callback cannot honour. #343 makes
    // `ReconcilerTask` subscribe to `onChange` and delete/re-register the
    // named interval when this moves, behind an in-process mutex — so it is
    // live, at the cost of the machinery that key alone needs.
    reload: 'live',
    group: 'reconciler',
    label: 'Reconcile interval (ms)',
    help: 'How often the tick runs. VISION §13: start with polling, add webhooks only when tick latency demonstrably hurts. With ETags an unchanged repository costs no rate-limit budget. A change re-registers the timer, so it takes effect from the next tick — one tick may still fire on the old period, and a tick already running is left alone to finish.',
  }),

  'reconciler.logRetentionDays': integerSetting({
    envVar: 'RECONCILER_LOG_RETENTION_DAYS',
    default: 14,
    min: 1,
    max: 365,
    secret: false,
    // Read inside the daily cleanup run (reconcile-log.cleanup.task.ts:30).
    reload: 'live',
    group: 'reconciler',
    label: 'Tick log retention (days)',
    help: 'How long tick records are kept. Deliberately longer than VISION §12’s one-week observation window, so the week is still fully reviewable on the day it ends rather than half-pruned. The next nightly prune uses the new value.',
  }),

  // -------------------------------------------------------------------------
  // Model credentials, one slot per provider (#422, epic #419)
  //
  // Spread rather than written out: see `modelCredentialSettings` for why the
  // settings layer must not contain a hand-maintained vendor list.
  // -------------------------------------------------------------------------

  ...modelCredentialSettings(),

  // -------------------------------------------------------------------------
  // The supervisor (epic #21, #89, ADR-0015)
  // -------------------------------------------------------------------------

  'supervisor.enabled': booleanSetting({
    envVar: 'SUPERVISOR_ENABLED',
    default: false,
    secret: false,
    // Read per invocation (supervisor.service.ts:293) and per daily brief
    // (daily-brief.task.ts:37).
    reload: 'live',
    group: 'supervisor',
    label: 'Supervisor enabled',
    dangerous: true,
    help: 'Whether the AI supervisor runs. Since ADR-0015 it spends real money on a separately metered API key, so a deployment that has not decided to run one must not start spending because a default said yes. The next invocation honours a change.',
  }),

  'supervisor.model.provider': enumSetting({
    envVar: 'SUPERVISOR_MODEL_PROVIDER',
    // The single declaration of the legal providers lives in
    // `supervisor/invocation/supervisor-model.config.ts`, next to the adapters
    // that implement them, exactly as `permissionMode` above takes its values
    // from the file that writes them into argv. Restating them here would make
    // this registry a second place that names a model vendor, which is the one
    // thing `supervisor-model.port.ts` says must not happen.
    values: SUPERVISOR_MODEL_PROVIDERS,
    default: DEFAULT_SUPERVISOR_MODEL_PROVIDER,
    secret: false,
    // Resolved per call inside the adapter (#344, #392), so a provider changed
    // in the Control Center answers the next invocation rather than the next
    // restart.
    reload: 'live',
    group: 'supervisor',
    label: 'Supervisor model provider',
    dangerous: true,
    help: 'Which vendor the supervisor asks. Since #422 this SELECTS a credential rather than being paired with one: the key and the base URL come from the Model credentials section’s slot for the provider named here, so switching provider neither requires re-entering a key nor destroys the one you had. It is still marked dangerous because it changes which vendor is billed, and because selecting a provider you have not given a key to leaves the supervisor with nothing to ask. The next invocation honours a change.',
  }),

  'supervisor.model.name': stringSetting({
    envVar: 'SUPERVISOR_MODEL_NAME',
    default: '',
    allowEmpty: true,
    secret: false,
    reload: 'live',
    group: 'supervisor',
    label: 'Supervisor model',
    help: 'Sent verbatim as the request’s `model` field and recorded verbatim against the invocation — a literal catalogue entry rather than a tier, so the log says which model actually answered. A key set with no model named is a half-configured deployment, and each invocation reports it as one.',
  }),

  'supervisor.model.timeoutMs': integerSetting({
    envVar: 'SUPERVISOR_MODEL_TIMEOUT_MS',
    default: 60_000,
    min: 1_000,
    max: 600_000,
    secret: false,
    reload: 'live',
    group: 'supervisor',
    label: 'Supervisor model timeout (ms)',
    help: 'Generous next to GitHub’s 15s: this is a model generating tokens, not an API returning a row. Applies to the next invocation.',
  }),

  'supervisor.model.defaultMaxTokens': integerSetting({
    envVar: 'SUPERVISOR_MODEL_DEFAULT_MAX_TOKENS',
    default: 1_024,
    min: 1,
    max: 200_000,
    secret: false,
    reload: 'live',
    group: 'supervisor',
    label: 'Supervisor default max tokens',
    help: 'Anthropic requires `max_tokens` on every request. Used only when the proposer does not set its own ceiling.',
  }),

  'supervisor.logSkippedInvocations': booleanSetting({
    envVar: 'SUPERVISOR_LOG_SKIPPED_INVOCATIONS',
    default: false,
    secret: false,
    // Read per scheduled invocation (supervisor.task.ts:63).
    reload: 'live',
    group: 'supervisor',
    label: 'Log skipped invocations',
    help: 'Whether a disabled supervisor still writes a `skipped_disabled` row each hour. Off by default: the decision log must have no gaps while a supervisor is meant to be running, but a deployment that never configured one should not accumulate a skip row an hour forever.',
  }),

  'supervisor.standDownWhenBlocked': booleanSetting({
    envVar: 'SUPERVISOR_STAND_DOWN_WHEN_BLOCKED',
    // The ONE setting here that defaults on, and therefore the one whose env
    // form is compared `!== 'false'` today rather than `=== 'true'`. The
    // registry's single boolean rule reproduces both — see `booleanSetting`.
    default: true,
    secret: false,
    // Read per invocation (supervisor.service.ts:299).
    reload: 'live',
    group: 'supervisor',
    label: 'Stand down while runs are blocked',
    help: 'Skip supervisor invocations while any run is parked on a rate limit. A parked worker is evidence that everything the supervisor exists to advise about has stopped moving, and diagnosis nobody can act on is worth waiting on.',
  }),

  // -------------------------------------------------------------------------
  // The supervisor's own hard spend ceiling (#261, #345, ADR-0017, ADR-0018 §6)
  //
  // A SECOND ceiling, deliberately, and ADR-0017 argues why at length: folding
  // supervisor spend into the dispatch figure would stand the supervisor down
  // once workers had spent close to it, which is precisely the moment the one
  // component whose job is noticing unusual spend needs to be running. The
  // access-control argument above applies here unchanged.
  // -------------------------------------------------------------------------

  'supervisor.hardSpendCeilingUsd': stringSetting({
    envVar: 'SUPERVISOR_HARD_SPEND_CEILING_USD',
    default: '',
    allowEmpty: true,
    secret: false,
    // Checked between proposers inside `SupervisorService.invoke()`, so a
    // lowered ceiling stops the next proposer rather than the one already
    // talking to the model.
    reload: 'next-unit',
    group: 'supervisor',
    label: 'Supervisor hard spend ceiling (USD)',
    dangerous: true,
    help: 'The most supervision may spend per window, on the separately metered model key (ADR-0015). Empty means no ceiling is configured, and the supervisor then does not run at all: every tick records a skipped_budget row instead. That is the hole #261 closed, not a regression — SUPERVISOR_ENABLED plus a model key used to be sufficient to spend without limit. Separate from the dispatch ceiling on purpose, so a busy factory cannot silence the thing watching it spend.',
  }),

  'supervisor.hardSpendCeilingWindowDays': integerSetting({
    envVar: 'SUPERVISOR_HARD_SPEND_CEILING_WINDOW_DAYS',
    // `DEFAULT_SUPERVISOR_CEILING_WINDOW_DAYS`, pinned in the registry spec
    // rather than imported — see the dispatch window above for why.
    default: 1,
    min: 1,
    secret: false,
    reload: 'next-unit',
    group: 'supervisor',
    label: 'Supervisor ceiling window (days)',
    dangerous: true,
    help: 'ONE day by default, where the dispatch ceiling defaults to thirty, because supervisor spend is near-constant per tick and set almost entirely by which model SUPERVISOR_MODEL_NAME names. A month-long window would be slow to catch a switch to a model fifteen times the rate, and slow to recover — leaving the supervisor dark for up to a month is the "absent when things are going wrong" failure this ceiling exists to avoid, self-inflicted.',
  }),

  // -------------------------------------------------------------------------
  // The promotion ladder (epic #22, #99)
  // -------------------------------------------------------------------------

  'promotion.enabled': booleanSetting({
    envVar: 'PROMOTION_LADDER_ENABLED',
    default: false,
    secret: false,
    // Read per evaluation (promotion.service.ts:273).
    reload: 'live',
    group: 'promotion',
    label: 'Promotion ladder enabled',
    dangerous: true,
    help: 'VISION §7, earned autonomy: the ladder is what eventually decides a class of action may run without being asked. Off is PAUSED, not revoked — existing trust grants are left exactly as they are, because a pause that mass-revoked would never be used twice.',
  }),

  // -------------------------------------------------------------------------
  // Notifications (epic #17, #58)
  //
  // The VAPID key pair is deliberately NOT here. It is generated once with
  // `npx web-push generate-vapid-keys` and never rotated in normal operation,
  // and rotating it invalidates every existing device subscription — which is
  // a migration, not a setting.
  // -------------------------------------------------------------------------

  'notifications.receiptTimeoutMs': integerSetting({
    envVar: 'NOTIFY_RECEIPT_TIMEOUT_MS',
    default: 120_000,
    min: 1_000,
    max: 3_600_000,
    secret: false,
    // Read per overdue sweep (escalation-dispatcher.service.ts:334).
    reload: 'live',
    group: 'notifications',
    label: 'Delivery receipt timeout (ms)',
    help: 'How long a dispatched escalation may go without a device receipt before it is treated as undelivered. Web Push gives no delivery guarantee — a 201 means the push service ACCEPTED the message, not that a phone showed it, and an escalation that silently failed to send is indistinguishable from no escalation (#58).',
  }),

  'notifications.fallbackWebhookUrl': stringSetting({
    envVar: 'NOTIFY_FALLBACK_WEBHOOK_URL',
    default: '',
    allowEmpty: true,
    format: 'url',
    secret: false,
    reload: 'live',
    group: 'notifications',
    label: 'Fallback webhook URL',
    dangerous: true,
    help: 'A second, independent delivery path, used only when Web Push could not deliver — #58: "a delivery failure must itself escalate through a different path." A generic POST, so ntfy, a chat webhook or anything accepting JSON works. It sends escalation text to a third party, so it is empty unless you set it.',
  }),
} satisfies Record<string, AnyOperatorSettingDefinition>;

// ---------------------------------------------------------------------------
// Derived types and lookups
// ---------------------------------------------------------------------------

/** Every managed key. */
export type OperatorSettingKey = keyof typeof OPERATOR_SETTINGS;

/**
 * The resolved type of one key, DERIVED from its zod schema.
 *
 * There is no hand-written table of key -> type anywhere, and there must never
 * be one: it would be the second declaration point this file exists to remove,
 * and it would go stale in exactly the silent way described in the header.
 */
export type OperatorSettingValue<K extends OperatorSettingKey> = z.infer<
  (typeof OPERATOR_SETTINGS)[K]['schema']
>;

/** A complete set of values, one per key. */
export type OperatorSettingsSnapshot = {
  [K in OperatorSettingKey]: OperatorSettingValue<K>;
};

/** A partial set — what a test double or a database overlay supplies. */
export type OperatorSettingsOverrides = Partial<OperatorSettingsSnapshot>;

/** Every key, in declaration order. */
export const OPERATOR_SETTING_KEYS = Object.keys(
  OPERATOR_SETTINGS,
) as OperatorSettingKey[];

/** Whether a string names a managed key. */
export function isOperatorSettingKey(key: string): key is OperatorSettingKey {
  return Object.prototype.hasOwnProperty.call(OPERATOR_SETTINGS, key);
}

/** The definition for one key, with its value type preserved. */
export function operatorSettingDefinition<K extends OperatorSettingKey>(
  key: K,
): (typeof OPERATOR_SETTINGS)[K] {
  return OPERATOR_SETTINGS[key];
}

/** Every key paired with its definition, for anything that iterates. */
export function operatorSettingEntries(): Array<
  [OperatorSettingKey, AnyOperatorSettingDefinition]
> {
  return Object.entries(OPERATOR_SETTINGS) as Array<
    [OperatorSettingKey, AnyOperatorSettingDefinition]
  >;
}

/** The outcome of parsing one raw value. */
export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

/**
 * Parse one raw value — env string or JSON — for one key.
 *
 * THE single parse path. `OperatorSettingsService` uses it for environment
 * values, #339's database overlay will use it for JSON values, and the test
 * double uses it for overrides, which is what makes "an env string and a JSON
 * value resolve to the identical typed result" a property of the system rather
 * than a coincidence three call sites happen to share.
 */
export function parseOperatorSetting<K extends OperatorSettingKey>(
  key: K,
  raw: unknown,
): ParseResult<OperatorSettingValue<K>> {
  const definition = OPERATOR_SETTINGS[key];
  const result = definition.schema.safeParse(raw);

  if (result.success) {
    return { ok: true, value: result.data as OperatorSettingValue<K> };
  }

  return {
    ok: false,
    error: result.error.issues
      .map((issue) => issue.message)
      .join('; ')
      .trim(),
  };
}
