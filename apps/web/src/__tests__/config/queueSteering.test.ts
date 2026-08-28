/**
 * The wording of a bulk steer (#421).
 *
 * These are the sentences an operator reads after asking for something that
 * writes to GitHub, so they are asserted directly rather than through a
 * rendered table. The three properties under test are the three the feature
 * can get wrong without failing:
 *
 *  1. A partial application never reads as a complete one.
 *  2. A suppressed write (`labelWritten: false`, HTTP 200) never reads as a
 *     success.
 *  3. A release never reads as though it restored a queue position or cleared
 *     a quarantine.
 */

import { describe, expect, it } from 'vitest';

import {
  RELEASE_CAVEATS,
  bulkPresentation,
  classifyResult,
  outcomeLine,
  refusalRemedies,
  unappliedIds,
  type SteerOutcome,
} from '../../config/queueSteering';
import {
  steerResultFixture,
  suppressedSteerResultFixture,
} from '../mocks/queueSteering';

function written(id: string): SteerOutcome {
  return {
    kind: 'written',
    workOrderId: id,
    identity: id,
    label: 'factory:ready',
  };
}

function suppressed(id: string): SteerOutcome {
  return {
    kind: 'suppressed',
    workOrderId: id,
    identity: id,
    label: 'factory:ready',
  };
}

function refused(id: string, status: number | null): SteerOutcome {
  return {
    kind: 'refused',
    workOrderId: id,
    identity: id,
    failure: { status, detail: 'Work order wo-x not found' },
  };
}

describe('classifyResult', () => {
  it('reads labelWritten rather than the HTTP status', () => {
    // Both of these are 200s as far as the transport is concerned. The only
    // thing telling them apart is the field.
    expect(classifyResult('wo-1', steerResultFixture()).kind).toBe('written');
    expect(classifyResult('wo-1', suppressedSteerResultFixture()).kind).toBe(
      'suppressed',
    );
  });

  it('keys the outcome on the id that was sent, not the one answered', () => {
    // The queue renders identities and the endpoint answers with the row id.
    // Keying on the response would leave every steered row selected forever.
    const result = steerResultFixture({ workOrderId: 'row-id-from-postgres' });

    expect(classifyResult('wo_opifex_401_b7c2d10_a1', result).workOrderId).toBe(
      'wo_opifex_401_b7c2d10_a1',
    );
  });
});

describe('unappliedIds', () => {
  it('keeps the refusals AND the suppressed writes, and drops what landed', () => {
    const outcomes = [
      written('wo-1'),
      suppressed('wo-2'),
      refused('wo-3', 404),
    ];

    // wo-2 has no label on GitHub either. Dropping it would make the retry
    // that a re-enabled writesEnabled needs impossible to aim.
    expect(unappliedIds(outcomes)).toEqual(['wo-2', 'wo-3']);
  });
});

describe('bulkPresentation', () => {
  it('has nothing to say about a run that never happened', () => {
    expect(bulkPresentation([], 'hold')).toBeNull();
  });

  it('reports a whole run as a success naming the label it wrote', () => {
    const presentation = bulkPresentation(
      [written('wo-1'), written('wo-2'), written('wo-3')],
      'release',
    );

    expect(presentation?.severity).toBe('success');
    expect(presentation?.title).toContain('3 work orders');
    expect(presentation?.title).toContain('factory:ready');
    expect(presentation?.body).toContain('next tick');
  });

  it('never calls an all-suppressed run a success, at any severity', () => {
    const presentation = bulkPresentation(
      [suppressed('wo-1'), suppressed('wo-2'), suppressed('wo-3')],
      'release',
    );

    // The one assertion this whole feature turns on. Three requests answered
    // 200 and three labels do not exist.
    expect(presentation?.severity).not.toBe('success');
    expect(presentation?.title).toContain('Nothing was written');
    expect(presentation?.title.toLowerCase()).not.toContain('marked ready');
    expect(presentation?.body).toContain('writes are disabled');
    expect(presentation?.body).toContain('no label was written');
  });

  it('states a mixed run as a fraction of what was attempted', () => {
    const presentation = bulkPresentation(
      [written('wo-1'), written('wo-2'), refused('wo-3', 404)],
      'release',
    );

    expect(presentation?.severity).toBe('warning');
    // "2 written" alone would read as the whole answer. The denominator is
    // what makes a partial application unmistakable.
    expect(presentation?.title).toContain('2 of 3 written');
    expect(presentation?.title).toContain('1 refused');
  });

  it('says writes are disabled even when only some of the run was suppressed', () => {
    const presentation = bulkPresentation(
      [written('wo-1'), suppressed('wo-2')],
      'hold',
    );

    expect(presentation?.title).toContain('1 of 2 written');
    expect(presentation?.title).toContain('1 not written');
    expect(presentation?.body).toContain('writes are disabled');
  });

  it('does not roll the successes back, and says so', () => {
    const presentation = bulkPresentation(
      [written('wo-1'), refused('wo-2', 403)],
      'hold',
    );

    expect(presentation?.body).toContain('stay landed');
  });

  it('reports a wholly refused run as an error with everything still selected', () => {
    const presentation = bulkPresentation(
      [refused('wo-1', 403), refused('wo-2', 403)],
      'hold',
    );

    expect(presentation?.severity).toBe('error');
    expect(presentation?.title).toContain('0 of 2');
    expect(presentation?.body).toContain('still selected');
  });
});

describe('outcomeLine', () => {
  it('says a written release lands at the BACK of the queue', () => {
    const line = outcomeLine(written('wo-1'), 'release');

    // `work-order-projection.service.ts` re-stamps `queuedAt` when a hold
    // lifts. A line implying the work order returns to where it was would be
    // a promise the projection does not keep.
    expect(line).toContain('BACK of the queue');
    expect(line).toContain('nothing is ready yet');
  });

  it('says a written hold is not yet a hold', () => {
    const line = outcomeLine(written('wo-1'), 'hold');

    expect(line).toContain('next reconciler tick');
    expect(line).toContain('nothing is held yet');
  });

  it('says a suppressed line was not written and names the reason', () => {
    const line = outcomeLine(suppressed('wo-1'), 'release');

    expect(line).toContain('Not written');
    expect(line).toContain('never reached GitHub');
    expect(line).toContain('writes are disabled');
  });

  it('quotes the API verbatim on a refusal, after this build’s heading', () => {
    const line = outcomeLine(refused('wo-1', 404), 'hold');

    expect(line).toContain('no longer a work order the API knows');
    expect(line).toContain('Work order wo-x not found');
  });

  it('names a status it has no arm for rather than guessing at a remedy', () => {
    const line = outcomeLine(refused('wo-1', 500), 'hold');

    expect(line).toContain('could not be steered');
    expect(line).toContain('Work order wo-x not found');
  });
});

describe('refusalRemedies', () => {
  it('says one remedy per KIND of refusal, not one per work order', () => {
    const remedies = refusalRemedies([
      refused('wo-1', 403),
      refused('wo-2', 403),
      refused('wo-3', 404),
      written('wo-4'),
    ]);

    expect(remedies).toHaveLength(2);
    expect(remedies[0]).toContain('workorders:write');
  });
});

describe('RELEASE_CAVEATS', () => {
  it('states the queue-position asymmetry and the quarantine rule', () => {
    const text = RELEASE_CAVEATS.join(' ');

    expect(text).toContain('BACK of the queue');
    expect(text).toContain('factory:clear-quarantine');
    expect(text).toContain('by a human on GitHub');
  });
});
