import type { WorkOrderSpec } from '../runner.types';

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

export interface InvocationOptions {
  permissionMode: PermissionMode;
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
  return [
    '--print',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    options.permissionMode,
    '--session-id',
    options.sessionId,
  ];
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
 * The environment a run gets on top of the API's own.
 *
 * Narrow on purpose. The child inherits `process.env` (it needs PATH, HOME and
 * whatever authenticates the CLI), and everything added here is either a
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
