import type { HardCeiling } from '../budget/hard-spend-ceiling';
import {
  checkNeverTrustable,
  forbiddenPathReason,
  normaliseWritePath,
  FORBIDDEN_WRITE_PATHS,
  type AutonomyEffect,
  type NeverTrustableRule,
} from './never-trustable';

/**
 * The never-trustable list (#95, ADR-0013).
 *
 * Every case below is written as though the most permissive trust grant
 * imaginable were in force — "always approve this class, every repository, no
 * expiry, no ceiling". That grant is not passed in, because there is nowhere
 * to pass it: VISION §8's phrase is "regardless of any grant", and the guard's
 * signature is how that sentence is enforced rather than merely believed.
 *
 * The ceiling that IS passed in is #65's `HardCeiling`, as a plain value. The
 * default below is generous on purpose, so that a refusal in a test that is
 * not about spend is never an artefact of the budget.
 */
const CEILING: HardCeiling = {
  limitUsd: 50,
  windowDays: 30,
  malformed: null,
};

function ceiling(overrides: Partial<HardCeiling> = {}): HardCeiling {
  return { ...CEILING, ...overrides };
}

function rulesFor(
  effects: AutonomyEffect[],
  limit: HardCeiling = CEILING,
): NeverTrustableRule[] {
  return checkNeverTrustable(effects, limit).map((refusal) => refusal.rule);
}

function push(
  overrides: Partial<Extract<AutonomyEffect, { kind: 'git-push' }>> = {},
): AutonomyEffect {
  return {
    kind: 'git-push',
    repository: 'acme/web',
    branch: 'factory/wo-1',
    force: false,
    protectedBranch: false,
    ...overrides,
  };
}

