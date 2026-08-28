/**
 * How a label report is PRESENTED (#415).
 *
 * The module is pure, so the cases that decide whether the ladder tells the
 * truth can be asserted without a React tree. Every case below is one a
 * plausible implementation gets wrong:
 *
 *  - **"0 of 15 present" for an answer that observed nothing.** Every
 *    GitHub-level failure carries `present: 0`, `declared: 15` and an EMPTY
 *    `labels` array. Reading the counters without checking whether anything
 *    was read turns "nobody could ask" into "the repository has no labels" —
 *    a different fact, with a different fix, and it sends an operator to
 *    create fifteen labels that may all already exist.
 *  - **Reading `state` after a repair.** The API deliberately does not rewrite
 *    `state` when a write succeeds, so a created label still reads
 *    `state: 'missing'`. An outcome derived from `state` reports the label it
 *    just created as still absent.
 *  - **Offering repair where it cannot help.** `refused` and `no_credential`
 *    are not fixed by pressing the button again, and a button that is there
 *    says they might be.
 *  - **Calling a partial repair a failure.** Eleven labels created and one
 *    refused is a mixed answer, and the eleven stay created.
 */

import { describe, expect, it } from 'vitest';

import {
  canRepair,
  countSentence,
  driftedLabels,
  failedLabels,
  groupByKind,
  labelStatusPresentation,
  missingLabels,
  observationPresentation,
  outstandingLabels,
  registrationLabelLine,
  registrationLabelNote,
  repairOutcome,
  repairedLabels,
  wasRead,
} from '../../config/repositoryLabels';
import {
  DECLARED_LABELS,
  labelFailureFixture,
  labelReportFixture,
} from '../mocks/repositories';
import type { LabelProvisioningStatus } from '../../types/repositoryLabels';

/** Every status for which the API sends an empty `labels` array. */
const GITHUB_FAILURES: LabelProvisioningStatus[] = [
  'no_credential',
  'invalid_credential',
  'refused',
  'not_found',
  'rate_limited',
  'unreachable',
  'failed',
];

describe('wasRead — the gate on every count', () => {
  it('is true when GitHub answered and every declared label is present', () => {
    expect(wasRead(labelReportFixture())).toBe(true);
  });

  it('is true when GitHub answered and some labels are missing', () => {
    expect(wasRead(labelReportFixture({ missing: ['factory:ready'] }))).toBe(
      true,
    );
  });

  it.each(GITHUB_FAILURES)('is false for %s', (status) => {
    expect(wasRead(labelFailureFixture(status, 'GitHub said no.'))).toBe(false);
  });

  it('is false for a status this build has never heard of', () => {
    const report = {
      ...labelFailureFixture('failed', 'x'),
      status: 'quarantined' as LabelProvisioningStatus,
    };
    expect(wasRead(report)).toBe(false);
  });
});

describe('countSentence', () => {
  it('counts what was found against what is declared', () => {
    const report = labelReportFixture({
      missing: ['factory:ready', 'tier:small', 'factory/review'],
    });
    expect(countSentence(report)).toBe(
      `${DECLARED_LABELS.length - 3} of ${DECLARED_LABELS.length} labels present`,
    );
  });

  it.each(GITHUB_FAILURES)(
    'answers null for %s rather than a zero, because nothing was observed',
    (status) => {
      const report = labelFailureFixture(status, 'GitHub said no.');
      // The single most important assertion in this file. `report.present` is
      // 0 and `report.declared` is 15, and a sentence built from those two
      // would be a claim about a repository nobody managed to read.
      expect(countSentence(report)).toBeNull();
    },
  );
});

describe('observationPresentation', () => {
  it('leads with the count when the labels were read', () => {
    const presentation = observationPresentation(
      labelReportFixture({ missing: ['factory:ready'] }),
    );
    expect(presentation.title).toBe(
      `${DECLARED_LABELS.length - 1} of ${DECLARED_LABELS.length} labels present`,
    );
    expect(presentation.severity).toBe('warning');
  });

  it('leads with the situation when nothing was read', () => {
    const presentation = observationPresentation(
      labelFailureFixture('refused', 'GitHub answered 403.'),
    );
    expect(presentation.title).not.toMatch(/\d+ of \d+/);
    expect(presentation.title.toLowerCase()).toContain('not permitted');
  });

  it('is a success when every declared label is there', () => {
    const presentation = observationPresentation(labelReportFixture());
    expect(presentation.severity).toBe('success');
    expect(presentation.title).toBe(
      `${DECLARED_LABELS.length} of ${DECLARED_LABELS.length} labels present`,
    );
  });
});

