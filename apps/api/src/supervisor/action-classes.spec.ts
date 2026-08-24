import {
  ACTION_CLASSES,
  ACTION_CLASS_IDS,
  getActionClass,
  isActionClass,
  isAutonomyEligible,
  spendsMoney,
} from './action-classes';

describe('action-class taxonomy (#91, ADR-0011)', () => {
  describe('registry integrity', () => {
    it('has no duplicate ids', () => {
      expect(new Set(ACTION_CLASS_IDS).size).toBe(ACTION_CLASS_IDS.length);
    });

    it('exposes ids in registry order', () => {
      expect(ACTION_CLASS_IDS).toEqual(ACTION_CLASSES.map((c) => c.id));
    });

    it('uses kebab-case ids, because the id is a stored partition key', () => {
      for (const id of ACTION_CLASS_IDS) {
        expect(id).toMatch(/^[a-z]+(-[a-z]+)*$/);
      }
    });

    it('is frozen, so a consumer cannot mutate the taxonomy at runtime', () => {
      expect(Object.isFrozen(ACTION_CLASSES)).toBe(true);
      for (const entry of ACTION_CLASSES) {
        expect(Object.isFrozen(entry)).toBe(true);
      }
    });
  });

  describe('definitions', () => {
    // #91: "each class has a precise definition, not a category label". A label
    // is short and names the area; a definition is a sentence about what the
    // proposal asks for. Length is a crude proxy, but it catches the
    // regression this criterion exists to prevent - someone replacing a
    // sentence with the title.
    it('defines each class as a sentence, not a restatement of its title', () => {
      for (const entry of ACTION_CLASSES) {
        expect(entry.definition.length).toBeGreaterThan(60);
        expect(entry.definition.toLowerCase()).not.toBe(
          entry.title.toLowerCase(),
        );
      }
    });

    it('states an effect for every class, including the ones that change nothing', () => {
      for (const entry of ACTION_CLASSES) {
        expect(entry.effect.trim()).not.toBe('');
      }
    });

    it('classifies reversibility for every class (VISION §3.5)', () => {
      for (const entry of ACTION_CLASSES) {
        expect([
          'reversible',
          'reversible-with-effort',
          'irreversible',
        ]).toContain(entry.reversibility);
      }
    });
  });

  describe("VISION §7's promotion order", () => {
    // "re-dispatch after transient failure -> decomposition of timed-out orders
    // -> issue shaping -> quarantine decisions (probably never)". Each must be
    // a distinct class or the ladder cannot rank them.
    const ORDER = [
      're-dispatch',
      'decomposition',
      'issue-shaping',
      'quarantine-decision',
    ];

    it('registers each of the four as a distinct class', () => {
      for (const id of ORDER) {
        expect(isActionClass(id)).toBe(true);
      }
      expect(new Set(ORDER).size).toBe(4);
    });

    it('keeps them in the vision order within the registry', () => {
      const positions = ORDER.map((id) =>
        ACTION_CLASS_IDS.indexOf(id as never),
      );
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
    });
  });

  describe('autonomy eligibility', () => {
    it('marks quarantine decisions ineligible, per VISION §7 and §8', () => {
      expect(getActionClass('quarantine-decision')?.autonomyEligible).toBe(
        false,
      );
      expect(isAutonomyEligible('quarantine-decision')).toBe(false);
    });

    it('treats an unknown class as ineligible rather than defaulting open', () => {
      expect(isAutonomyEligible('quarantine-decisions')).toBe(false);
      expect(isAutonomyEligible('')).toBe(false);
    });

    it('never marks an irreversible class eligible for autonomy', () => {
      for (const entry of ACTION_CLASSES) {
        if (entry.reversibility === 'irreversible') {
          expect(entry.autonomyEligible).toBe(false);
        }
      }
    });
  });

  describe('spend classification (VISION §8 timeout policy)', () => {
    // "Reversible -> auto-approve on timeout; irreversible -> park and
    // escalate; spends money -> deny on timeout." The third bucket is distinct
    // from the first two, so `reversibility` alone cannot decide what silence
    // means and the registry has to say (#95, #98).
    it('classifies every class', () => {
      for (const entry of ACTION_CLASSES) {
        expect(typeof entry.spendsMoney).toBe('boolean');
      }
    });

    it('does not mean "the supervisor invocation costs something"', () => {
      // Every class costs that, so the flag would carry no information if it
      // meant that. It means the APPROVED EFFECT spends.
      expect(ACTION_CLASSES.some((entry) => !entry.spendsMoney)).toBe(true);
      expect(ACTION_CLASSES.some((entry) => entry.spendsMoney)).toBe(true);
    });

    it('flags the classes whose effect causes a runner or model invocation', () => {
      expect(
        ACTION_CLASSES.filter((entry) => entry.spendsMoney).map((e) => e.id),
      ).toEqual(['re-dispatch', 'decomposition', 'issue-shaping']);
    });

    it('does not flag the classes that only write to the log or notify', () => {
      for (const id of [
        'run-diagnosis',
        'spec-quality-feedback',
        'daily-brief',
        'quarantine-decision',
      ]) {
        expect(spendsMoney(id)).toBe(false);
      }
    });

    it('treats an unknown class as not spending, matching isAutonomyEligible', () => {
      // Both defaults refuse to infer anything about an id the registry does
      // not recognise; an unknown class should have failed `isActionClass` at
      // the boundary long before reaching either.
      expect(spendsMoney('re-dispatches')).toBe(false);
      expect(spendsMoney('')).toBe(false);
    });
  });

  describe('proposer coverage', () => {
    // #90: an action class that is never proposed looks the same as one always
    // proposed correctly. Recording which classes ship a producer is what lets
    // the ladder tell "no evidence yet" from "no producer".
    it('declares whether each class has a Phase 6 producer', () => {
      for (const entry of ACTION_CLASSES) {
        expect(typeof entry.hasProposer).toBe('boolean');
      }
    });

    it('has at least one class without a producer, recorded rather than hidden', () => {
      expect(ACTION_CLASSES.some((c) => !c.hasProposer)).toBe(true);
    });
  });

  describe('isActionClass', () => {
    it('accepts every registered id', () => {
      for (const id of ACTION_CLASS_IDS) {
        expect(isActionClass(id)).toBe(true);
      }
    });

    it('rejects near-misses, non-strings and nullish values', () => {
      expect(isActionClass('Issue-Shaping')).toBe(false);
      expect(isActionClass('issue shaping')).toBe(false);
      expect(isActionClass(undefined)).toBe(false);
      expect(isActionClass(null)).toBe(false);
      expect(isActionClass(42)).toBe(false);
    });

    it('does not match inherited Object properties', () => {
      expect(isActionClass('toString')).toBe(false);
      expect(isActionClass('constructor')).toBe(false);
    });
  });

  describe('getActionClass', () => {
    it('returns the registry entry for a known id', () => {
      expect(getActionClass('daily-brief')?.title).toBe('Daily brief');
    });

    it('returns undefined for an unknown id', () => {
      expect(getActionClass('nope')).toBeUndefined();
    });
  });
});
