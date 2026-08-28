/**
 * `POST /steering/proposals` and `/proposals/apply`, as the API really answers
 * them (#426).
 *
 * Built from the types `services/api.ts` declares and covered by
 * `tsconfig.fixtures.json`, so a rename on the wire shape breaks the build
 * rather than leaving a green suite asserting against a response nothing
 * serves (#415, #417).
 *
 * Two things are pinned here rather than in each handler, because both are
 * defaults MSW would otherwise get wrong:
 *
 *  - **Propose answers 200 and apply answers 202.** `steering.controller.ts`
 *    puts `@HttpCode(HttpStatus.OK)` on one and `ACCEPTED` on the other, and
 *    the difference is the feature: proposing has accepted nothing, because
 *    nothing has been asked for yet.
 *  - **Every body is wrapped as `{ data }`** by `TransformInterceptor`. A
 *    handler returning the bare payload would be testing a shape the API does
 *    not serve.
 */

import { HttpResponse } from 'msw';

import type {
  SteeringApplyResult,
  SteeringOperation,
  SteeringProposal,
} from '../../types/steering';

/** `@HttpCode(HttpStatus.OK)` on `propose`. Nothing has been accepted. */
export const PROPOSE_OK = 200;

/** `@HttpCode(HttpStatus.ACCEPTED)` on `apply`. The labels are a request. */
export const APPLY_ACCEPTED = 202;

/** `steering.service.ts`'s own sentence, byte for byte. */
export const APPLY_EFFECT =
  'The labels are the request. They take effect on the next reconciler tick.';

export function operationFixture(
  overrides: Partial<SteeringOperation> = {},
): SteeringOperation {
  const number = overrides.number ?? 1;
  return {
    ref: `opifex/opifex#${number}`,
    owner: 'opifex',
    name: 'opifex',
    number,
    title: 'Wire the metrics summary endpoint',
    add: ['factory:ready'],
    remove: [],
    observedInputLabels: [],
    reason: 'Named by the instruction.',
    named: true,
    ...overrides,
  };
}

/**
 * The named half of `only work on #1, #2 and #3`.
 *
 * `observedInputLabels` deliberately carries a label steering may NOT write
 * (`factory:quarantined`): the baseline is every recognised `factory:` label
 * on the issue, not the two that are steerable, so a client narrowing it to
 * the steerable set is caught by a test that asserts the echo.
 */
export const NAMED_OPERATIONS: SteeringOperation[] = [
  operationFixture({
    number: 1,
    title: 'Wire the metrics summary endpoint',
    observedInputLabels: ['factory:quarantined'],
  }),
  operationFixture({ number: 2, title: 'Add the activity feed' }),
  operationFixture({ number: 3, title: 'Cost read model' }),
];

/** The destructive half: issues nobody typed, losing intent somebody set. */
export const COLLATERAL_OPERATIONS: SteeringOperation[] = [
  operationFixture({
    number: 17,
    title: 'Retire the legacy settings tab',
    add: [],
    remove: ['factory:ready'],
    observedInputLabels: ['factory:ready'],
    reason: 'Carries factory:ready and the instruction was exclusive.',
    named: false,
  }),
  operationFixture({
    number: 18,
    title: 'Backfill the audit index',
    add: [],
    remove: ['factory:ready'],
    observedInputLabels: ['factory:ready'],
    reason: 'Carries factory:ready and the instruction was exclusive.',
    named: false,
  }),
];

