/**
 * Lines from a real `stream-json` run, trimmed but not reshaped.
 *
 * Captured from
 * `claude -p --output-format stream-json --verbose --permission-mode acceptEdits`
 * against CLI 2.1.240 on 2026-08-22. Session ids and paths are replaced;
 * every key name, nesting level and value type is exactly as observed.
 *
 * Kept in `src/` rather than in `test/` for the same reason `fake-runner.ts`
 * is: the mapper's own spec, the runner's spec and (later) #23's cross-runner
 * conformance work all need the same lines, and three hand-typed copies of a
 * format nobody can check from memory would drift into three different beliefs
 * about it.
 *
 * The trimming is only ever REMOVAL — long `thinking` signatures, the full
 * tool list, per-model usage breakdowns. Nothing is added and nothing is
 * renamed, because the whole value of a fixture like this is that it is not
 * something someone wrote down from recollection.
 */

/** Every distinct `type`/`subtype` the captured run produced, in order. */
export const OBSERVED_LINE_KINDS = [
  'active_goal',
  'autocompact_state',
  'system/commands_changed',
  'system/init',
  'rate_limit_event',
  'system/thinking_tokens',
  'assistant',
  'system/task_summary',
  'user',
  'system/permission_denied',
  'system/post_turn_summary',
  'result/success',
] as const;

const SESSION = '11111111-2222-4333-8444-555555555555';

export const INIT_LINE = {
  type: 'system',
  subtype: 'init',
  cwd: '/w',
  session_id: SESSION,
  tools: ['Bash', 'Edit', 'Read', 'Write'],
  model: 'claude-sonnet-5',
  permissionMode: 'acceptEdits',
  claude_code_version: '2.1.240',
  uuid: 'cbaafe0b-1e61-4b02-9321-8640459f1e5c',
};

/**
 * The healthy case: a rate-limit report on a run that is NOT limited.
 *
 * The CLI emits one of these near the start of every run. Treating it as a
 * block would park a run that is working perfectly.
 */
export const RATE_LIMIT_ALLOWED_LINE = {
  type: 'rate_limit_event',
  rate_limit_info: {
    status: 'allowed',
    resetsAt: 1787438400,
    rateLimitType: 'five_hour',
    overageStatus: 'rejected',
    overageDisabledReason: 'out_of_credits',
    isUsingOverage: false,
  },
  uuid: '794d4518-8df6-4c1e-9658-2dad94df9995',
  session_id: SESSION,
};

/**
 * The blocked case.
 *
 * Same shape, different `status` — this is the one #56 parks on, and
 * `resetsAt` is what lets it park with a date rather than escalating.
 */
export const RATE_LIMIT_BLOCKED_LINE = {
  ...RATE_LIMIT_ALLOWED_LINE,
  rate_limit_info: {
    ...RATE_LIMIT_ALLOWED_LINE.rate_limit_info,
    status: 'rejected',
  },
  uuid: 'a1b2c3d4-0000-4000-8000-000000000001',
};

/** Quota gone rather than a window to wait out — a human has to act. */
export const QUOTA_EXHAUSTED_LINE = {
  ...RATE_LIMIT_ALLOWED_LINE,
  rate_limit_info: {
    ...RATE_LIMIT_ALLOWED_LINE.rate_limit_info,
    status: 'rejected',
    overageStatus: 'rejected',
    isUsingOverage: true,
  },
  uuid: 'a1b2c3d4-0000-4000-8000-000000000002',
};

export const TOOL_USE_LINE = {
  type: 'assistant',
  message: {
    model: 'claude-sonnet-5',
    id: 'msg_011CeJYPibyrPaAD2ofNDFA2',
    type: 'message',
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id: 'toolu_01Ks5wUX9v1zL3jAgXawVUA4',
        name: 'Bash',
        input: {
          command: 'find . -iname "note.txt"',
          description: 'Locate the note',
        },
      },
    ],
    usage: { input_tokens: 2, output_tokens: 16 },
  },
  parent_tool_use_id: null,
  session_id: SESSION,
  timestamp: '2026-08-22T22:02:45.080Z',
  uuid: '96146201-408a-414c-8f72-f4a8ad959ac0',
};

/** The same call again — what loop detection (#55) has to recognise. */
export const TOOL_USE_LINE_REPEATED = {
  ...TOOL_USE_LINE,
  uuid: 'aaaaaaaa-0000-4000-8000-000000000003',
  timestamp: '2026-08-22T22:03:10.000Z',
};

/** Identical arguments, serialised in a different key order. */
export const TOOL_USE_LINE_REORDERED_ARGS = {
  ...TOOL_USE_LINE,
  message: {
    ...TOOL_USE_LINE.message,
    content: [
      {
        type: 'tool_use',
        id: 'toolu_reordered',
        name: 'Bash',
        input: {
          description: 'Locate the note',
          command: 'find . -iname "note.txt"',
        },
      },
    ],
  },
  uuid: 'aaaaaaaa-0000-4000-8000-000000000004',
};

