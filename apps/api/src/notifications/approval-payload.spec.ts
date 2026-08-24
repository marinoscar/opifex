import {
  buildApprovalPayload,
  ifIgnoredFor,
  type ApprovalForNotification,
} from './approval-payload';

const CREATED_AT = new Date('2026-08-24T12:00:00.000Z');
const TIMEOUT_AT = new Date('2026-08-24T16:00:00.000Z');
const APP_URL = 'https://opifex.test';

/**
 * Anything that reads as a clock time or a date.
 *
 * Used to assert what the parked sentence must NOT contain. Deliberately
 * broad — `16:00`, `2026-08-24T16:00:00.000Z`, `4pm` and `in 4 hours` would
 * all mislead an operator into waiting for a deadline that does not exist, so
 * the test fails on all of them rather than on one chosen phrasing.
 */
const LOOKS_LIKE_A_TIME =
  /\d{1,2}:\d{2}|\d{4}-\d{2}-\d{2}|\d\s*(?:am|pm)\b|\bin \d+ (?:minute|hour|day)/i;

function approval(
  overrides: Partial<ApprovalForNotification> = {},
): ApprovalForNotification {
  return {
    id: 'approval-1',
    actionClass: 're-dispatch',
    actionClassTitle: 'Re-dispatch after transient failure',
    summary: 'Re-dispatch work order 312 at attempt 2',
    reasoning:
      'The run failed with a 429 from the runner at 11:42Z, judged transient: ' +
      'no commits were made and the quota window resets in 20 minutes.',
    blastRadius:
      'One new branch and one runner invocation on the same quota. Nothing merges.',
    timeoutPolicy: 'deny',
    timeoutAt: TIMEOUT_AT,
    status: 'pending',
    escalationId: null,
    createdAt: CREATED_AT,
    ...overrides,
  };
}