describe('canRepair — offered only where pressing it could change something', () => {
  it('is offered when the read succeeded and something is missing', () => {
    expect(canRepair(labelReportFixture({ missing: ['factory:ready'] }))).toBe(
      true,
    );
  });

  it('is not offered when everything is already present', () => {
    expect(canRepair(labelReportFixture())).toBe(false);
  });

  it.each(GITHUB_FAILURES)('is not offered for %s', (status) => {
    expect(canRepair(labelFailureFixture(status, 'GitHub said no.'))).toBe(
      false,
    );
  });

  it('is not offered for a status this build cannot interpret', () => {
    const report = {
      ...labelFailureFixture('failed', 'x'),
      status: 'quarantined' as LabelProvisioningStatus,
    };
    expect(canRepair(report)).toBe(false);
    expect(labelStatusPresentation(report.status).title).toContain(
      'quarantined',
    );
  });
});

describe('labelStatusPresentation — a different remedy per status', () => {
  it('sends a refusal to the token’s permissions, not to a new token', () => {
    const refused = labelStatusPresentation('refused').remedy;
    expect(refused).toContain('permission');
    expect(refused).not.toMatch(/replace it in the credentials section/i);
  });

  it('sends a rejected credential to a replacement', () => {
    expect(labelStatusPresentation('invalid_credential').remedy).toMatch(
      /replace it/i,
    );
  });

  it('says an unreachable GitHub is not a verdict on the token', () => {
    expect(labelStatusPresentation('unreachable').remedy).toContain(
      'nothing at all about the token',
    );
  });

  it('gives every declared status its own remedy', () => {
    const statuses: LabelProvisioningStatus[] = [
      'ok',
      'incomplete',
      ...GITHUB_FAILURES,
    ];
    const remedies = statuses.map(
      (status) => labelStatusPresentation(status).remedy,
    );
    expect(new Set(remedies).size).toBe(statuses.length);
  });
});

describe('which labels a report is about', () => {
  const report = labelReportFixture({
    missing: ['factory:ready'],
    drifted: { 'tier:small': ['color 8fd9a8 -> ededed'] },
  });

  it('names the missing ones', () => {
    expect(missingLabels(report).map((label) => label.name)).toEqual([
      'factory:ready',
    ]);
  });

  it('names the drifted ones with what differs', () => {
    expect(driftedLabels(report)).toEqual([
      expect.objectContaining({
        name: 'tier:small',
        differences: ['color 8fd9a8 -> ededed'],
      }),
    ]);
  });

  it('counts both as outstanding on an inspection', () => {
    expect(outstandingLabels(report).map((label) => label.name)).toEqual([
      'factory:ready',
      'tier:small',
    ]);
  });

  it('drops a label a repair created, even though its state still says missing', () => {
    const repaired = labelReportFixture({
      applied: true,
      missing: ['factory:ready'],
      created: ['factory:ready'],
    });
    // The trap: `state` is deliberately not rewritten by a successful write.
    expect(
      repaired.labels.find((label) => label.name === 'factory:ready')?.state,
    ).toBe('missing');
    expect(outstandingLabels(repaired)).toEqual([]);
    expect(repairedLabels(repaired).map((label) => label.name)).toEqual([
      'factory:ready',
    ]);
  });

  it('keeps a label whose write failed outstanding, and carries its reason', () => {
    const repaired = labelReportFixture({
      applied: true,
      missing: ['factory:ready', 'tier:small'],
      created: ['tier:small'],
      failed: { 'factory:ready': 'GitHub answered 403.' },
    });
    expect(outstandingLabels(repaired).map((label) => label.name)).toEqual([
      'factory:ready',
    ]);
    expect(failedLabels(repaired)).toEqual([
      expect.objectContaining({
        name: 'factory:ready',
        detail: 'GitHub answered 403.',
      }),
    ]);
  });
});

describe('groupByKind', () => {
  it('orders input before mirror before routing, whatever the input order', () => {
    const report = labelReportFixture({
      missing: ['tier:small', 'factory/review', 'factory:ready'],
    });
    expect(groupByKind(outstandingLabels(report)).map((g) => g.kind)).toEqual([
      'input',
      'mirror',
      'routing',
    ]);
  });

  it('says what a missing input label costs, naming the eligibility signal', () => {
    const groups = groupByKind(
      outstandingLabels(labelReportFixture({ missing: ['factory:ready'] })),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].presentation.consequence).toContain('factory:ready');
  });

  it('does not claim a missing routing label stops work', () => {
    const groups = groupByKind(
      outstandingLabels(labelReportFixture({ missing: ['tier:small'] })),
    );
    expect(groups[0].presentation.consequence).toContain('runs still happen');
  });

  it('keeps a kind this build has never heard of rather than dropping it', () => {
    const groups = groupByKind([
      {
        name: 'weird:thing',
        kind: 'ceremonial' as never,
        state: 'missing',
        action: 'none',
        differences: [],
        detail: null,
      },
    ]);
    expect(groups.map((g) => g.kind)).toEqual(['ceremonial']);
    expect(groups[0].presentation.consequence).toContain('does not recognise');
  });
});