describe('checkNeverTrustable (#95, ADR-0013)', () => {
  describe('the signature is the guarantee', () => {
    it('takes effects and nothing else — no grant parameter exists', () => {
      // A grant parameter would imply some grant could change the answer.
      // There is no argument for one to occupy, so no caller can pass one and
      // no future rule can read one.
      // Two parameters: the effects, and #65's already-immutable ceiling.
      // Neither is a grant, a scope or an actor — there is no argument for a
      // caller to put one in and no future rule that could read one.
      expect(checkNeverTrustable.length).toBe(2);
    });

    it('permits an empty effect list', () => {
      // An action that does nothing outside the control plane is the common
      // case for the observe-only classes, and must not need a special case.
      expect(checkNeverTrustable([], CEILING)).toEqual([]);
    });
  });

  describe('force-push and protected branches (VISION §8)', () => {
    it('refuses a force-push regardless of which branch', () => {
      expect(rulesFor([push({ force: true })])).toEqual(['force-push']);
    });

    it('refuses a write to a protected branch', () => {
      expect(
        rulesFor([push({ branch: 'main', protectedBranch: true })]),
      ).toEqual(['protected-branch-write']);
    });

    it('fires both rules for a force-push to a protected branch', () => {
      // Two prohibitions, two records. Collapsing them would under-report what
      // was attempted.
      expect(
        rulesFor([
          push({ branch: 'main', force: true, protectedBranch: true }),
        ]),
      ).toEqual(['force-push', 'protected-branch-write']);
    });

    it('permits an ordinary push to a factory branch', () => {
      // VISION §3.5: "a commit to a factory branch is fully reversible — never
      // ask." A guard that refused this would gate on significance.
      expect(checkNeverTrustable([push()], CEILING)).toEqual([]);
    });

    it('names the repository and branch in the refusal', () => {
      const [refusal] = checkNeverTrustable(
        [push({ repository: 'acme/web', branch: 'main', force: true })],
        CEILING,
      );

      expect(refusal.reason).toContain('acme/web@main');
      expect(refusal.reason).toContain('VISION §8');
      expect(refusal.effect).toEqual(
        push({ repository: 'acme/web', branch: 'main', force: true }),
      );
    });
  });

  describe('destructive deletes (VISION §8)', () => {
    it.each(['branch', 'issue', 'pull-request'] as const)(
      'refuses deleting a %s',
      (subject) => {
        expect(rulesFor([{ kind: 'delete', subject, ref: 'x' }])).toEqual([
          'destructive-delete',
        ]);
      },
    );

    it.each(['run', 'work-order'] as const)(
      'permits deleting a %s, which is a control-plane row',
      (subject) => {
        // VISION §3.3 puts execution state in Postgres as Opifex's own record.
        // VISION §8's list is branches, issues and pull requests — artefacts a
        // human authored, where deletion destroys the only copy. Refusing
        // routine housekeeping would teach operators that refusals are noise.
        expect(
          checkNeverTrustable([{ kind: 'delete', subject, ref: 'x' }], CEILING),
        ).toEqual([]);
      },
    );
  });

  describe('credential access (VISION §8)', () => {
    it.each(['read', 'write'] as const)('refuses %s access', (mode) => {
      expect(
        rulesFor([{ kind: 'credential-access', mode, what: 'GITHUB_TOKEN' }]),
      ).toEqual(['credential-access']);
    });

    it('names the credential it refused to touch', () => {
      const [refusal] = checkNeverTrustable(
        [{ kind: 'credential-access', mode: 'read', what: 'GITHUB_TOKEN' }],
        CEILING,
      );

      expect(refusal.reason).toContain('GITHUB_TOKEN');
    });
  });

  describe('the hard spend ceiling (VISION §8, #65)', () => {
    it('declares no ceiling of its own — the value is passed in', () => {
      // A second constant would be the drift ADR-0011 and ADR-0013 both
      // refuse, and a guard checking the wrong ceiling is worse than no guard
      // because it reports success. `autonomy-purity.spec.ts` asserts the
      // absence over the source; this asserts the behaviour follows the
      // argument.
      expect(
        rulesFor([{ kind: 'spend', usd: 100 }], ceiling({ limitUsd: 1000 })),
      ).toEqual([]);
      expect(
        rulesFor([{ kind: 'spend', usd: 100 }], ceiling({ limitUsd: 10 })),
      ).toEqual(['hard-spend-ceiling']);
    });

    it('permits a spend of exactly the ceiling', () => {
      // At the ceiling is not above it, which is what "ceiling" means.
      expect(
        checkNeverTrustable(
          [{ kind: 'spend', usd: 50 }],
          ceiling({ limitUsd: 50 }),
        ),
      ).toEqual([]);
    });

    it('refuses a single cent over the ceiling', () => {
      expect(
        rulesFor([{ kind: 'spend', usd: 50.01 }], ceiling({ limitUsd: 50 })),
      ).toEqual(['hard-spend-ceiling']);
    });

    it('permits an ordinary spend well under the ceiling', () => {
      expect(
        checkNeverTrustable([{ kind: 'spend', usd: 0.42 }], CEILING),
      ).toEqual([]);
      expect(checkNeverTrustable([{ kind: 'spend', usd: 0 }], CEILING)).toEqual(
        [],
      );
    });

    it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])(
      'refuses an unusable amount (%p) rather than reading it as free',
      (usd) => {
        // An unknown cost is not a zero cost. VISION §6 makes cost reporting a
        // declared capability some runners lack, so "no number" means the
        // runner did not say — and assuming $0 would make the ceiling
        // unenforceable against exactly those runners.
        expect(rulesFor([{ kind: 'spend', usd }])).toEqual([
          'hard-spend-ceiling',
        ]);
      },
    );

    it('refuses when no ceiling is configured — unset is not unlimited', () => {
      // #65's own rationale, applied unchanged: an unset ceiling means the
      // guard has nothing to check against, and an unbounded spend that cannot
      // be checked does not proceed. Reading absence as infinity would make
      // the least-configured install the most permissive one.
      expect(
        rulesFor([{ kind: 'spend', usd: 0.01 }], ceiling({ limitUsd: null })),
      ).toEqual(['hard-spend-ceiling']);
    });

    it('refuses when the configured ceiling is malformed', () => {
      // The case where somebody believed they had set a limit. A ceiling that
      // failed to parse is not a ceiling.
      expect(
        rulesFor(
          [{ kind: 'spend', usd: 0.01 }],
          ceiling({ limitUsd: null, malformed: '50O' }),
        ),
      ).toEqual(['hard-spend-ceiling']);
    });

    it('distinguishes the four ways a spend can be refused', () => {
      // Different operator actions: wait or lower the estimate; correct a
      // typo; set a ceiling at all; find out what the run actually cost.
      const reason = (usd: number, limit: HardCeiling) =>
        checkNeverTrustable([{ kind: 'spend', usd }], limit)[0].reason;

      expect(reason(500, ceiling({ limitUsd: 50 }))).toContain(
        'exceeds the hard ceiling of $50',
      );
      expect(reason(Number.NaN, CEILING)).toContain('not a usable amount');
      expect(reason(1, ceiling({ limitUsd: null }))).toContain(
        'no hard spend ceiling is configured',
      );
      expect(
        reason(1, ceiling({ limitUsd: null, malformed: '50O' })),
      ).toContain('"50O"');
    });

    it('checks an unusable amount before it checks the ceiling', () => {
      // Otherwise an install with no ceiling would report "no ceiling
      // configured" for a run whose real problem was that nobody knows what
      // it cost, and the operator would fix the wrong thing.
      const [refusal] = checkNeverTrustable(
        [{ kind: 'spend', usd: Number.NaN }],
        ceiling({ limitUsd: null }),
      );

      expect(refusal.reason).toContain('not a usable amount');
    });
  });

  describe('self-modification (VISION §8, the item that matters most)', () => {
    // The four cases #95 names explicitly. Each is a file that, if an agent
    // could write it, would leave the appearance of guardrails and none of the
    // substance.
    it.each([
      ['.github/workflows/ci.yml', 'a CI workflow'],
      ['.github/workflows/provenance.yml', 'the provenance gate workflow'],
      ['.github/actions/setup/action.yml', 'a composite action'],
      ['scripts/check-provenance.mjs', 'the trailer check VISION §8 names'],
      ['apps/api/src/supervisor/action-classes.ts', 'the policy table'],
      ['apps/api/src/autonomy/never-trustable.ts', 'the guard itself'],
      ['apps/api/src/autonomy/never-trustable.service.ts', 'the boundary'],
      ['infra/compose/.env', 'budget and credential configuration'],
      ['infra/compose/.env.example', 'the documented configuration surface'],
      ['apps/api/test.env', 'configuration that changed its file extension'],
    ])('refuses a write to %s (%s)', (path) => {
      expect(
        rulesFor([{ kind: 'file-write', repository: 'acme/web', path }]),
      ).toEqual(['self-modification']);
    });

    it('permits a write to the Prisma schema', () => {
      // Schema changes are ordinary work — most of the roadmap is schema
      // changes. A guard that fired on routine pull requests would be routed
      // around rather than respected.
      expect(
        checkNeverTrustable(
          [
            {
              kind: 'file-write',
              repository: 'acme/web',
              path: 'apps/api/prisma/schema.prisma',
            },
          ],
          CEILING,
        ),
      ).toEqual([]);
    });

    it('permits ordinary source and documentation writes', () => {
      for (const path of [
        'apps/api/src/users/users.service.ts',
        'apps/web/src/pages/Cockpit.tsx',
        'docs/ARCHITECTURE.md',
        'README.md',
      ]) {
        expect(
          checkNeverTrustable(
            [{ kind: 'file-write', repository: 'acme/web', path }],
            CEILING,
          ),
        ).toEqual([]);
      }
    });

    it('names the path and the reason it is protected', () => {
      const [refusal] = checkNeverTrustable(
        [
          {
            kind: 'file-write',
            repository: 'acme/web',
            path: 'apps/api/src/autonomy/never-trustable.ts',
          },
        ],
        CEILING,
      );

      expect(refusal.reason).toContain(
        'apps/api/src/autonomy/never-trustable.ts',
      );
      expect(refusal.reason).toContain('an agent that can edit the guard');
    });
  });

  describe('path normalisation', () => {
    it.each([
      '.github/workflows/../../x',
      '../.github/workflows/ci.yml',
      'apps/api/src/autonomy/../autonomy/never-trustable.ts',
      'a/../../../etc/passwd',
    ])('refuses %s rather than normalising it into permission', (path) => {
      // A resolver turns a traversal into a path that matches nothing and is
      // therefore permitted, which converts an escape attempt into a grant.
      expect(normaliseWritePath(path)).toBeNull();
      expect(
        rulesFor([{ kind: 'file-write', repository: 'acme/web', path }]),
      ).toEqual(['self-modification']);
    });

    it.each([
      './.github/workflows/ci.yml',
      '/.github/workflows/ci.yml',
      '.github//workflows/ci.yml',
      '.github/./workflows/ci.yml',
      '.github\\workflows\\ci.yml',
    ])('still refuses %s after normalising the spelling', (path) => {
      expect(normaliseWritePath(path)).toBe('.github/workflows/ci.yml');
      expect(forbiddenPathReason(path)).not.toBeNull();
    });

    it('is case-sensitive, matching the checkout CI actually reads', () => {
      // `.GitHub/workflows` is a different directory on Linux. Lower-casing
      // would refuse writes to files that are not the guarded ones while
      // protecting nothing extra.
      expect(forbiddenPathReason('.GitHub/workflows/ci.yml')).toBeNull();
      expect(forbiddenPathReason('.github/workflows/ci.yml')).not.toBeNull();
    });

    it('does not let the .env wildcard swallow a directory name', () => {
      expect(forbiddenPathReason('apps/web/src/env/index.ts')).toBeNull();
      expect(forbiddenPathReason('apps/web/src/environment.ts')).toBeNull();
    });
  });

  describe('quarantine (VISION §8)', () => {
    it('refuses clearing a quarantine, always', () => {
      // No condition to get wrong: quarantine exists because a human needs to
      // look, so an agent deciding nobody needs to look has removed the only
      // thing quarantine does.
      expect(
        rulesFor([{ kind: 'quarantine-clear', workOrder: 'wo-1' }]),
      ).toEqual(['quarantine-self-clear']);
    });

    it('names the work order it refused to release', () => {
      const [refusal] = checkNeverTrustable(
        [{ kind: 'quarantine-clear', workOrder: 'wo-42' }],
        CEILING,
      );

      expect(refusal.reason).toContain('wo-42');
    });
  });

  describe('trust grants (VISION §8)', () => {
    it.each(['create', 'widen', 'renew'] as const)(
      'refuses to %s a grant',
      (operation) => {
        expect(rulesFor([{ kind: 'trust-grant-write', operation }])).toEqual([
          'trust-self-grant',
        ]);
      },
    );

    it('permits revoking a grant, because auto-revoke is required', () => {
      // VISION §8: "Auto-revoke — failure rate or cost-per-PR crossing a
      // threshold suspends the grant and explains why" (#96). Narrowing trust
      // can never be the step that makes an incident worse, so refusing it
      // would break a required safety behaviour in the name of safety.
      expect(
        checkNeverTrustable(
          [{ kind: 'trust-grant-write', operation: 'revoke' }],
          CEILING,
        ),
      ).toEqual([]);
    });
  });

  describe('permitted effects', () => {
    it('permits the ordinary effects the factory is built to produce', () => {
      expect(
        checkNeverTrustable(
          [
            { kind: 'issue-create', repository: 'acme/web' },
            { kind: 'issue-edit', repository: 'acme/web', ref: 'acme/web#7' },
            { kind: 'dispatch', repository: 'acme/web', workOrder: 'wo-1' },
            { kind: 'comment', repository: 'acme/web', ref: 'acme/web#7' },
            { kind: 'spend', usd: 1.25 },
            push(),
          ],
          CEILING,
        ),
      ).toEqual([]);
    });
  });

  describe('multiple refusals', () => {
    it('returns every rule that matched, not the first', () => {
      // "It also tried to read credentials" is exactly the detail an early
      // return would lose, and exactly the signal #95 exists to preserve.
      const refusals = checkNeverTrustable(
        [
          push({ branch: 'main', force: true, protectedBranch: true }),
          { kind: 'credential-access', mode: 'read', what: 'GITHUB_TOKEN' },
          { kind: 'delete', subject: 'branch', ref: 'factory/wo-1' },
          { kind: 'spend', usd: 5_000 },
          {
            kind: 'file-write',
            repository: 'acme/web',
            path: '.github/workflows/ci.yml',
          },
          { kind: 'quarantine-clear', workOrder: 'wo-1' },
          { kind: 'trust-grant-write', operation: 'widen' },
        ],
        CEILING,
      );

      expect(refusals.map((refusal) => refusal.rule)).toEqual([
        'force-push',
        'protected-branch-write',
        'credential-access',
        'destructive-delete',
        'hard-spend-ceiling',
        'self-modification',
        'quarantine-self-clear',
        'trust-self-grant',
      ]);
    });

    it('gives every refusal its own effect and its own sentence', () => {
      const refusals = checkNeverTrustable(
        [
          { kind: 'delete', subject: 'issue', ref: 'acme/web#7' },
          { kind: 'delete', subject: 'branch', ref: 'factory/wo-1' },
        ],
        CEILING,
      );

      expect(refusals).toHaveLength(2);
      expect(refusals[0].reason).toContain('acme/web#7');
      expect(refusals[1].reason).toContain('factory/wo-1');
      expect(new Set(refusals.map((r) => r.reason)).size).toBe(2);
    });
  });

  describe('the forbidden-path list', () => {
    it('is frozen, entries included', () => {
      expect(Object.isFrozen(FORBIDDEN_WRITE_PATHS)).toBe(true);
      for (const rule of FORBIDDEN_WRITE_PATHS) {
        expect(Object.isFrozen(rule)).toBe(true);
      }
    });

    it('explains every pattern, because the why lands in the refusal', () => {
      for (const rule of FORBIDDEN_WRITE_PATHS) {
        expect(rule.why.trim()).not.toBe('');
      }
    });
  });
});
