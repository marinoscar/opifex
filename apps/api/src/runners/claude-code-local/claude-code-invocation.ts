import type { OperatorSettingKey } from '../../settings/operator-settings/operator-settings.registry';
import type { ModelTier, WorkOrderSpec } from '../runner.types';

/**
 * How a work order becomes an argv and a prompt.
 *
 * Split out from the runner because it is the part with no I/O in it: given a
 * work order, the command line and the prompt are pure functions of it, and
 * pure functions are the only part of a subprocess integration that can be
 * asserted without starting anything.
 *
 * Every flag here was read off `claude --help` for the version this was
 * written against (2.1.x) rather than recalled. #61 requires the manifest be
 * "verified against observed behaviour, not aspirational", and a flag that
 * does not exist produces a runner that fails on its first real dispatch and
 * passes every test that mocked the CLI.
 *
 * `--model` (#420) was read the same way, off 2.1.243: *"Model for the current
 * session. Provide an alias for the latest model (e.g. 'fable', 'opus', or
 * 'sonnet') or a model's full name (e.g. 'claude-fable-5')."* Both forms are
 * accepted, and the registry's defaults are full names rather than aliases —
 * see `operator-settings.registry.ts` for why a moving alias is the wrong
 * thing to write down for a tier whose purpose is bounding spend.
 */

/**
 * Permission modes the CLI accepts.
 *
 * Restated as a closed union so a typo in configuration fails at startup
 * rather than as an unusable exit code on the first dispatch.
 */
export const PERMISSION_MODES = [
  'acceptEdits',
  'auto',
  'bypassPermissions',
  'manual',
  'dontAsk',
  'plan',
] as const;

export type PermissionMode = (typeof PERMISSION_MODES)[number];

/**
 * The same six modes, ordered NARROWEST FIRST (#441).
 *
 * ## What this is for
 *
 * `runners.claudeCodeLocal.permissionMode` needs somewhere safe to land when
 * an operator supplies a value the registry refuses. The declared default is
 * `acceptEdits`, and #441's point is that an operator typing `ask`,
 * `readonly` or `plan-only` — all of them reaching for something STRICTER —
 * used to get a mode that lets the agent edit files. A fallback must never be
 * broader than what was asked for, and "never broader" needs an order.
 *
 * `NARROWEST_PERMISSION_MODE` below is what the registry declares as its
 * `invalidFallback`, derived from this list rather than written twice.
 *
 * ## How the order was established, and what is asserted vs. judged
 *
 * The SET is verified, not recalled: `claude --help` on 2.1.251 lists exactly
 * `acceptEdits`, `auto`, `bypassPermissions`, `manual`, `dontAsk`, `plan` as
 * the choices for `--permission-mode`. `claude-code-invocation.spec.ts` pins
 * that, and this array is asserted to be a permutation of `PERMISSION_MODES`,
 * so a seventh mode added to the CLI cannot be adopted here without being
 * placed deliberately.
 *
 * The ORDER is a judgement and is not claimed to be otherwise — `--help`
 * states the choices and does not rank them. It reads:
 *
 *  1. `plan`      — proposes, does not act. The only mode that cannot change
 *                   the working tree at all, so it is the floor.
 *  2. `manual`    — asks before everything. Narrow, but in a non-interactive
 *                   `-p` run there is nobody to ask, so it stalls rather than
 *                   refusing; see the note below on why it is not the floor.
 *  3. `acceptEdits` — edits without asking, still asks for the rest. The
 *                   declared default.
 *  4. `auto`      — broader still.
 *  5. `dontAsk`   — stops asking.
 *  6. `bypassPermissions` — every check off. `claude --help` calls the
 *                   equivalent flag "Recommended only for sandboxes with no
 *                   internet access", which is the CLI's own words for how
 *                   far this end is from the other.
 *
 * Only positions 1 and 6 are load-bearing: everything else is used for the
 * "never broader" comparison and nothing reads the middle today.
 *
 * ## Why `plan` is the floor and `manual` is not
 *
 * `manual` is arguably the stricter INTENT, but Opifex runs the CLI
 * non-interactively, so a mode that asks has nobody to answer it: the run
 * hangs until the watchdog (#54) kills it. That converts one operator's typo
 * into a stalled queue, which is the shape `DEFAULT_CEILING_WINDOW_DAYS`
 * argues against — a safety response severe enough to look like an outage
 * becomes pressure to remove the safety mechanism. `plan` terminates on its
 * own and changes nothing.
 */
