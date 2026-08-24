import { describe, expect, it } from 'vitest';
import {
  conflictHeadline,
  conflictNextStep,
} from '../../../components/approvals/decisionOutcome';
import type { ApprovalConflictReason } from '../../../types/approvals';

const REASONS: ApprovalConflictReason[] = [
  'already-decided-by-human',
  'already-timed-out',
  'already-authorized-by-grant',
  'superseded',
  'not-pending',
];

describe('conflictHeadline', () => {
  it('names every case distinctly', () => {
    // A generic "conflict" cannot distinguish "somebody else answered this"
    // from "the clock answered it while you were typing", and those call for
    // completely different things from the operator — which is the entire
    // reason the API discriminates in `details.reason`.
    const headlines = REASONS.map(conflictHeadline);

    expect(new Set(headlines).size).toBe(REASONS.length);
    for (const headline of headlines) {
      expect(headline.length).toBeGreaterThan(0);
    }
  });

  it('says a human verdict stands, and that a timeout was not one', () => {
    expect(conflictHeadline('already-decided-by-human')).toMatch(
      /verdict stands/i,
    );
    expect(conflictHeadline('already-timed-out')).toMatch(
      /no human decided it/i,
    );
    expect(conflictHeadline('already-authorized-by-grant')).toMatch(
      /never a question for a person/i,
    );
    expect(conflictHeadline('superseded')).toMatch(/nobody refused it/i);
  });
});

describe('conflictNextStep', () => {
  it('offers "raise it again" only where nobody judged the action', () => {
    // A timeout and a supersession are not judgements, so the action may be
    // worth raising again. Another person's verdict is a judgement, and
    // inviting a retry would invite a second opinion by attrition.
    expect(conflictNextStep('already-timed-out')).toMatch(/raised again/i);
    expect(conflictNextStep('superseded')).toMatch(/raised again/i);
    expect(conflictNextStep('already-decided-by-human')).toBeNull();
    expect(conflictNextStep('already-authorized-by-grant')).toBeNull();
    expect(conflictNextStep('not-pending')).toBeNull();
  });
});
