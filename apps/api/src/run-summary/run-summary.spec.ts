import {
  composeRunSummary,
  formatCost,
  formatDuration,
  RUN_SUMMARY_MARKER,
  whyItStopped,
  type RunSummaryFacts,
} from './run-summary';

/**
 * VISION §5 calls the run summary "the gap most systems miss", and VISION §1
 * says why it has to be written at the time: lost hours can be recovered by
 * working faster; lost provenance cannot be recovered at all.
 */

function facts(overrides: Partial<RunSummaryFacts> = {}): RunSummaryFacts {
  return {
    runId: '018f2c31-7a4e-7c3b-9f21-4d5e6a7b8c9d',
    workOrderIdentity: 'wo_opifex_312_a3f91c2_a1',
    attempt: 1,
    retryCeiling: 3,
    runnerKey: 'claude-code-local',
    runnerVersion: '2.1.223',
    status: 'succeeded',
    startedAt: new Date('2026-08-23T10:00:00.000Z'),
    endedAt: new Date('2026-08-23T10:12:04.000Z'),
    costUsd: 0.4231,
    tokensInput: 12000,
    tokensOutput: 3400,
    attentionReason: null,
    ...overrides,
  };
}

describe('whyItStopped', () => {
  it('is the recorded attentionReason when there is one', () => {
    // #67: succeeded, killed for silence, killed for looping, budget exceeded,
    // timed out, quarantined after N attempts — "each is a different story".
    // Those stories are written by whichever mechanism stopped the run.
    expect(whyItStopped(facts({ attentionReason: 'killed for looping' }))).toBe(
      'killed for looping',
    );
  });

  it('does not re-derive a reason that was already recorded', () => {
    // Re-deriving would produce a second opinion about a settled fact, and the
    // two would eventually differ. A failed run with a reason keeps its reason.
    const reason = 'budget ceiling of $5.00 exceeded by $35.10';
    expect(
      whyItStopped(facts({ status: 'failed', attentionReason: reason })),
    ).toBe(reason);
  });

  it('says the run succeeded when nothing needed attention', () => {
    expect(whyItStopped(facts())).toContain('reported success');
  });

  it('says so plainly when a non-success recorded no reason', () => {
    // An empty cell would read as "no reason was needed", which is a different
    // and wrong claim.
    expect(
      whyItStopped(facts({ status: 'failed', attentionReason: null })),
    ).toBe('Ended as failed with no reason recorded.');
  });
});

describe('formatDuration', () => {
  it('renders minutes and seconds', () => {
    expect(
      formatDuration(
        new Date('2026-08-23T10:00:00Z'),
        new Date('2026-08-23T10:12:04Z'),
      ),
    ).toBe('12m 04s');
  });

  it('renders hours when there are any', () => {
    expect(
      formatDuration(
        new Date('2026-08-23T10:00:00Z'),
        new Date('2026-08-23T11:04:12Z'),
      ),
    ).toBe('1h 04m 12s');
  });

  it('is a dash for a run that never concluded', () => {
    expect(formatDuration(new Date(), null)).toBe('—');
  });

  it('never renders a negative duration from clock skew', () => {
    expect(
      formatDuration(
        new Date('2026-08-23T10:05:00Z'),
        new Date('2026-08-23T10:00:00Z'),
      ),
    ).toBe('0m 00s');
  });
});

describe('formatCost', () => {
  it('keeps unknown and zero distinct', () => {
    // VISION §6 makes cost reporting a declared capability. A runner that
    // cannot report cost must not be shown as one that spent nothing.
    expect(formatCost(null)).toBe('not reported');
    expect(formatCost(0)).toBe('$0.0000');
  });

  it('renders to four places, matching the column', () => {
    expect(formatCost(0.4231)).toBe('$0.4231');
  });
});

describe('composeRunSummary', () => {
  it('states everything #67 asks for', () => {
    const body = composeRunSummary(facts());

    expect(body).toContain('claude-code-local@2.1.223'); // runner and version
    expect(body).toContain('$0.4231'); // cost
    expect(body).toContain('12m 04s'); // duration
    expect(body).toContain('1 of 3'); // attempts
    expect(body).toContain('reported success'); // why it stopped
  });

  it('carries the identifiers in the marker, for a later extractor', () => {
    // #67 asks that the format be "stable enough to parse later, per VISION
    // §5's knowledge-graph ambition". Attributes on the marker are readable
    // without parsing prose or a table.
    const body = composeRunSummary(facts());

    expect(body.startsWith(RUN_SUMMARY_MARKER)).toBe(true);
    expect(body).toContain('run=018f2c31-7a4e-7c3b-9f21-4d5e6a7b8c9d');
    expect(body).toContain('work-order=wo_opifex_312_a3f91c2_a1');
    expect(body).toContain('attempt=1');
  });

  it('links to the telemetry by run id', () => {
    // "It is the join point between the human-readable record and the
    // telemetry store" — a doorway to the detail, not a replacement for it.
    expect(composeRunSummary(facts())).toContain('event stream');
    expect(composeRunSummary(facts())).toContain(
      '018f2c31-7a4e-7c3b-9f21-4d5e6a7b8c9d',
    );
  });

  it('names a runner that reports no version without inventing one', () => {
    const body = composeRunSummary(facts({ runnerVersion: null }));
    expect(body).toContain('`claude-code-local`');
    expect(body).not.toContain('@null');
  });

  it('says tokens are not reported rather than showing zero', () => {
    const body = composeRunSummary(
      facts({ tokensInput: null, tokensOutput: null }),
    );
    expect(body).toContain('not reported');
    expect(body).not.toContain('0 in / 0 out');
  });

  it('leads with why it stopped, which is the field that carries the value', () => {
    const body = composeRunSummary(
      facts({ status: 'failed', attentionReason: 'killed for silence' }),
    );
    const rows = body.split('\n').filter((line) => line.startsWith('| **'));
    expect(rows[0]).toContain('Why it stopped');
    expect(rows[0]).toContain('killed for silence');
  });
});