describe('buildApprovalPayload', () => {
  describe("VISION §8's four fields", () => {
    it('says WHAT is being asked, in the words it was raised with', () => {
      expect(buildApprovalPayload(approval(), APP_URL).body).toBe(
        'Re-dispatch work order 312 at attempt 2',
      );
    });

    it('says WHY, passing the reasoning through unsummarised', () => {
      // #47: the reason is the deliverable, not a log message. The operator is
      // being asked to judge this argument, so a shortened version is one they
      // cannot check.
      const payload = buildApprovalPayload(approval(), APP_URL);

      expect(payload.why).toBe(approval().reasoning);
      expect(payload.why).toContain('429');
    });

    it('says the BLAST RADIUS as raised, not a per-class sentence', () => {
      expect(buildApprovalPayload(approval(), APP_URL).blastRadius).toBe(
        approval().blastRadius,
      );
    });

    it('says what happens IF IGNORED', () => {
      expect(buildApprovalPayload(approval(), APP_URL).ifIgnored).not.toBe('');
    });
  });

  describe('ifIgnored is derived from the RECORDED timeout policy', () => {
    it('auto_approve says it will proceed on its own, and name the instant', () => {
      const payload = buildApprovalPayload(
        approval({
          actionClass: 'run-diagnosis',
          timeoutPolicy: 'auto_approve',
        }),
        APP_URL,
      );

      expect(payload.ifIgnored).toContain('proceed on its own');
      expect(payload.ifIgnored).toContain(TIMEOUT_AT.toISOString());
      // VISION §8's digest promise: an auto-approval still records what would
      // have been asked, and the operator is told that up front rather than
      // discovering it in the morning.
      expect(payload.ifIgnored).toContain('recorded');
    });

    it('deny says it will be refused at the instant, and can be raised again', () => {
      const payload = buildApprovalPayload(approval(), APP_URL);

      expect(payload.ifIgnored).toContain('refused');
      expect(payload.ifIgnored).toContain(TIMEOUT_AT.toISOString());
      expect(payload.ifIgnored).toContain('raised again');
    });

    it('park_and_escalate says nothing happens, ever, until a person answers', () => {
      const payload = buildApprovalPayload(
        approval({
          timeoutPolicy: 'park_and_escalate',
          timeoutAt: null,
          status: 'parked',
        }),
        APP_URL,
      );

      expect(payload.ifIgnored).toContain('Nothing happens, ever');
      expect(payload.ifIgnored).toContain('There is no ');
    });

    it('NEVER states a deadline for park_and_escalate', () => {
      // The load-bearing assertion of this file. `timeoutAt` is null for this
      // policy and that null IS the never-auto-approve guarantee; a sentence
      // implying a deadline describes a timer that does not exist, and an
      // operator who believes one exists will let it lapse expecting something
      // to happen. Nothing will.
      const sentence = ifIgnoredFor('park_and_escalate', null);

      expect(sentence).not.toMatch(LOOKS_LIKE_A_TIME);
    });

    it('gives the three policies three distinct sentences', () => {
      const sentences = [
        ifIgnoredFor('auto_approve', TIMEOUT_AT),
        ifIgnoredFor('deny', TIMEOUT_AT),
        ifIgnoredFor('park_and_escalate', null),
      ];

      expect(new Set(sentences).size).toBe(3);
    });

    it('still names the right outcome when a timed policy has no instant', () => {
      // Not reachable through `timeoutAtFor`, which always returns an instant
      // for a timed policy. Covered because the builder must degrade to a
      // vaguer sentence rather than throw: "we could not phrase the
      // notification" must not become "the operator was never told".
      expect(ifIgnoredFor('deny', null)).toContain('refused');
      expect(ifIgnoredFor('deny', null)).not.toMatch(LOOKS_LIKE_A_TIME);
    });
  });

  describe('priority', () => {
    it('is high for a parked approval, which no timer will ever resolve', () => {
      expect(
        buildApprovalPayload(
          approval({
            timeoutPolicy: 'park_and_escalate',
            timeoutAt: null,
            status: 'parked',
          }),
          APP_URL,
        ).priority,
      ).toBe('high');
    });

    it('is normal otherwise, which is the batching VISION §8 asks for', () => {
      expect(buildApprovalPayload(approval(), APP_URL).priority).toBe('normal');
      expect(
        buildApprovalPayload(
          approval({ timeoutPolicy: 'auto_approve' }),
          APP_URL,
        ).priority,
      ).toBe('normal');
    });
  });

  describe('escalationId and receiptId', () => {
    it('are absent for an ordinary pending approval', () => {
      // Not an omission. Minting an escalation so these could be populated
      // would put every approval into the escalation lifecycle and into the
      // stop-to-notified percentiles computed over it — which measure how long
      // a BROKEN RUN went unnoticed. An unanswered question is not a broken
      // run.
      const payload = buildApprovalPayload(approval(), APP_URL);

      expect(payload.escalationId).toBeUndefined();
      expect(payload.receiptId).toBeUndefined();
      expect('escalationId' in payload).toBe(false);
      expect('receiptId' in payload).toBe(false);
    });

    it('are absent even when an escalation id is present but the row is not parked', () => {
      const payload = buildApprovalPayload(
        approval({ escalationId: 'escalation-9' }),
        APP_URL,
      );

      expect(payload.escalationId).toBeUndefined();
    });

    it('carries the escalation of a parked approval, which is a real row', () => {
      const payload = buildApprovalPayload(
        approval({
          timeoutPolicy: 'park_and_escalate',
          timeoutAt: null,
          status: 'parked',
          escalationId: 'escalation-9',
        }),
        APP_URL,
      );

      expect(payload.escalationId).toBe('escalation-9');
    });

    it('omits a receipt token that resolves to no escalation', () => {
      // A receipt is a DELIVERY receipt. Emitting one with no escalation
      // behind it would hand the receipt endpoint a credential naming nothing.
      const payload = buildApprovalPayload(
        approval({ receiptId: 'receipt-1' }),
        APP_URL,
      );

      expect(payload.receiptId).toBeUndefined();
    });

    it('passes a receipt through when it belongs to the linked escalation', () => {
      const payload = buildApprovalPayload(
        approval({
          timeoutPolicy: 'park_and_escalate',
          timeoutAt: null,
          status: 'parked',
          escalationId: 'escalation-9',
          receiptId: 'receipt-1',
        }),
        APP_URL,
      );

      expect(payload.receiptId).toBe('receipt-1');
    });
  });

  describe('the tap', () => {
    it('deep-links to the one approval, not to a queue', () => {
      expect(buildApprovalPayload(approval(), APP_URL).url).toBe(
        'https://opifex.test/approvals/approval-1',
      );
    });

    it('titles the notification with the registry title, not the class id', () => {
      // The lookup itself happens in `ApprovalGateService` — this file may not
      // import the registry, because `src/notifications/` is on VISION §7's
      // hot path and #94's governing test forbids it reaching into
      // `src/supervisor/`. That the gate supplies the REGISTRY title, and not
      // a string of its own, is pinned in `approval-gate.service.spec.ts`.
      const payload = buildApprovalPayload(approval(), APP_URL);

      expect(payload.title).toBe(
        'Approve: Re-dispatch after transient failure',
      );
      expect(payload.title).not.toContain('re-dispatch');
    });

    it('falls back to the raw id when the class has no resolved title', () => {
      // ADR-0014: a parked approval today most likely means "a class id the
      // gate did not recognize", so the raw id is the most useful thing the
      // notification can show — and "Approve: an unknown action" the least.
      expect(
        buildApprovalPayload(
          approval({ actionClass: 'redispatch-typo', actionClassTitle: null }),
          APP_URL,
        ).title,
      ).toBe('Approve: redispatch-typo');
    });

    it('groups as an approval rather than as an escalation', () => {
      expect(buildApprovalPayload(approval(), APP_URL).kind).toBe(
        'approval_request',
      );
    });

    it('stamps when it was raised, so a late notification says so', () => {
      expect(buildApprovalPayload(approval(), APP_URL).raisedAt).toBe(
        CREATED_AT.toISOString(),
      );
    });
  });
});
