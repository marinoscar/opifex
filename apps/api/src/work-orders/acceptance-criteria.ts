/**
 * Whether an issue is specified well enough to become a work order.
 *
 * VISION §10 is blunt about where quality comes from:
 *
 * > Throughput ceiling is spec quality, not token budget.
 *
 * And #62 draws the conclusion: *"an issue whose acceptance criteria are not
 * testable should fail to produce a work order rather than producing a bad
 * one."* A vague criterion does not make a run fail — it makes a run SUCCEED
 * against the wrong target, and produce a pull request somebody has to read
 * carefully to discover is wrong. That is more expensive than a rejection.
 *
 * ## Rules, not judgement
 *
 * VISION §3.6: no model output takes effect without passing through
 * deterministic policy. This is the policy. It is a set of dumb, checkable
 * rules that a person can predict the behaviour of, and it errs toward
 * accepting: it rejects criteria that are *obviously* untestable rather than
 * trying to decide which ones are good. The advisory agent (#21) may one day
 * suggest better criteria; it will never be what decides whether these pass.
 */

export interface CriteriaVerdict {
  testable: boolean;
  /** Why not, naming the criterion. Empty when it passes. */
  problems: CriteriaProblem[];
}

export interface CriteriaProblem {
  /** The offending criterion, or null for a problem with the set as a whole. */
  criterion: string | null;
  reason: string;
}

/**
 * Shortest criterion worth calling a criterion.
 *
 * "Works." is not a target. Tuned low on purpose — the gate is here to catch
 * the obviously empty, not to enforce a house style.
 */
export const MIN_CRITERION_LENGTH = 12;

/**
 * Placeholders that mean the section was never filled in.
 *
 * Matched as whole criteria rather than substrings: "TBD" alone is a
 * non-criterion, while "Rejects a TBD placeholder" is a perfectly good one.
 */
const PLACEHOLDERS = new Set([
  'tbd',
  'todo',
  'n/a',
  'na',
  'none',
  'tba',
  '-',
  '...',
  'see above',
  'as described',
  'as discussed',
]);

/**
 * Words that describe a feeling rather than an observation.
 *
 * A criterion built on one of these cannot be checked by anyone but its
 * author, and often not by them a month later. Each is matched as a whole word
 * so "cleanly separated" is not caught by "clean".
 */
const SUBJECTIVE = [
  'looks good',
  'looks right',
  'works well',
  'works properly',
  'works correctly',
  'is clean',
  'is nice',
  'is elegant',
  'is intuitive',
  'is user-friendly',
  'is performant',
  'is fast',
  'is robust',
  'is maintainable',
  'is readable',
  'makes sense',
  'as appropriate',
  'as needed',
  'etc',
];

export function assessCriteria(criteria: string[]): CriteriaVerdict {
  const problems: CriteriaProblem[] = [];
  const cleaned = criteria.map((criterion) => criterion.trim()).filter(Boolean);

  if (cleaned.length === 0) {
    // The whole-set problem, and the most common one by far: the section was
    // left empty, or the issue predates anyone caring.
    return {
      testable: false,
      problems: [
        {
          criterion: null,
          reason:
            'No acceptance criteria. A work order without them has no definition of done, so ' +
            'a run against it cannot fail — it can only produce something nobody can check.',
        },
      ],
    };
  }

  for (const criterion of cleaned) {
    const normalized = criterion.toLowerCase().replace(/[.!]+$/, '').trim();

    if (PLACEHOLDERS.has(normalized)) {
      problems.push({
        criterion,
        reason: `"${criterion}" is a placeholder, not a criterion. The section was never filled in.`,
      });
      continue;
    }

    if (criterion.length < MIN_CRITERION_LENGTH) {
      problems.push({
        criterion,
        reason:
          `"${criterion}" is too short to state a testable outcome ` +
          `(under ${MIN_CRITERION_LENGTH} characters).`,
      });
      continue;
    }

    const subjective = SUBJECTIVE.find((phrase) => containsPhrase(normalized, phrase));
    if (subjective) {
      problems.push({
        criterion,
        reason:
          `"${criterion}" turns on "${subjective}", which describes a feeling rather than an ` +
          `observation. Nobody but you can check it, and a run will report success against it ` +
          `whatever it produces.`,
      });
    }
  }

  return { testable: problems.length === 0, problems };
}

/** One sentence a human can act on, for the rejection comment. */
export function describeProblems(problems: CriteriaProblem[]): string {
  return problems.map((problem) => problem.reason).join(' ');
}

/**
 * Whole-word (or whole-phrase) containment.
 *
 * `includes` would make "clean" reject "cleanly separated from the parser",
 * which is a perfectly testable criterion. A gate that rejects good work is
 * worse than one that lets some bad work through, because people route around
 * it rather than fixing their issues.
 */
function containsPhrase(haystack: string, phrase: string): boolean {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z])${escaped}([^a-z]|$)`).test(haystack);
}