export const PERMISSION_MODES_BY_BREADTH = [
  'plan',
  'manual',
  'acceptEdits',
  'auto',
  'dontAsk',
  'bypassPermissions',
] as const satisfies readonly PermissionMode[];

/**
 * The mode a REJECTED `permissionMode` resolves to (#441).
 *
 * Derived, so the registry and this file cannot disagree about which end of
 * the list is the safe one.
 */
export const NARROWEST_PERMISSION_MODE: PermissionMode =
  PERMISSION_MODES_BY_BREADTH[0];

export interface InvocationOptions {
  permissionMode: PermissionMode;
  /**
   * The model to pin this run to, or ABSENT for the CLI's own default.
   *
   * Absent is not a synonym for "the standard model", and the distinction is
   * the whole of #420's second decision. Most work orders declare no tier, and
   * for those the right invocation carries NO `--model` flag at all: the CLI
   * picks, and it goes on picking correctly across a release that changes
   * which model that is. Naming today's default explicitly for the untiered
   * case would freeze it, silently, against exactly that change — a run in six
   * months would keep asking for a model chosen in August by nobody in
   * particular, and nothing anywhere would report that it had.
   *
   * So this is optional, and {@link buildInvocationArgs} omits the flag rather
   * than substituting a value. See {@link resolveModel} for which of the four
   * cases produces a value here.
   */
  model?: string;
  /**
   * The control plane's run id, handed to the CLI as its session id.
   *
   * Both are UUIDs and both name one attempt, so making them the same value
   * costs nothing and buys a correlation that survives leaving the process:
   * an operator with a run id can find the CLI's own session transcript for
   * it without a lookup table, which is the difference between a five-minute
   * and a fifty-minute investigation of a run that went wrong.
   */
  sessionId: string;
}

/**
 * The command line.
 *
 * `--print` puts the CLI in non-interactive mode, `--output-format stream-json`
 * makes its output line-delimited JSON, and `--verbose` is what makes that
 * stream carry per-tool detail rather than only a final result — which is the
 * `streamingFidelity: 'full'` the manifest declares, and therefore what makes
 * loop detection (#55) and event-age watchdogs (#54) possible at all.
 *
 * The prompt is NOT here. It goes on stdin: it is unbounded prose from an
 * issue, argv has a length limit, and argv is world-readable through `ps`.
 */
export function buildInvocationArgs(options: InvocationOptions): string[] {
  const args = [
    '--print',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    options.permissionMode,
    '--session-id',
    options.sessionId,
  ];

  // OMITTED, not defaulted. `--model` is the one flag here whose absence is
  // meaningful: it hands the choice back to the CLI, which is what a work
  // order that declared no tier is owed. An empty string is treated the same
  // way, because that is how an operator expresses "this tier gets whatever
  // the CLI would have picked" in a settings field that cannot hold `null`.
  if (options.model !== undefined && options.model !== '') {
    args.push('--model', options.model);
  }

  return args;
}

// ---------------------------------------------------------------------------
// tier -> model
// ---------------------------------------------------------------------------

/**
 * Which operator setting holds the model for each tier (#420).
 *
 * ## Why the mapping is three settings and not a constant here
 *
 * A tier is a POLICY statement — "small work uses the cheap model" — and the
 * model that satisfies a policy moves as models ship, on a schedule that has
 * nothing to do with this repository's release cadence. A constant would make
 * "run `tier:small` on Haiku 5 now that it exists" a code change, a build and
 * a deploy, for a decision that is entirely the operator's and involves no
 * code at all. Three registry keys make it a form field, and cost three keys.
 *
 * That is the trade #420 asked to be weighed rather than defaulted, and the
 * thing that settles it is that the operator is the only party who KNOWS: what
 * their subscription includes, what their spend looks like, and whether the
 * model a tier names is still the right one. `permissionMode` and `binary` —
 * the other two values that end up in this argv — are already registry keys
 * for the same reason, and a mapping harder to change than the permission mode
 * would be an odd place to draw the line.
 *
 * The values are checked against the registry at COMPILE time by `satisfies`,
 * so a key renamed there and not here does not compile. That the key exists is
 * not the same as it holding a usable model, which is what the spec's cost
 * ladder assertion is for.
 */