export function proposalFixture(
  overrides: Partial<SteeringProposal> = {},
): SteeringProposal {
  const proposedAt = overrides.proposedAt ?? new Date().toISOString();
  const operations = overrides.operations ?? [
    ...NAMED_OPERATIONS,
    ...COLLATERAL_OPERATIONS,
  ];

  return {
    proposalId: '2f0f9f2e-6d6f-4f5f-9e4a-2b0c9b6a5d31',
    proposedAt,
    expiresAt: new Date(
      new Date(proposedAt).getTime() + 30 * 60_000,
    ).toISOString(),
    instruction: 'only work on #1, #2 and #3',
    interpretation: {
      method: 'deterministic',
      modelInvoked: false,
      notes: ['Read 3 issue references and an exclusive clause.'],
      ambiguity: null,
      model: null,
      spend: null,
    },
    scope: {
      intent: 'ready',
      exclusive: true,
      elseIntent: 'unready',
      repositories: ['opifex/opifex'],
      candidatesConsidered: 19,
      epics: [],
    },
    operations,
    blastRadius: {
      issuesAffected: 5,
      named: 3,
      collateral: 2,
      labelsAdded: 3,
      labelsRemoved: 2,
      unreadied: 2,
      readied: 3,
      held: 0,
      destructive: true,
      summary:
        'This will mark 3 issues ready. This will un-ready 2 issues, 2 of ' +
        'which the instruction did not name.',
    },
    unresolved: [],
    ...overrides,
  };
}

/**
 * The answer to prose today: the parser could not read it, and no model was
 * asked because the chat has no spend ceiling (`chat-spend-gate.ts`).
 */
export function needsInterpretationFixture(
  instruction = 'just the auth epic please',
): SteeringProposal {
  return proposalFixture({
    instruction,
    operations: [],
    interpretation: {
      method: 'none',
      modelInvoked: false,
      notes: [],
      ambiguity: 'No issue reference was found in the instruction.',
      model: {
        consumer: 'chat',
        provider: 'anthropic',
        model: '',
        available: false,
        unavailableReason:
          'No chat model is configured: set chat.model.name in the Control Center.',
      },
      spend: {
        admitted: false,
        reason:
          'The steering chat has no spend ceiling, so no model was asked.',
      },
    },
    blastRadius: {
      issuesAffected: 0,
      named: 0,
      collateral: 0,
      labelsAdded: 0,
      labelsRemoved: 0,
      unreadied: 0,
      readied: 0,
      held: 0,
      destructive: false,
      summary:
        'Nothing changes: every issue this instruction names is already in ' +
        'the state it asks for.',
    },
    unresolved: [
      {
        reference: instruction,
        reason: 'needs-interpretation',
        detail: 'No issue reference was found in the instruction.',
      },
    ],
  });
}

export function proposalResponse(proposal: SteeringProposal) {
  return HttpResponse.json({ data: proposal }, { status: PROPOSE_OK });
}

export function applyResultFixture(
  overrides: Partial<SteeringApplyResult> = {},
): SteeringApplyResult {
  const applied = overrides.applied ?? [
    {
      ref: 'opifex/opifex#1',
      add: ['factory:ready' as const],
      remove: [],
      writes: [
        {
          label: 'factory:ready' as const,
          operation: 'add' as const,
          performed: true,
          noop: false,
        },
      ],
    },
  ];
  const skipped = overrides.skipped ?? [];

  const labelWrites = applied.reduce(
    (total, entry) => total + entry.writes.length,
    0,
  );
  const labelWritesPerformed = applied.reduce(
    (total, entry) =>
      total + entry.writes.filter((write) => write.performed).length,
    0,
  );

  return {
    proposalId: '2f0f9f2e-6d6f-4f5f-9e4a-2b0c9b6a5d31',
    applied,
    skipped,
    labelWritten: labelWritesPerformed > 0,
    writesEnabled: true,
    reconciled: false,
    effect: APPLY_EFFECT,
    summary: {
      operationsRequested: applied.length + skipped.length,
      operationsApplied: applied.length,
      operationsSkipped: skipped.length,
      labelWrites,
      labelWritesPerformed,
    },
    ...overrides,
  };
}

export function applyResponse(result: SteeringApplyResult) {
  return HttpResponse.json({ data: result }, { status: APPLY_ACCEPTED });
}

/**
 * What apply answers past the 30-minute TTL: a `ConflictException`, in the
 * error shape `api.ts` reads (`message`).
 */
export function staleProposalResponse() {
  return HttpResponse.json(
    {
      statusCode: 409,
      message:
        'This proposal was made 41 minutes ago and proposals expire after 30. ' +
        'Ask for a new one — the backlog may have moved.',
    },
    { status: 409 },
  );
}
