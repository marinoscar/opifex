/**
 * The sentences the steering chat says (#426).
 *
 * Every assertion here is about wording an operator reads immediately before
 * writing labels to somebody else's backlog, which is why the module is pure:
 * the alternative is asserting on a screenshot of a render and hoping the
 * sentence is the reason it passed.
 */

import { describe, expect, it } from 'vitest';

import {
  PROPOSAL_TTL_MINUTES,
  applyHeadline,
  applyOutcomes,
  applyRefusal,
  blastRadiusHeadline,
  classifyApplied,
  driftLine,
  expiryNotice,
  interpretationNotice,
  labelChangeLine,
  outcomeLine,
  partitionOperations,
  proposeRefusal,
  resolutionFailures,
} from '../../config/steeringChat';
import { WRITES_DISABLED_FACT } from '../../config/queueSteering';
import {
  COLLATERAL_OPERATIONS,
  NAMED_OPERATIONS,
  applyResultFixture,
  needsInterpretationFixture,
  operationFixture,
  proposalFixture,
} from '../mocks/steering';

describe('blastRadiusHeadline', () => {
  it('states additions and removals in the same sentence', () => {
    const headline = blastRadiusHeadline(proposalFixture());

    // Both halves, in one line, before any operation is drawn. A headline
    // naming only what it adds is the reply #426 calls worse than no chat.
    expect(headline.title).toContain('3 labels added');
    expect(headline.title).toContain('2 labels removed');
    expect(headline.severity).toBe('warning');
  });

  it('renders the API’s own summary rather than re-deriving one', () => {
    const headline = blastRadiusHeadline(proposalFixture());

    expect(headline.body[0]).toBe(proposalFixture().blastRadius.summary);
    expect(headline.body.join(' ')).toContain('un-ready 2 issues');
  });

  it('says the collateral count and that removals are not written yet', () => {
    const body = blastRadiusHeadline(proposalFixture()).body.join(' ');

    expect(body).toContain('2 issues the instruction did not name');
    expect(body).toContain('2 labels would be REMOVED');
    expect(body).toContain('no label is written until this is confirmed');
  });

  it('is information, not a warning, when nothing is removed', () => {
    const proposal = proposalFixture({
      operations: NAMED_OPERATIONS,
      blastRadius: {
        ...proposalFixture().blastRadius,
        collateral: 0,
        labelsRemoved: 0,
        unreadied: 0,
        destructive: false,
        issuesAffected: 3,
        summary: 'This will mark 3 issues ready.',
      },
    });

    expect(blastRadiusHeadline(proposal).severity).toBe('info');
    expect(blastRadiusHeadline(proposal).title).toContain('0 labels removed');
  });
});

describe('partitionOperations', () => {
  it('keeps what was named apart from what it implies', () => {
    const { named, collateral, unchanged } = partitionOperations([
      ...NAMED_OPERATIONS,
      ...COLLATERAL_OPERATIONS,
    ]);

    expect(named.map((operation) => operation.number)).toEqual([1, 2, 3]);
    expect(collateral.map((operation) => operation.number)).toEqual([17, 18]);
    expect(unchanged).toHaveLength(0);
  });

  it('files an operation with an empty diff as unchanged, in neither half', () => {
    const already = operationFixture({ number: 9, add: [], remove: [] });
    const partition = partitionOperations([...NAMED_OPERATIONS, already]);

    expect(partition.unchanged).toEqual([already]);
    expect(partition.named).not.toContain(already);
    expect(partition.collateral).not.toContain(already);
  });
});

