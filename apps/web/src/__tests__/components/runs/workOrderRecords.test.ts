import { describe, expect, it } from 'vitest';

import {
  branchUrl,
  EXECUTION_RECORD_PATH,
  executionRecordUrl,
  identityMatchesDocument,
  parseIdentity,
} from '../../../components/runs/workOrderRecords';
import type { WorkOrderDocument } from '../../../types/cockpit';

/**
 * VISION §4 records a work order twice, and #63 says why: keeping both is what
 * makes "the agent did something I did not ask for" a checkable claim.
 */

function document(
  overrides: Partial<WorkOrderDocument> = {},
): WorkOrderDocument {
  return {
    schemaVersion: '1.1.0',
    identity: 'wo_opifex_312_a3f91c2_a1',
    branch: 'factory/312-a3f91c2-a1',
    repository: { owner: 'marinoscar', name: 'opifex' },
    baseCommit: 'a3f91c2b4d5e6f708192a3b4c5d6e7f809a1b2c3',
    attempt: 1,
    issue: {
      number: 312,
      url: 'https://github.com/marinoscar/opifex/issues/312',
    },
    taskSpec: 'Do the thing.',
    acceptanceCriteria: ['It is done.'],
    pathConstraints: [],
    budgetCeilingUsd: 5,
    wallClockTimeoutMinutes: 30,
    needs: [],
    ...overrides,
  };
}

describe('parseIdentity', () => {
  it('splits the canonical VISION §4 format', () => {
    expect(parseIdentity('wo_opifex_312_a3f91c2_a1')).toEqual({
      repository: 'opifex',
      issueNumber: 312,
      baseCommit: 'a3f91c2',
      attempt: 1,
    });
  });

  it('handles a repository name containing underscores', () => {
    // The repo segment is greedy for exactly this reason: `my_repo` would
    // otherwise split at the wrong underscore and every field after it would
    // be wrong.
    expect(parseIdentity('wo_my_repo_7_abcdef0_a2')).toEqual({
      repository: 'my_repo',
      issueNumber: 7,
      baseCommit: 'abcdef0',
      attempt: 2,
    });
  });

  it('returns null for something that is not an identity', () => {
    expect(parseIdentity('not-a-work-order')).toBeNull();
  });
});

describe('identityMatchesDocument', () => {
  it('agrees when the identity was derived from this document', () => {
    expect(identityMatchesDocument(document())).toEqual({
      agrees: true,
      reason: null,
    });
  });

  it('flags an issue number that has drifted', () => {
    const result = identityMatchesDocument(
      document({ issue: { number: 999, url: 'https://x/issues/999' } }),
    );
    expect(result.agrees).toBe(false);
    expect(result.reason).toContain('#312');
    expect(result.reason).toContain('#999');
  });

  it('flags a base commit that has drifted', () => {
    const result = identityMatchesDocument(
      document({ baseCommit: 'ffffffff11112222333344445555666677778888' }),
    );
    expect(result.agrees).toBe(false);
    expect(result.reason).toContain('base commit');
  });

  it('flags an attempt that has drifted', () => {
    const result = identityMatchesDocument(document({ attempt: 4 }));
    expect(result.agrees).toBe(false);
    expect(result.reason).toContain('attempt');
  });

  it('flags an identity that is not of the canonical form at all', () => {
    const result = identityMatchesDocument(document({ identity: 'nonsense' }));
    expect(result.agrees).toBe(false);
    expect(result.reason).toContain('wo_{repo}');
  });
});

describe('record links', () => {
  it("points at the execution record on the order's own branch", () => {
    // Pinned to the BRANCH, not a sha: the execution record is the branch's
    // first commit, so the ref always resolves to it unless somebody rewrote
    // history — and if they did, that is what the reader needs to see.
    expect(executionRecordUrl(document())).toBe(
      `https://github.com/marinoscar/opifex/blob/factory/312-a3f91c2-a1/${EXECUTION_RECORD_PATH}`,
    );
  });

  it('uses the same path constant the API writes to', () => {
    // If these ever disagreed the link would 404 while looking right.
    expect(EXECUTION_RECORD_PATH).toBe('.opifex/work-order.json');
  });

  it('links the branch itself for the whole attempt', () => {
    expect(branchUrl(document())).toContain('/tree/factory/312-a3f91c2-a1');
  });
});
