import type { ActionClassId } from '../supervisor/action-classes';
import type { AutonomyEffect } from './never-trustable';

/**
 * The one place an action class becomes a list of effects (#95, ADR-0013).
 *
 * ADR-0013 is explicit about why this is a function and not a convention:
 * "the honesty of the declaration is a property of one function, tested once,
 * instead of a property trusted of every executor that will ever exist." A
 * required `effects` field guarantees an executor produces SOME list; only
 * centralising the derivation gives any reason to believe the list is right.
 *
 * It is also, by the same argument, the highest-leverage file in the autonomy
 * path — the one place a correct guard can still be handed a wrong answer. A
 * bug in the guard's rules is caught by testing the guard; a class that should
 * map to a `delete` and maps to a `file-write` instead is caught only here.
 *
 * The switch is exhaustive over `ActionClassId`. Registering an eighth action
 * class is therefore a compile error in this file, which is the intended
 * friction: a class whose effects nobody has stated is a class the guard
 * cannot evaluate.
 */

/**
 * What a concrete instance of an action class is about to touch.
 *
 * Every field optional, because the caller's knowledge is genuinely partial at
 * the point it asks — a re-dispatch knows its work order before it knows what
 * the run will cost. Absence is handled explicitly at each use site below
 * rather than by a schema that would force callers to invent values.
 */
export interface ActionEffectParams {
  /** `owner/name`, as the rest of the GitHub edge spells it. */
  repository?: string;
  /** Work order identity, for dispatch and quarantine effects. */
  workOrder?: string;
  /** `owner/name#number` for the issue being edited. */
  issueRef?: string;
  /** How many child issues a decomposition would create. */
  childCount?: number;
  /** Best estimate of the model or runner cost, in US dollars. */
  estimatedCostUsd?: number;
  /**
   * Which way a quarantine decision goes.
   *
   * The guard refuses `release` and permits `quarantine` as a consequence of
   * this field alone — no special case anywhere. That asymmetry is the correct
   * one (VISION §8: only a human clears quarantine) and it is worth noting
   * that it falls out of the mapping rather than being asserted by it.
   */
  direction?: 'quarantine' | 'release';
}

/**
 * Stands in where a caller could not name the subject.
 *
 * A placeholder rather than an omission, because every effect member carries
 * its subject as a required field and a guard that has to cope with `undefined`
 * subjects is a guard with a second code path. It is never a real slug, so a
 * refusal reading `unknown` in an audit row is itself a finding: something
 * reached the boundary without knowing what it was acting on.
 */
const UNKNOWN = 'unknown';

export function effectsFor(
  actionClass: ActionClassId,
  params: ActionEffectParams,
): AutonomyEffect[] {
  const repository = params.repository ?? UNKNOWN;

  switch (actionClass) {
    // Three classes whose registry `effect` is "nothing outside the decision
    // log" or "a notification". They change nothing in a repository, so the
    // only effect they have is the money the invocation costs.
    case 'run-diagnosis':
    case 'spec-quality-feedback':
    case 'daily-brief':
      return [spend(params)];

    case 're-dispatch':
      return [
        {
          kind: 'dispatch',
          repository,
          workOrder: params.workOrder ?? UNKNOWN,
        },
        spend(params),
      ];

    case 'decomposition':
      return [
        // One per child, not one aggregate effect: the guard counts what an
        // action attempts, and "created eleven issues" and "created one" are
        // different attempts even though neither is forbidden today.
        ...Array.from({ length: childIssueCount(params) }, () => ({
          kind: 'issue-create' as const,
          repository,
        })),
        spend(params),
      ];

    case 'issue-shaping':
      return [
        {
          kind: 'issue-edit',
          repository,
          ref: params.issueRef ?? UNKNOWN,
        },
        spend(params),
      ];

    case 'quarantine-decision':
      // Placing a work order in quarantine changes nothing outside the control
      // plane and needs no effect; releasing one does, and the guard refuses
      // it. This class is `autonomyEligible: false` in the registry as well,
      // and ADR-0013 wants those two failing independently rather than one
      // boolean deciding both.
      return params.direction === 'release'
        ? [
            {
              kind: 'quarantine-clear',
              workOrder: params.workOrder ?? UNKNOWN,
            },
          ]
        : [];

    default: {
      // Exhaustiveness, enforced by the compiler rather than by a runtime
      // check nobody reaches. If this stops compiling, a new action class was
      // registered without anyone stating what it would do.
      const unreachable: never = actionClass;
      throw new Error(
        `No effect mapping for action class "${String(unreachable)}". ` +
          'Every class must state its effects (ADR-0013).',
      );
    }
  }
}

/**
 * The cost effect, defaulting an unknown estimate to zero.
 *
 * The opposite of what the guard does with an unusable `usd`, and deliberately
 * so. HERE the number is a forecast made before anything ran, and refusing
 * every action whose cost nobody has estimated yet would refuse every action.
 * The enforcement that matters is on ACTUAL spend against the grant's
 * cumulative ceiling (#96), where the number is a measurement rather than a
 * guess. The hard ceiling still catches an estimate that is known and absurd.
 */
function spend(params: ActionEffectParams): AutonomyEffect {
  return { kind: 'spend', usd: params.estimatedCostUsd ?? 0 };
}

/** A non-negative whole number of children; anything else means "none stated". */
function childIssueCount(params: ActionEffectParams): number {
  const raw = params.childCount ?? 0;
  return Number.isFinite(raw) ? Math.max(0, Math.trunc(raw)) : 0;
}