describe('interpretationNotice', () => {
  it('says nothing at all when the parser understood', () => {
    expect(interpretationNotice(proposalFixture())).toBeNull();
  });

  it('reads as information, never as a failure', () => {
    const notice = interpretationNotice(needsInterpretationFixture());

    // `needs-interpretation` is the ORDINARY answer for prose today: the model
    // path is refused for want of a spend ceiling. Colouring it as an error
    // teaches an operator to ignore the colour that means something.
    expect(notice?.severity).toBe('info');
    expect(notice?.title).not.toMatch(/error|failed/i);
  });

  it('tells the spend refusal apart from an unconfigured model', () => {
    const body = interpretationNotice(needsInterpretationFixture())?.body.join(
      ' ',
    );

    expect(body).toContain('No model was asked');
    expect(body).toContain('no spend ceiling');
    expect(body).toContain('No chat model is configured on this deployment');
  });

  it('says the spend gate is what refused when a model IS configured', () => {
    const proposal = needsInterpretationFixture();
    const body = interpretationNotice({
      ...proposal,
      interpretation: {
        ...proposal.interpretation,
        model: {
          consumer: 'chat',
          provider: 'anthropic',
          model: 'claude-haiku-4-5',
          available: true,
          unavailableReason: null,
        },
      },
    })?.body.join(' ');

    expect(body).toContain('anthropic / claude-haiku-4-5');
    expect(body).toContain('could have answered');
    expect(body).toContain('not the configuration');
  });

  it('offers the thing that works today rather than reporting a failure', () => {
    const notice = interpretationNotice(needsInterpretationFixture());

    expect(notice?.remedy).toContain('only work on #1, #2 and #3');
    expect(notice?.remedy).toContain('no model is needed');
  });

  it('keeps needs-interpretation out of the unresolved-reference list', () => {
    // It is not a reference that failed to resolve; it is the whole
    // instruction, and it has its own explanation above.
    expect(resolutionFailures(needsInterpretationFixture())).toEqual([]);

    const withBoth = proposalFixture({
      unresolved: [
        {
          reference: '#404',
          reason: 'issue-not-found',
          detail: 'opifex/opifex#404 could not be read.',
        },
        ...needsInterpretationFixture().unresolved,
      ],
    });
    expect(resolutionFailures(withBoth)).toHaveLength(1);
  });
});

describe('expiryNotice', () => {
  const proposedAt = new Date('2026-08-28T10:00:00.000Z');
  const expiresAt = new Date(
    proposedAt.getTime() + PROPOSAL_TTL_MINUTES * 60_000,
  ).toISOString();

  it('says how long is left, before it matters', () => {
    const notice = expiryNotice(
      expiresAt,
      new Date('2026-08-28T10:02:00.000Z'),
    );

    expect(notice.expired).toBe(false);
    expect(notice.minutesRemaining).toBe(28);
    expect(notice.urgent).toBe(false);
    expect(notice.text).toContain('expires in 28 minutes');
  });

  it('gets urgent before it expires rather than after', () => {
    const notice = expiryNotice(
      expiresAt,
      new Date('2026-08-28T10:27:00.000Z'),
    );

    expect(notice.expired).toBe(false);
    expect(notice.urgent).toBe(true);
  });

  it('reads as ask-again once it has gone', () => {
    const notice = expiryNotice(
      expiresAt,
      new Date('2026-08-28T10:41:00.000Z'),
    );

    expect(notice.expired).toBe(true);
    expect(notice.text).toContain('Ask for it again');
  });
});

describe('classifyApplied', () => {
  const write = (performed: boolean, noop = false) => ({
    label: 'factory:ready' as const,
    operation: 'add' as const,
    performed,
    noop,
  });

  it('calls a performed write written', () => {
    expect(
      classifyApplied({
        ref: 'opifex/opifex#1',
        add: ['factory:ready'],
        remove: [],
        writes: [write(true)],
      }).kind,
    ).toBe('written');
  });

  it('calls an unperformed write suppressed, not failed', () => {
    // `github-write.service.ts` answers `performed: false, noop: false` when
    // the kill switch is off: the request was accepted and nothing reached
    // GitHub.
    expect(
      classifyApplied({
        ref: 'opifex/opifex#1',
        add: ['factory:ready'],
        remove: [],
        writes: [write(false)],
      }).kind,
    ).toBe('suppressed');
  });

  it('calls an already-true write unchanged', () => {
    expect(
      classifyApplied({
        ref: 'opifex/opifex#1',
        add: ['factory:ready'],
        remove: [],
        writes: [write(true, true)],
      }).kind,
    ).toBe('unchanged');
  });
});