export const MODEL_SETTING_KEY_BY_TIER = Object.freeze({
  small: 'runners.claudeCodeLocal.model.small',
  standard: 'runners.claudeCodeLocal.model.standard',
  large: 'runners.claudeCodeLocal.model.large',
} as const satisfies Record<ModelTier, OperatorSettingKey>);

/** The three registry keys, as a union, so a lookup returns a plain string. */
export type ModelSettingKey =
  (typeof MODEL_SETTING_KEY_BY_TIER)[keyof typeof MODEL_SETTING_KEY_BY_TIER];

/**
 * What the invocation will do about the model, and how to say so.
 *
 * Four cases rather than `string | undefined`, because three of them produce
 * no flag and they are NOT the same fact. An operator reading a run record
 * needs to tell "nobody asked for a model" from "somebody asked for one this
 * build could not supply", and a caller needs to know which of those is worth
 * a warning. Collapsing them is how #420's bug looked fine for as long as it
 * did: the tier was present, and everything downstream of it was silent.
 *
 * `statement` is prose on purpose. It is written into the `run.started`
 * summary, which is a NOT NULL column on `run_events` and therefore the one
 * place a tier claim can be checked after the fact without a schema change.
 */
export type ModelResolution =
  /** A tier was declared and maps to a model. The flag is passed. */
  | {
      readonly kind: 'pinned';
      readonly model: string;
      readonly statement: string;
    }
  /** No tier. The CLI's own default applies and the flag is omitted. */
  | { readonly kind: 'no-tier'; readonly statement: string }
  /** A tier this build has no key for. Reported, never refused. */
  | {
      readonly kind: 'unmapped-tier';
      readonly tier: string;
      readonly statement: string;
    }
  /** A known tier the operator has deliberately mapped to no model. */
  | {
      readonly kind: 'not-configured';
      readonly tier: string;
      readonly statement: string;
    };

/**
 * Decide which model a work order's tier asks for, if any.
 *
 * Pure: the configured value arrives through `configured` rather than through
 * an injected settings service, so all four branches are assertable without
 * spawning anything — which matters because three of them are defined by the
 * ABSENCE of a flag, and an absence is the easiest thing in the world to test
 * vacuously.
 *
 * `tier` is typed `string`, not `ModelTier`, and that is deliberate. The union
 * is closed today and `work-order-rehydrate.ts` refuses a stored tier outside
 * it — but the tier vocabulary is a versioned contract (ADR-0010) that a minor
 * bump may add to, and a runner that THREW on a tier it did not recognise
 * would turn a forward-compatible schema change into a failed run. #297
 * already settled how the factory treats a routing declaration it cannot act
 * on: ignore it, run on the default, and say so. This does that.
 */
export function resolveModel(
  tier: string | undefined,
  configured: (key: ModelSettingKey) => string,
): ModelResolution {
  if (tier === undefined) {
    return {
      kind: 'no-tier',
      statement: "the runner's own default model (no tier declared)",
    };
  }

  const key = Object.prototype.hasOwnProperty.call(
    MODEL_SETTING_KEY_BY_TIER,
    tier,
  )
    ? MODEL_SETTING_KEY_BY_TIER[tier as ModelTier]
    : undefined;

  if (key === undefined) {
    return {
      kind: 'unmapped-tier',
      tier,
      statement:
        `the runner's own default model (tier '${tier}' is not one this runner ` +
        'maps to a model)',
    };
  }

  const model = configured(key).trim();
  if (model === '') {
    return {
      kind: 'not-configured',
      tier,
      statement: `the runner's own default model (tier '${tier}' is configured with no model)`,
    };
  }

  return {
    kind: 'pinned',
    model,
    statement: `model ${model} (tier '${tier}')`,
  };
}