describe('repairOutcome — what the write actually did', () => {
  it('reports created and updated counts, not the stale states', () => {
    const outcome = repairOutcome(
      labelReportFixture({
        applied: true,
        missing: ['factory:ready', 'tier:small'],
        drifted: { 'factory/review': ['description'] },
        created: ['factory:ready', 'tier:small'],
        updated: ['factory/review'],
      }),
    );
    expect(outcome.severity).toBe('success');
    expect(outcome.title).toBe('2 created, 1 updated');
    expect(outcome.body).toContain(
      `${DECLARED_LABELS.length} of ${DECLARED_LABELS.length}`,
    );
  });

  it('reports a partial failure as partial, keeping what was written', () => {
    const outcome = repairOutcome(
      labelReportFixture({
        applied: true,
        missing: ['factory:ready', 'tier:small'],
        created: ['tier:small'],
        failed: { 'factory:ready': 'GitHub answered 403.' },
      }),
    );
    expect(outcome.severity).toBe('warning');
    expect(outcome.title).toBe('1 written, 1 failed');
    expect(outcome.body).toContain('stay written');
  });

  it('says nothing was written when every write was refused', () => {
    const outcome = repairOutcome(
      labelReportFixture({
        applied: true,
        missing: ['factory:ready'],
        failed: { 'factory:ready': 'GitHub answered 403.' },
      }),
    );
    expect(outcome.title).toContain('No label could be written');
  });

  it('reports an idempotent second run as the no-op it is', () => {
    const outcome = repairOutcome(labelReportFixture({ applied: true }));
    expect(outcome.severity).toBe('success');
    expect(outcome.title).toBe('Nothing needed creating');
    expect(outcome.body).toContain('no-op');
  });

  it('never claims a count when GitHub refused the whole call', () => {
    const outcome = repairOutcome(
      labelFailureFixture('refused', 'GitHub answered 403.', {
        applied: true,
      }),
    );
    expect(outcome.title).toBe('Nothing was written');
    expect(outcome.body).not.toMatch(/0 of \d+/);
    expect(outcome.body).toContain('No label on this repository was created');
  });
});

describe('registrationLabelNote — two facts, in one sentence each', () => {
  it('says nothing when provisioning was clean', () => {
    expect(
      registrationLabelNote('acme/widgets', labelReportFixture()),
    ).toBeNull();
  });

  it('says both facts when the token was refused', () => {
    const note = registrationLabelNote(
      'acme/widgets',
      labelFailureFixture('refused', 'GitHub answered 403 for labels.'),
    );
    expect(note).not.toBeNull();
    // Registered FIRST: the repository is registered whatever the labels did,
    // and a note that read as a failed registration would be false.
    expect(note?.title).toContain('acme/widgets is registered');
    expect(note?.body).toContain('The registration itself stands');
    // And the API's own sentence survives.
    expect(note?.body).toContain('GitHub answered 403 for labels.');
    // And it is not dressed up as a fault in the repository.
    expect(note?.severity).toBe('warning');
  });

  it('names how many are absent when some labels could not be made', () => {
    const note = registrationLabelNote(
      'acme/widgets',
      labelReportFixture({
        applied: true,
        missing: ['factory:ready', 'tier:small'],
        created: ['tier:small'],
        failed: { 'factory:ready': 'GitHub answered 403.' },
      }),
    );
    expect(note?.title).toContain('acme/widgets is registered');
    expect(note?.title).toContain(`2 of ${DECLARED_LABELS.length}`);
  });

  it('flags a null report as the anomaly it is, without failing the registration', () => {
    const note = registrationLabelNote('acme/widgets', null);
    expect(note?.title).toContain('acme/widgets is registered');
    expect(note?.body).toContain('should not happen');
  });

  it('says nothing at all when the API published no such field', () => {
    // An API from before #415. There is no outcome to describe and no action
    // to offer, and a warning on every registration nobody can act on is one
    // nobody reads.
    expect(registrationLabelNote('acme/widgets', undefined)).toBeNull();
  });
});

describe('registrationLabelLine — one line per row in a batch report', () => {
  it('says how many were created', () => {
    expect(
      registrationLabelLine(
        labelReportFixture({
          applied: true,
          missing: ['factory:ready'],
          created: ['factory:ready'],
        }),
      ),
    ).toBe(`1 of ${DECLARED_LABELS.length} labels created.`);
  });

  it('says so when they were all already there', () => {
    expect(registrationLabelLine(labelReportFixture({ applied: true }))).toBe(
      `All ${DECLARED_LABELS.length} labels were already present.`,
    );
  });

  it('never says "0 of 15" for a refusal', () => {
    const line = registrationLabelLine(
      labelFailureFixture('refused', 'GitHub answered 403.'),
    );
    expect(line).not.toContain(`0 of ${DECLARED_LABELS.length}`);
    expect(line).toContain('Labels not created');
  });

  it('answers null when the API published no such field', () => {
    expect(registrationLabelLine(undefined)).toBeNull();
  });
});
