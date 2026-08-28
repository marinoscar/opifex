/**
 * How a label report is PRESENTED (#415).
 *
 * The module is pure, so the cases that decide whether the ladder tells the
 * truth can be asserted without a React tree. Every case below is one a
 * plausible implementation gets wrong:
 *
 *  - **"0 of 15 present" for an answer that observed nothing.** A report whose
 *    label list was never fetched carries NULL counts and an empty `labels`
 *    array. Rendering a number from it turns "nobody could ask" into "the
 *    repository has no labels" — a different fact, with a different fix, and
 *    it sends an operator to create fifteen labels that may all already exist.
 *  - **Blanking a WRITE-phase refusal.** The mirror image, and the subtler of
 *    the two. A repair whose read succeeded and whose write GitHub then
 *    refused is still `status: 'refused'` and has REAL counts — it knows
 *    exactly what is on the repository. A gate keyed on `status` rather than
 *    on the nulls throws that observation away and reports "we could not ask"
 *    about an answer that asked and found out.
 *  - **Reading `stateBefore` after a repair.** The API deliberately does not
 *    rewrite it when a write succeeds, so a created label still reads
 *    `stateBefore: 'missing'`. An outcome derived from it reports the label it
 *    just created as still absent.
 *  - **Offering repair where it cannot help.** `refused` and `no_credential`
 *    are not fixed by pressing the button again, and a button that is there
 *    says they might be — including after a write-phase refusal, which was
 *    refused for exactly the reason a second attempt would be.
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
  labelWriteRefusalFixture,
} from '../mocks/repositories';
import type { LabelProvisioningStatus } from '../../types/repositoryLabels';

/** Every status a READ can fail with — the reports that carry no counts. */
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

  it.each(GITHUB_FAILURES)(
    'is false for a %s that failed at the READ, which has null counts',
    (status) => {
      expect(wasRead(labelFailureFixture(status, 'GitHub said no.'))).toBe(
        false,
      );
    },
  );

  it('is false for a status this build has never heard of', () => {
    const report = {
      ...labelFailureFixture('failed', 'x'),
      status: 'quarantined' as LabelProvisioningStatus,
    };
    expect(wasRead(report)).toBe(false);
  });

  /**
   * The case that separates a null check from a `status` check.
   *
   * A repair whose read succeeded and whose WRITE was refused is still
   * `status: 'refused'` — and it knows exactly what is on the repository,
   * because it listed the labels before trying. Blanking it would throw away a
   * real observation to satisfy a rule about a word.
   */
  it('is TRUE for a write-phase refusal, whose status is a failure word', () => {
    const report = labelWriteRefusalFixture({
      missing: ['factory:ready', 'tier:small'],
    });
    expect(report.status).toBe('refused');
    expect(report.ok).toBe(false);
    expect(report.present).not.toBeNull();
    expect(wasRead(report)).toBe(true);
  });

  it('is true for a write-phase failure of any status', () => {
    for (const status of GITHUB_FAILURES) {
      const report = labelWriteRefusalFixture({
        status,
        missing: ['factory:ready'],
      });
      expect(wasRead(report)).toBe(true);
    }
  });

  it('degrades to false if the API ever nulls only some of the counts', () => {
    // The API's contract is that the seven move together, and this checks all
    // seven rather than trusting that. A partial report is a contract
    // violation, and treating it as unread is the safe direction: the failure
    // being guarded against is rendering a number nobody established.
    const report = { ...labelReportFixture(), missing: null };
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
      // The single most important assertion in this file. Every counter is
      // null, and any sentence built from them would be a claim about a
      // repository nobody managed to read.
      expect(countSentence(report)).toBeNull();
    },
  );

  it('DOES count a write-phase refusal, which read the labels first', () => {
    const report = labelWriteRefusalFixture({
      missing: ['factory:ready', 'tier:small'],
    });
    expect(countSentence(report)).toBe(
      `${DECLARED_LABELS.length - 2} of ${DECLARED_LABELS.length} labels present`,
    );
  });

  it('counts what a cut-short write managed to create', () => {
    // Three were missing, one was created, and GitHub then refused the rest.
    const report = labelWriteRefusalFixture({
      missing: ['factory:ready', 'tier:small', 'factory/review'],
      created: ['factory:ready'],
    });
    expect(countSentence(report)).toBe(
      `${DECLARED_LABELS.length - 2} of ${DECLARED_LABELS.length} labels present`,
    );
  });
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

  /**
   * The check the coordinator asked to be made deliberate rather than
   * accidental.
   *
   * A write-phase refusal knows its counts — `wasRead` is true — and must
   * still not offer the button. The decision is made from `status`, which is
   * the field that names the REMEDY, and "would pressing this again help?" is
   * a question about the remedy rather than about how much was observed. This
   * report was refused for precisely the reason a second attempt would be.
   */
  it('is not offered for a write-phase refusal, even though it was read', () => {
    const report = labelWriteRefusalFixture({ missing: ['factory:ready'] });
    expect(wasRead(report)).toBe(true);
    expect(canRepair(report)).toBe(false);
  });

  it('is not offered for a write cut short by a rate limit either', () => {
    const report = labelWriteRefusalFixture({
      status: 'rate_limited',
      missing: ['factory:ready'],
    });
    expect(wasRead(report)).toBe(true);
    // Waiting is the remedy; a repair issued now spends another refused
    // request. Check labels is what clears it.
    expect(canRepair(report)).toBe(false);
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
      attempted: true,
      missing: ['factory:ready'],
      created: ['factory:ready'],
    });
    // The trap: `state` is deliberately not rewritten by a successful write.
    expect(
      repaired.labels.find((label) => label.name === 'factory:ready')
        ?.stateBefore,
    ).toBe('missing');
    expect(outstandingLabels(repaired)).toEqual([]);
    expect(repairedLabels(repaired).map((label) => label.name)).toEqual([
      'factory:ready',
    ]);
  });

  it('keeps everything a cut-short write never reached', () => {
    // The loop stopped where GitHub refused it, so the remainder is untouched
    // — `action: 'none'` with `stateBefore: 'missing'` — rather than marked
    // failed. Both are outstanding; only the created one is not.
    const report = labelWriteRefusalFixture({
      missing: ['factory:ready', 'tier:small', 'factory/review'],
      created: ['factory:ready'],
    });
    expect(outstandingLabels(report).map((label) => label.name)).toEqual([
      'factory/review',
      'tier:small',
    ]);
    expect(repairedLabels(report).map((label) => label.name)).toEqual([
      'factory:ready',
    ]);
    expect(failedLabels(report)).toEqual([]);
  });

  it('keeps a label whose write failed outstanding, and carries its reason', () => {
    const repaired = labelReportFixture({
      attempted: true,
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
        stateBefore: 'missing',
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
        attempted: true,
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
        attempted: true,
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
        attempted: true,
        missing: ['factory:ready'],
        failed: { 'factory:ready': 'GitHub answered 403.' },
      }),
    );
    expect(outcome.title).toContain('No label could be written');
  });

  it('reports an idempotent second run as the no-op it is', () => {
    const outcome = repairOutcome(labelReportFixture({ attempted: true }));
    expect(outcome.severity).toBe('success');
    expect(outcome.title).toBe('Nothing needed creating');
    expect(outcome.body).toContain('no-op');
  });

  /**
   * A write GitHub cut short: real counts, a failure status, `failed: 0`.
   *
   * Distinct from a per-label failure — the remedy is about the repository,
   * not about the labels that did not take — and distinct from an unread
   * report, whose counts do not exist. Both distinctions are worth the arm:
   * the first decides which remedy is printed, the second decides whether a
   * number may be printed at all.
   */
  it('reports what a cut-short write managed, and why it stopped', () => {
    const report = labelWriteRefusalFixture({
      missing: ['factory:ready', 'tier:small', 'factory/review'],
      created: ['factory:ready'],
    });
    const outcome = repairOutcome(report);

    expect(outcome.title).toBe('1 written before GitHub stopped the rest');
    // The count is real and is said, because the read succeeded.
    expect(outcome.body).toContain(
      `${DECLARED_LABELS.length - 2} of ${DECLARED_LABELS.length}`,
    );
    // And the remedy is the refusal's, not "create the missing ones below".
    expect(outcome.body).toContain('Issues: read and write');
    expect(outcome.body).toContain('counting what this attempt managed');
  });

  it('leads with the reason when a cut-short write managed nothing', () => {
    const outcome = repairOutcome(
      labelWriteRefusalFixture({ missing: ['factory:ready'] }),
    );
    expect(outcome.title).toBe(
      'The credential authenticated and was not permitted',
    );
    expect(outcome.body).toContain('unchanged by this attempt');
    // Still a real count — this is the case a status-keyed gate would blank.
    expect(outcome.body).toContain(
      `${DECLARED_LABELS.length - 1} of ${DECLARED_LABELS.length}`,
    );
  });

  it('does not call a cut-short write a success', () => {
    // `created > 0` and `failed === 0` is the shape of a clean partial repair,
    // and reading only those two would report this one as "1 created".
    const outcome = repairOutcome(
      labelWriteRefusalFixture({
        missing: ['factory:ready', 'tier:small'],
        created: ['factory:ready'],
      }),
    );
    expect(outcome.severity).not.toBe('success');
    expect(outcome.title).not.toBe('1 created');
  });

  it('never claims a count when GitHub refused the whole call', () => {
    const outcome = repairOutcome(
      labelFailureFixture('refused', 'GitHub answered 403.', {
        attempted: true,
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
        attempted: true,
        missing: ['factory:ready', 'tier:small'],
        created: ['tier:small'],
        failed: { 'factory:ready': 'GitHub answered 403.' },
      }),
    );
    expect(note?.title).toContain('acme/widgets is registered');
    expect(note?.title).toContain(`2 of ${DECLARED_LABELS.length}`);
  });

  it('names the count for a write-phase refusal, which knows it', () => {
    const note = registrationLabelNote(
      'acme/widgets',
      labelWriteRefusalFixture({
        repository: 'acme/widgets',
        missing: ['factory:ready', 'tier:small'],
      }),
    );
    expect(note?.title).toContain('acme/widgets is registered');
    expect(note?.title).toContain(`2 of ${DECLARED_LABELS.length} labels`);
    // And it does not send the operator to a button that is not offered.
    expect(note?.body).not.toContain('use Create missing labels');
    expect(note?.body).toContain('check its labels again');
  });

  it('points at the repair button only where the repair is offered', () => {
    const note = registrationLabelNote(
      'acme/widgets',
      labelReportFixture({
        repository: 'acme/widgets',
        attempted: true,
        missing: ['factory:ready'],
        failed: { 'factory:ready': 'GitHub answered 422.' },
      }),
    );
    expect(note?.body).toContain('use Create missing labels');
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
          attempted: true,
          missing: ['factory:ready'],
          created: ['factory:ready'],
        }),
      ),
    ).toBe(`1 of ${DECLARED_LABELS.length} labels created.`);
  });

  it('says so when they were all already there', () => {
    expect(registrationLabelLine(labelReportFixture({ attempted: true }))).toBe(
      `All ${DECLARED_LABELS.length} labels were already present.`,
    );
  });

  it('counts a write-phase refusal rather than refusing to', () => {
    expect(
      registrationLabelLine(
        labelWriteRefusalFixture({ missing: ['factory:ready'] }),
      ),
    ).toBe(
      `${DECLARED_LABELS.length - 1} of ${DECLARED_LABELS.length} labels present.`,
    );
  });

  it('never says "0 of 15" for a read-phase refusal', () => {
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