export const THINKING_LINE = {
  type: 'assistant',
  message: {
    model: 'claude-sonnet-5',
    id: 'msg_011CeJYPibyrPaAD2ofNDFA2',
    type: 'message',
    role: 'assistant',
    // The real one carries a long opaque `signature`; the shape is what
    // matters here.
    content: [
      {
        type: 'thinking',
        thinking: 'Working out where the file is.',
        signature: 'ErYC',
      },
    ],
    usage: { input_tokens: 2, output_tokens: 2 },
  },
  parent_tool_use_id: null,
  session_id: SESSION,
  timestamp: '2026-08-22T22:02:44.597Z',
  uuid: '95949b0b-de77-4c73-b296-6d685f048548',
};

export const TEXT_LINE = {
  type: 'assistant',
  message: {
    model: 'claude-sonnet-5',
    id: 'msg_011CeJYQESbuqQ4aThB52hWQ',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'The word is: **hello**' }],
    usage: { input_tokens: 2, output_tokens: 12 },
  },
  parent_tool_use_id: null,
  session_id: SESSION,
  timestamp: '2026-08-22T22:02:50.964Z',
  uuid: '54de7cfd-75a6-43cb-b96b-b22a4d4c656d',
};

export const TOOL_RESULT_LINE = {
  type: 'user',
  message: {
    role: 'user',
    content: [
      {
        tool_use_id: 'toolu_01Ks5wUX9v1zL3jAgXawVUA4',
        type: 'tool_result',
        content: './note.txt',
        is_error: false,
      },
    ],
  },
  parent_tool_use_id: null,
  session_id: SESSION,
  timestamp: '2026-08-22T22:02:45.859Z',
  uuid: '61ced091-eefe-46f4-97c4-693cbfdb0000',
};

/** A tool that failed. The run has not failed — agents recover from these. */
export const TOOL_RESULT_ERROR_LINE = {
  ...TOOL_RESULT_LINE,
  message: {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        content:
          "Claude requested permissions to read from /w/note.txt, but you haven't granted it yet.",
        is_error: true,
        tool_use_id: 'toolu_01NFhYFBCb4KemKnLSpJg47K',
      },
    ],
  },
  uuid: '651ba320-3d79-492b-852e-af85ba5c1bb8',
};

/**
 * A refusal under a non-interactive permission mode.
 *
 * Nobody is being asked, so this is not `awaiting-approval` — but a run
 * quietly being refused its tools is the shape of a run about to go silent,
 * which makes it worth keeping rather than dropping.
 */
export const PERMISSION_DENIED_LINE = {
  type: 'system',
  subtype: 'permission_denied',
  tool_name: 'Read',
  tool_use_id: 'toolu_01NFhYFBCb4KemKnLSpJg47K',
  decision_reason_type: 'workingDir',
  decision_reason: 'Path is outside allowed working directories',
  message:
    'Claude requested permissions to read from /w/note.txt, but you have not granted it yet.',
  uuid: '65264706-b4cc-42fb-aca2-aea73770839c',
  session_id: SESSION,
};

export const RESULT_SUCCESS_LINE = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 8855,
  duration_api_ms: 7559,
  num_turns: 4,
  stop_reason: 'end_turn',
  session_id: SESSION,
  total_cost_usd: 0.2030522,
  usage: {
    input_tokens: 8,
    cache_creation_input_tokens: 43193,
    cache_read_input_tokens: 128376,
    output_tokens: 362,
  },
  permission_denials: [
    { tool_name: 'Read', tool_use_id: 'toolu_01NFhYFBCb4KemKnLSpJg47K' },
  ],
  terminal_reason: 'completed',
  result: 'The word is: **hello**',
  uuid: 'fb15bae2-4859-4904-8cdc-00c1c08d248e',
};

export const RESULT_ERROR_LINE = {
  ...RESULT_SUCCESS_LINE,
  subtype: 'error_during_execution',
  is_error: true,
  stop_reason: null,
  permission_denials: [],
  result: undefined,
  uuid: 'fb15bae2-4859-4904-8cdc-00c1c08d240e',
};

/** Bookkeeping lines with no normalized equivalent. Every one is dropped. */
export const UNMAPPED_LINES = [
  { type: 'active_goal', uuid: 'b1096c18-ca4f-4027-8de4-29f601257d0a' },
  { type: 'autocompact_state', uuid: 'b1613968-ce88-492b-9dbe-61cdd0c32d6e' },
  {
    type: 'system',
    subtype: 'commands_changed',
    uuid: '41f762cb-53fd-47ae-b124-5471fd7eae40',
  },
  {
    type: 'system',
    subtype: 'thinking_tokens',
    uuid: '1d3a8534-9300-43a1-86de-29140418c4e3',
  },
  {
    type: 'system',
    subtype: 'task_summary',
    uuid: '6ee9439c-b41d-4f55-a69e-03c29ef6174e',
  },
  {
    type: 'system',
    subtype: 'post_turn_summary',
    uuid: 'c2243642-8059-4a43-bd94-3e45eef5028c',
  },
  // Not in the captured run: the shape of the next CLI version adding
  // something. ADR 0006 requires this be a drop, not an escalation.
  {
    type: 'some_future_event_type',
    uuid: 'ffffffff-0000-4000-8000-000000000009',
  },
];