describe('applyHeadline', () => {
  it('reports a suppressed run on its own terms', () => {
    const result = applyResultFixture({
      writesEnabled: false,
      labelWritten: false,
      applied: [
        {
          ref: 'opifex/opifex#1',
          add: ['factory:ready'],
          remove: [],
          writes: [
            {
              label: 'factory:ready',
              operation: 'add',
              performed: false,
              noop: false,
            },
          ],
        },
      ],
      summary: {
        operationsRequested: 1,
        operationsApplied: 1,
        operationsSkipped: 0,
        labelWrites: 1,
        labelWritesPerformed: 0,
      },
    });

    const headline = applyHeadline(result);

    expect(headline.severity).toBe('warning');
    expect(headline.title).toContain('Nothing was written');
    // The SAME sentence the queue screen uses for the same kill switch.
    expect(headline.body).toContain(WRITES_DISABLED_FACT);
  });

  it('states a partial application as a fraction of what was requested', () => {
    const result = applyResultFixture({
      skipped: [
        {
          ref: 'opifex/opifex#17',
          reason: 'drift',
          detail: 'The factory labels on opifex/opifex#17 changed.',
          drift: [
            { label: 'factory:ready', wasPresent: true, isPresent: false },
          ],
        },
      ],
    });

    const headline = applyHeadline(result);

    expect(headline.severity).toBe('warning');
    expect(headline.title).toBe('1 of 2 operations applied — 1 skipped');
    expect(headline.body).toContain('stay landed');
  });

  it('calls a run where nothing applied what it is', () => {
    const result = applyResultFixture({
      applied: [],
      skipped: [
        {
          ref: 'opifex/opifex#1',
          reason: 'drift',
          detail: 'Labels moved.',
          drift: [],
        },
      ],
    });

    expect(applyHeadline(result).severity).toBe('error');
    expect(applyHeadline(result).title).toContain('0 of 1');
  });

  it('reports a clean run with the next-tick delay attached', () => {
    const headline = applyHeadline(applyResultFixture());

    expect(headline.severity).toBe('success');
    expect(headline.title).toContain('1 operation applied');
    expect(headline.body).toContain('next reconciler tick');
  });
});

describe('outcomeLine', () => {
  it('names both directions of a change, never just the additions', () => {
    expect(labelChangeLine(['factory:ready'], ['factory:hold'])).toBe(
      'factory:ready added, factory:hold removed',
    );
    expect(labelChangeLine([], ['factory:ready'])).toBe(
      'factory:ready removed',
    );
  });

  it('says writes are disabled on the issue’s own line, not only in the banner', () => {
    const [outcome] = applyOutcomes(
      applyResultFixture({
        writesEnabled: false,
        applied: [
          {
            ref: 'opifex/opifex#1',
            add: [],
            remove: ['factory:ready'],
            writes: [
              {
                label: 'factory:ready',
                operation: 'remove',
                performed: false,
                noop: false,
              },
            ],
          },
        ],
      }),
    );

    expect(outcomeLine(outcome)).toContain('factory:ready removed');
    expect(outcomeLine(outcome)).toContain(WRITES_DISABLED_FACT);
  });

  it('renders a skipped issue’s reason verbatim, in the same list', () => {
    const outcomes = applyOutcomes(
      applyResultFixture({
        skipped: [
          {
            ref: 'opifex/opifex#17',
            reason: 'drift',
            detail: 'The factory labels on opifex/opifex#17 changed.',
            drift: [
              { label: 'factory:ready', wasPresent: true, isPresent: false },
            ],
          },
        ],
      }),
    );

    expect(outcomes).toHaveLength(2);
    const skipped = outcomes[1];
    expect(skipped.kind).toBe('skipped');
    expect(outcomeLine(skipped)).toBe(
      'The factory labels on opifex/opifex#17 changed.',
    );
  });

  it('says which way a drifted label moved', () => {
    expect(
      driftLine({ label: 'factory:ready', wasPresent: true, isPresent: false }),
    ).toContain('was on the issue when this was proposed and is not now');
    expect(
      driftLine({ label: 'factory:hold', wasPresent: false, isPresent: true }),
    ).toContain('was added to the issue after this was proposed');
  });
});

describe('applyRefusal', () => {
  it('reads a 409 as staleness rather than as an error', () => {
    const refusal = applyRefusal(409, 'This proposal was made 41 minutes ago.');

    expect(refusal.stale).toBe(true);
    expect(refusal.title).toContain('stale');
    expect(refusal.title).toContain('nothing was written');
    expect(refusal.remedy).toContain('Propose the same instruction again');
    expect(refusal.remedy).toContain(`${PROPOSAL_TTL_MINUTES} minutes`);
  });

  it('explains that applying needs a person, not a token', () => {
    const refusal = applyRefusal(403, 'Forbidden');

    expect(refusal.stale).toBe(false);
    expect(refusal.remedy).toContain('interactive session');
    expect(refusal.remedy).toContain('a confirmation a script can send');
  });

  it('never calls a propose refusal stale, whatever the status', () => {
    expect(proposeRefusal(404, 'Not found').stale).toBe(false);
    expect(proposeRefusal(404, 'Not found').title).toContain('not registered');
    expect(proposeRefusal(500, 'Boom').remedy).toContain('Nothing was written');
  });
});
