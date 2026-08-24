import type { HardCeiling } from '../budget/hard-spend-ceiling';
import {
  ACTION_CLASS_IDS,
  type ActionClassId,
} from '../supervisor/action-classes';
import { effectsFor, type ActionEffectParams } from './action-effects';
import { checkNeverTrustable } from './never-trustable';

const CEILING: HardCeiling = { limitUsd: 50, windowDays: 30, malformed: null };

function kinds(actionClass: ActionClassId, params: ActionEffectParams = {}) {
  return effectsFor(actionClass, params).map((effect) => effect.kind);
}

/**
 * `effectsFor` (#95, ADR-0013).
 *
 * ADR-0013 calls this "the single highest-leverage file in the autonomy path"
 * — the one place a correct guard can still be handed a wrong answer. A bug in
 * the guard's rules is caught by testing the guard; a class that should map to
 * a `delete` and maps to a `file-write` instead is caught only here.
 */
describe('effectsFor (#95, ADR-0013)', () => {
  describe('exhaustiveness over the registry', () => {
    it('maps every registered action class without throwing', () => {
      // Iterated from `ACTION_CLASS_IDS` rather than listed, so registering an
      // eighth class fails here at runtime as well as at compile time — the
      // compile error is the real guarantee, and this is what catches a `case`
      // added with the wrong body to silence it.
      for (const id of ACTION_CLASS_IDS) {
        expect(() => effectsFor(id, {})).not.toThrow();
        expect(effectsFor(id, {})).toBeDefined();
        expect(Array.isArray(effectsFor(id, {}))).toBe(true);
      }
    });

    it('covers the registry, and the registry is not empty', () => {
      // Guards the loop above from passing vacuously, the way
      // `supervisor-isolation.spec.ts` guards its own file list.
      expect(ACTION_CLASS_IDS.length).toBe(7);
    });

    it('produces effects the guard permits, for every class, by default', () => {
      // Nothing in the taxonomy proposes a force-push, a delete or a
      // credential read, so mapping any class to a refused effect would be a
      // bug in the mapping rather than a finding about the class. Quarantine
      // release is the deliberate exception.
      for (const id of ACTION_CLASS_IDS) {
        const refusals = checkNeverTrustable(
          effectsFor(id, { estimatedCostUsd: 0.5 }),
          CEILING,
        );
        expect(refusals).toEqual([]);
      }
    });
  });

  describe('the classes that change nothing outside the control plane', () => {
    it.each(['run-diagnosis', 'spec-quality-feedback', 'daily-brief'] as const)(
      '%s produces only the cost of the invocation',
      (id) => {
        expect(kinds(id)).toEqual(['spend']);
      },
    );
  });

  describe('re-dispatch', () => {
    it('dispatches and spends', () => {
      expect(kinds('re-dispatch')).toEqual(['dispatch', 'spend']);
    });

    it('carries the repository and work order it was given', () => {
      expect(
        effectsFor('re-dispatch', {
          repository: 'acme/web',
          workOrder: 'wo-1',
        })[0],
      ).toEqual({
        kind: 'dispatch',
        repository: 'acme/web',
        workOrder: 'wo-1',
      });
    });
  });

  describe('decomposition', () => {
    it('creates one issue per child, plus the spend', () => {
      expect(
        kinds('decomposition', { repository: 'acme/web', childCount: 3 }),
      ).toEqual(['issue-create', 'issue-create', 'issue-create', 'spend']);
    });

    it('never produces a delete', () => {
      // The registry's own wording: decomposition creates. Nothing in the
      // taxonomy deletes an issue, and a mapping that produced one would be
      // refused correctly by the guard and wrong here.
      expect(kinds('decomposition', { childCount: 5 })).not.toContain('delete');
    });

    it('claims no issue creations when nobody said how many', () => {
      // Zero rather than an invented default: the mapping states what it
      // knows, and inventing a count would put a number in an audit record
      // that no caller ever supplied.
      expect(kinds('decomposition')).toEqual(['spend']);
    });

    it.each([-3, 2.7, Number.NaN])(
      'coerces a nonsensical child count (%p) rather than looping on it',
      (childCount) => {
        const effects = effectsFor('decomposition', { childCount });
        expect(effects.filter((e) => e.kind === 'issue-create').length).toBe(
          childCount === 2.7 ? 2 : 0,
        );
      },
    );
  });

  describe('issue-shaping', () => {
    it('edits one issue and spends', () => {
      expect(kinds('issue-shaping')).toEqual(['issue-edit', 'spend']);
    });

    it('carries the issue reference', () => {
      expect(
        effectsFor('issue-shaping', {
          repository: 'acme/web',
          issueRef: 'acme/web#7',
        })[0],
      ).toEqual({
        kind: 'issue-edit',
        repository: 'acme/web',
        ref: 'acme/web#7',
      });
    });
  });

  describe('quarantine-decision', () => {
    it('produces nothing when it quarantines', () => {
      expect(
        effectsFor('quarantine-decision', { direction: 'quarantine' }),
      ).toEqual([]);
    });

    it('produces a quarantine-clear when it releases', () => {
      expect(
        effectsFor('quarantine-decision', {
          direction: 'release',
          workOrder: 'wo-1',
        }),
      ).toEqual([{ kind: 'quarantine-clear', workOrder: 'wo-1' }]);
    });

    it('treats an unstated direction as quarantining, not releasing', () => {
      expect(effectsFor('quarantine-decision', {})).toEqual([]);
    });

    it('yields the asymmetry the guard needs, without a special case', () => {
      // The guard refuses release and permits quarantining as a consequence of
      // `direction` alone. VISION §8: only a human clears quarantine.
      expect(
        checkNeverTrustable(
          effectsFor('quarantine-decision', { direction: 'quarantine' }),
          CEILING,
        ),
      ).toEqual([]);

      expect(
        checkNeverTrustable(
          effectsFor('quarantine-decision', {
            direction: 'release',
            workOrder: 'wo-1',
          }),
          CEILING,
        ).map((refusal) => refusal.rule),
      ).toEqual(['quarantine-self-clear']);
    });
  });

  describe('the cost estimate', () => {
    it('uses the estimate it was given', () => {
      expect(effectsFor('daily-brief', { estimatedCostUsd: 0.03 })).toEqual([
        { kind: 'spend', usd: 0.03 },
      ]);
    });

    it('treats an unknown estimate as zero HERE, unlike the guard', () => {
      // The opposite of what `checkNeverTrustable` does with an unusable
      // `usd`, deliberately. This number is a forecast made before anything
      // ran; refusing every action whose cost nobody has estimated would
      // refuse every action. Enforcement that matters is on ACTUAL spend
      // against the grant's cumulative ceiling (#96).
      expect(effectsFor('daily-brief', {})).toEqual([
        { kind: 'spend', usd: 0 },
      ]);
    });

    it('still lets the hard ceiling catch an estimate that is known and absurd', () => {
      expect(
        checkNeverTrustable(
          effectsFor('re-dispatch', { estimatedCostUsd: 5_000 }),
          CEILING,
        ).map((refusal) => refusal.rule),
      ).toEqual(['hard-spend-ceiling']);
    });
  });

  describe('unknown subjects', () => {
    it('marks a subject nobody named rather than omitting it', () => {
      // A refusal reading `unknown` in an audit row is itself a finding:
      // something reached the boundary without knowing what it was acting on.
      expect(effectsFor('re-dispatch', {})[0]).toEqual({
        kind: 'dispatch',
        repository: 'unknown',
        workOrder: 'unknown',
      });
    });
  });
});
