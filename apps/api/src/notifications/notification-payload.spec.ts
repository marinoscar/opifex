import {
  buildPayload,
  CHARACTERISED_KINDS,
  type EscalationForNotification,
} from './notification-payload';

const RAISED_AT = new Date('2026-08-22T10:00:04Z');

function escalation(overrides: Partial<EscalationForNotification> = {}): EscalationForNotification {
  return {
    id: 'e1',
    kind: 'run_stalled',
    summary: 'wo_opifex_312_a3f91c2_a1 stalled (marinoscar/opifex#312)',
    detail:
      'wo_opifex_312_a3f91c2_a1 (marinoscar/opifex#312) has stalled — silent for 12m ' +
      '(last event of any source at 2026-08-22T09:48:00Z), exceeding the 90s threshold.',
    raisedAt: RAISED_AT,
    progressStoppedAt: new Date('2026-08-22T10:00:00Z'),
    run: {
      workOrder: {
        identity: 'wo_opifex_312_a3f91c2_a1',
        issueNumber: 312,
        repository: { owner: 'marinoscar', name: 'opifex' },
      },
    },
    ...overrides,
  };
}

describe('buildPayload', () => {
  describe("VISION §8's four fields", () => {
    it('says WHAT happened', () => {
      expect(buildPayload(escalation(), 'r1', 'https://opifex.test').body).toContain('stalled');
    });

    it('says WHY, with the numbers the decision was made on', () => {
      // #47: the reason is not a log message, it is the deliverable. A
      // summarised reason is one the operator cannot check.
      const payload = buildPayload(escalation(), 'r1', 'https://opifex.test');

      expect(payload.why).toBe(escalation().detail);
      expect(payload.why).toContain('90s threshold');
    });

    it('says the BLAST RADIUS', () => {
      expect(buildPayload(escalation(), 'r1', 'https://opifex.test').blastRadius).toContain(
        'One run',
      );
    });

    it('says what happens IF IGNORED', () => {
      // The field that decides whether to get up.
      expect(buildPayload(escalation(), 'r1', 'https://opifex.test').ifIgnored.length)
        .toBeGreaterThan(0);
    });

    it('fills all four for every kind, never leaving one blank', () => {
      for (const kind of CHARACTERISED_KINDS) {
        const payload = buildPayload(escalation({ kind }), 'r1', 'https://opifex.test');

        for (const field of [payload.body, payload.why, payload.blastRadius, payload.ifIgnored]) {
          expect(field.length).toBeGreaterThan(0);
        }
      }
    });
  });

  describe('consequences are per kind, not one generic sentence', () => {
    it('distinguishes a stall from a loop', () => {
      // A stalled run is burning nothing; a looping one is spending money
      // right now. A notification that cannot tell them apart fails the only
      // test that matters at 2am.
      const stalled = buildPayload(escalation({ kind: 'run_stalled' }), 'r1', 'u');
      const looping = buildPayload(escalation({ kind: 'run_looping' }), 'r1', 'u');

      expect(stalled.ifIgnored).toContain('No spend');
      expect(looping.ifIgnored).toContain('Spend continues');
    });

    it('says a quarantine will never clear itself', () => {
      // VISION §8 makes a human the only way out, so "wait and see" is not an
      // option the operator should be left to discover on their own.
      expect(buildPayload(escalation({ kind: 'quarantined' }), 'r1', 'u').ifIgnored).toContain(
        'nothing clears this on its own',
      );
    });

    it('treats an uncharacterised kind as URGENT, not as harmless', () => {
      // An escalation nobody can characterise is worse than one that can be.
      const payload = buildPayload(escalation({ kind: 'something_new' }), 'r1', 'u');

      expect(payload.ifIgnored).toContain('Treat as urgent');
    });

    it('characterises every kind the schema can produce', async () => {
      // A kind added to the schema and missed here would notify with
      // "Unknown" — degradation that survives review because it still works.
      const { EscalationKind } = await import('@prisma/client');

      expect(Object.values(EscalationKind).sort()).toEqual([...CHARACTERISED_KINDS].sort());
    });
  });

  describe('one tap', () => {
    it('links to the run, not to a dashboard to navigate from', () => {
      const payload = buildPayload(escalation(), 'r1', 'https://opifex.test');

      expect(payload.url).toBe(
        'https://opifex.test/runs?issue=marinoscar/opifex%23312',
      );
    });

    it('falls back to the escalation list when there is no run', () => {
      // A `system` escalation is about the control plane and has no run.
      const payload = buildPayload(
        escalation({ kind: 'system', run: null }),
        'r1',
        'https://opifex.test',
      );

      expect(payload.url).toBe('https://opifex.test/escalations');
    });
  });

  describe('the receipt', () => {
    it('carries the token the device posts back', () => {
      // The only credential the receipt endpoint needs. A service worker has
      // no session, and storing a bearer token where one could read it would
      // be worse than this.
      expect(buildPayload(escalation(), 'rcpt_abc', 'u').receiptId).toBe('rcpt_abc');
    });

    it('carries when it was raised, so a late notification says so', () => {
      expect(buildPayload(escalation(), 'r1', 'u').raisedAt).toBe(RAISED_AT.toISOString());
    });
  });

  describe('when there is no detail', () => {
    it('falls back to the summary rather than an empty WHY', () => {
      const payload = buildPayload(escalation({ detail: null }), 'r1', 'u');

      expect(payload.why).toBe(escalation().summary);
    });
  });
});