/**
 * The prompt, built from the work order and nothing else.
 *
 * ## Why this is not a template with a personality
 *
 * VISION §10 makes spec quality the throughput ceiling: *the factory cannot
 * be better than what it is told to build.* The useful content here is the
 * task spec and the acceptance criteria, both of which are the human's words
 * (#62 rejects placeholder and subjective criteria before a work order is ever
 * written). Prompt engineering on top of them would mostly obscure which of
 * the two is responsible when a run produces the wrong thing.
 *
 * So this states the constraints the CONTROL PLANE imposes — the branch, the
 * paths, the fact that acceptance criteria are the definition of done — and
 * otherwise gets out of the way.
 */
export function buildPrompt(workOrder: WorkOrderSpec): string {
  const sections: string[] = [
    `You are working on ${workOrder.repository.owner}/${workOrder.repository.name}.`,
    '',
    `The working tree is already checked out at ${workOrder.baseCommit} on the branch ` +
      `\`${workOrder.branch}\`. Commit your work to that branch. Do not create other ` +
      'branches, and do not merge or rebase onto anything.',
    '',
    '## Task',
    '',
    workOrder.taskSpec.trim(),
    '',
    '## Acceptance criteria',
    '',
    // Numbered rather than bulleted so a run summary can refer to "criterion
    // 3" and mean something stable.
    ...workOrder.acceptanceCriteria.map(
      (criterion, index) => `${index + 1}. ${criterion}`,
    ),
    '',
    'These are the definition of done. Do not consider the task complete until every ' +
      'one of them holds, and say explicitly which ones you could not verify.',
  ];

  if (workOrder.pathConstraints.length > 0) {
    sections.push(
      '',
      '## Paths',
      '',
      'Confine your changes to these paths:',
      ...workOrder.pathConstraints.map((glob) => `- \`${glob}\``),
    );
  }

  // Advisory, exactly as `WorkOrderSpec` says they are: VISION §3.6 puts
  // enforcement in deterministic policy (#65), never in the agent's own
  // judgement. Telling it anyway means a well-behaved run stops sooner and
  // more gracefully than one that gets killed at the ceiling.
  const limits: string[] = [];
  if (workOrder.budgetCeilingUsd !== null) {
    limits.push(
      `- A budget of about $${workOrder.budgetCeilingUsd.toFixed(2)}.`,
    );
  }
  if (workOrder.wallClockTimeoutMinutes !== null) {
    limits.push(
      `- About ${workOrder.wallClockTimeoutMinutes} minutes of wall clock.`,
    );
  }
  if (limits.length > 0) {
    sections.push(
      '',
      '## Limits',
      '',
      'This run will be stopped if it exceeds either of these, so prefer finishing ' +
        'something small and correct over running out mid-change:',
      ...limits,
    );
  }

  return `${sections.join('\n')}\n`;
}

/**
 * The environment a run gets on top of what it inherits.
 *
 * Narrow on purpose, and narrower than it reads: what it is "on top of" is NOT
 * `process.env`. Since #334 the child inherits only the names in
 * `process/child-environment.ts` — PATH, HOME, locale, and the variable that
 * authenticates the CLI — so the API's secrets are absent from the agent's
 * environment rather than merely unmentioned here. Everything added below is a
 * correlation id or a thing that must be off.
 */
export function buildInvocationEnv(
  workOrder: WorkOrderSpec,
): NodeJS.ProcessEnv {
  return {
    // Correlation for anything the run itself logs or reports.
    OPIFEX_WORK_ORDER: workOrder.identity,
    OPIFEX_RUN_ID: workOrder.runId,
    OPIFEX_BRANCH: workOrder.branch,
    // Belt and braces with `--print`: a CLI that decides it has a terminal is
    // a CLI that can decide to ask a question, and a question with nobody to
    // answer it is a silent run.
    CI: 'true',
    TERM: 'dumb',
  };
}
