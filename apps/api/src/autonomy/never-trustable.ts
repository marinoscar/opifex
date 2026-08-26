import type { HardCeiling } from '../budget/hard-spend-ceiling';

/**
 * The never-trustable list (#95, ADR-0013).
 *
 * VISION §8 names the things no grant may ever authorise: force-push or any
 * write to a protected branch; deleting branches, issues or pull requests;
 * reading or writing credentials; spend above the hard ceiling; modifying CI
 * workflows or the policy table; and modifying budget configuration outside an
 * interactive, RBAC-gated admin action. It calls the CI-workflow and
 * policy-table item the one that matters most — "an agent that can edit the
 * check enforcing its own trailers, or grant itself trust, has the appearance
 * of guardrails and none of the substance."
 *
 * That last clause used to read "modifying CI workflows, the policy table, or
 * budget configuration", unqualified, and #345 split it. Nothing about what an
 * AGENT may do changed: this file refuses a `budget-config-write` effect
 * unconditionally, and no trust grant, promoted action class or
 * agent-reachable path moves a spend ceiling. What the amendment admits is
 * that a signed-in human admin lowering a ceiling during an incident is not an
 * agent raising its own limit, and the ceilings became editable from the
 * Control Center on exactly those terms (ADR-0018 §6).
 *
 * ADR-0013 settled WHERE that list lives. It is not a flag on
 * `supervisor/action-classes.ts`, because none of the five is an action class:
 * nothing in the taxonomy proposes a force-push, and there is no class called
 * "delete a branch" to mark ineligible. The registry partitions PROPOSALS for
 * measurement; this file partitions EFFECTS for prohibition. Two different
 * objects, so there is no shared fact for them to drift on.
 *
 * ## This file reads no configuration, and that is the whole guarantee
 *
 * No `ConfigService`, no `process.env`, no database, no injection, and one
 * type-only import. #95 requires the hard ceiling be "provably unreachable
 * from config", and the only proof that survives a refactor is that there is
 * no value in the evaluation path that configuration could have written.
 * `autonomy-purity.spec.ts` asserts that over the source text, in the style
 * `supervisor-isolation.spec.ts` already uses, because a comment asking future
 * maintainers not to inject anything loses to a convenient afternoon.
 *
 * ## It declares no ceiling of its own
 *
 * The hard spend ceiling already exists, at `budget/hard-spend-ceiling.ts`,
 * built for #65 and argued there against this same VISION §8 clause. It is
 * passed in as a value. A second constant here would be precisely the drift
 * ADR-0011 and ADR-0013 both refuse — and a guard checking the wrong ceiling
 * is worse than no guard, because it reports success.
 *
 * ## It is a floor, not a ceiling
 *
 * The guard can only refuse an effect it can name. An operation that is real
 * but absent from `AutonomyEffect` passes, silently. Widening that union is
 * therefore a change worth the same scrutiny as widening the action-class
 * registry, even though it lands in a different file (ADR-0013, consequences).
 */

/**
 * One concrete thing an action would do if it were executed.
 *
 * Deliberately a description of operations, not of judgment: `git-push`, not
 * "re-dispatch". The forbidden members and the permitted ones live in the same
 * union on purpose — a guard whose type only knows about sins cannot express a
 * permitted action, and every caller would then have to model "nothing
 * forbidden happens here" as an empty array, which is indistinguishable from
 * "nobody filled this in".
 */
export type AutonomyEffect =
  | {
      kind: 'git-push';
      repository: string;
      branch: string;
      force: boolean;
      protectedBranch: boolean;
    }
  | {
      kind: 'delete';
      subject: 'branch' | 'issue' | 'pull-request' | 'run' | 'work-order';
      ref: string;
    }
  | { kind: 'credential-access'; mode: 'read' | 'write'; what: string }
  | { kind: 'spend'; usd: number }
  | { kind: 'file-write'; repository: string; path: string }
  | { kind: 'quarantine-clear'; workOrder: string }
  | {
      kind: 'trust-grant-write';
      operation: 'create' | 'widen' | 'renew' | 'revoke';
    }
  | {
      /**
       * A write to the spend ceilings' own configuration (#345, ADR-0018 §6).
       *
       * ADR-0013's union had no name for this and did not need one: there was
       * no reachable code path any effect could describe, because
       * `hard-spend-ceiling.ts` had no setter for anything to call. Epic #332
       * created one — `PATCH /api/operator-settings` — and ADR-0013's own
       * consequences say what follows: "An effect kind that is real but not
       * yet modelled in the `Effect` union is not caught, because the guard
       * can only refuse what it can name."
       *
       * Nothing in this ADR's design should ever let an action class's
       * `effectsFor` legitimately produce this. That is the point. The guard
       * "does not ask what class an action belongs to", so a promotion mistake
       * or a future executor wired incorrectly is refused here regardless of
       * what the class registry says — which is the only case this member
       * exists for.
       */
      kind: 'budget-config-write';
      /** The managed key or variable being written, named in the refusal. */
      setting: string;
    }
  | { kind: 'issue-create'; repository: string }
  | { kind: 'issue-edit'; repository: string; ref: string }
  | { kind: 'dispatch'; repository: string; workOrder: string }
  | { kind: 'comment'; repository: string; ref: string };

/**
 * The rules, by stable id.
 *
 * These ids are stored in audit rows (`autonomy.refused`), so they are as
 * permanent as an action-class id: renaming one silently splits the history of
 * how often that rule fired, which is the signal #95 exists to preserve.
 */
export type NeverTrustableRule =
  | 'force-push'
  | 'protected-branch-write'
  | 'destructive-delete'
  | 'credential-access'
  | 'hard-spend-ceiling'
  | 'self-modification'
  | 'quarantine-self-clear'
  | 'trust-self-grant'
  | 'budget-config-write';

/** One rule refusing one effect, with the sentence a human reads. */
export interface NeverTrustableRefusal {
  /** Stable id of the rule that matched, e.g. 'force-push'. */
  rule: NeverTrustableRule;
  /** The effect that matched, for the audit record. */
  effect: AutonomyEffect;
  /**
   * One sentence a human reads, naming what was refused and why.
   *
   * Names the specific repository, branch, path or amount. "Denied by policy"
   * is the kind of message an operator has to re-derive by hand the first time
   * it fires, and the first time it fires is exactly when nobody has time to.
   */
  reason: string;
}

/** A path pattern that no autonomous action may write to, and why. */
export interface ForbiddenPathRule {
  /**
   * One of three forms, matched by `matchesPattern` below:
   *  - a directory followed by a double-star segment — that directory and
   *    everything under it, e.g. `.github/workflows` + `/**`
   *  - a double-star segment followed by a basename — a file with that name
   *    anywhere in the tree, where the name may carry a single `*` at one end
   *  - anything else — an exact repository-relative path
   *
   * A deliberately tiny subset of glob syntax, written out by hand below. A
   * glob library would be a dependency in the one module whose value is that
   * it has none.
   */
  readonly pattern: string;
  /** Named in the refusal, so the sentence says what was being protected. */
  readonly why: string;
}

/**
 * VISION §8's "CI workflows, the policy table, or budget configuration",
 * spelled out as paths in this repository.
 *
 * `apps/api/prisma/schema.prisma` is deliberately NOT here. Schema changes are
 * ordinary work — most of the roadmap is schema changes — and forbidding them
 * would make the guard fire on routine pull requests, which is how a guard
 * gets routed around instead of respected.
 *
 * ## THE `.env` RULES ARE NOW A BACKSTOP, NOT THE PRIMARY CONTROL (#346)
 *
 * The three env-file rules at the bottom of this list were the primary control
 * for "budget, quota and credential configuration", and they worked for one
 * reason: that configuration was a FILE, so changing it was a `file-write`
 * effect, and a `file-write` effect is something this guard can name and
 * match.
 *
 * Epic #332 moved that configuration into the `operator_settings` table,
 * reachable through `PATCH /api/operator-settings`. Changing a spend ceiling
 * is now an authenticated HTTP request. It produces no `file-write` effect and
 * therefore never reaches these rules at all — they did not become wrong, they
 * became INAPPLICABLE, which is worse, because a rule that stops firing looks
 * exactly like a rule that is never violated.
 *
 * What actually holds that line now lives elsewhere, in three independent
 * pieces — the first two being preconditions of ADR-0018 §6, the third being
 * this file's own answer to the gap:
 *
 *  - `runners/process/child-environment.ts` (#334) — the agent subprocess
 *    inherits an allowlist, so it holds no credential to authenticate with.
 *  - `auth/guards/interactive-session.guard.ts` (#346) — the settings write
 *    path refuses any credential that does not prove a human was present,
 *    whatever permissions it carries.
 *  - the `budget-config-write` member of `AutonomyEffect` below (#345) — the
 *    write named as an effect this guard can see, so that an action reaching
 *    it through some path nobody modelled is refused on its own terms rather
 *    than passing because no `file-write` happened to be involved.
 *
 * The rules below stay, and are load-bearing for what remains: an agent
 * writing an `.env` file in a repository workspace is still a file write this
 * guard can see, deployments still carry `.env` files, and not every key has
 * migrated. But do not read their presence as evidence that budget
 * configuration is protected — the copy that matters is a database row, and
 * these patterns cannot reach it. Deleting them would be a regression;
 * relying on them alone would be a fiction.
 */
export const FORBIDDEN_WRITE_PATHS: readonly ForbiddenPathRule[] =
  Object.freeze([
    Object.freeze({
      pattern: '.github/workflows/**',
      why: 'a CI workflow is the check that enforces every other rule',
    }),
    Object.freeze({
      pattern: '.github/actions/**',
      why: 'a composite action is a CI workflow with one level of indirection',
    }),
    Object.freeze({
      // Blunt on purpose. Enumerating only today's gates —
      // `check-provenance.mjs` (the trailer check VISION §8 names outright)
      // and `generate-contract-types.mjs --check` — fails open the day someone
      // adds a third gate script and does not think of this file. The cost of
      // the blunt version is that an agent cannot edit a developer convenience
      // script either; that cost is small, visible, and paid by a human in a
      // pull request rather than discovered in an incident.
      pattern: 'scripts/**',
      why: 'CI invokes these as gates, so editing one edits the gate',
    }),
    Object.freeze({
      pattern: 'apps/api/src/autonomy/**',
      why: 'an agent that can edit the guard has no guard',
    }),
    Object.freeze({
      pattern: 'apps/api/src/supervisor/action-classes.ts',
      why: 'the policy table: what may be proposed and what may be promoted',
    }),
    Object.freeze({
      // `infra/compose/.env` is the concrete one; the pattern covers every
      // sibling because budget configuration that moved file is still budget
      // configuration.
      pattern: '**/.env',
      why: 'budget, quota and credential configuration',
    }),
    Object.freeze({
      pattern: '**/.env.*',
      why: 'budget, quota and credential configuration (.env.example included)',
    }),
    Object.freeze({
      pattern: '**/*.env',
      why: 'budget, quota and credential configuration',
    }),
  ]);

/**
 * Every rule that would refuse this effect set. Empty means permitted.
 *
 * ALL matches, not the first. An action attempting three forbidden things is a
 * different event from one attempting a single thing, and "it also tried to
 * read credentials" is precisely the detail that would be lost by returning
 * early — #95 wants the whole attempt on the record, because repeated or
 * escalating attempts are how a misbehaving proposer first shows up.
 *
 * Note the signature: effects and the ceiling in, refusals out. No grant, no
 * scope, no actor. A grant parameter would imply some grant could change the
 * answer, and VISION §8's phrase is "regardless of any grant"; the absence is
 * the guarantee. The ceiling is a parameter rather than a constant because
 * #65 already owns it — see the file header — and passing it in as a value
 * keeps this function testable over the whole truth table without a process
 * environment, exactly as `spend-admission.ts` does with the same object.
 */
export function checkNeverTrustable(
  effects: readonly AutonomyEffect[],
  ceiling: HardCeiling,
): NeverTrustableRefusal[] {
  const refusals: NeverTrustableRefusal[] = [];

  for (const effect of effects) {
    switch (effect.kind) {
      case 'git-push': {
        // Both can fire for one push. A force-push to a protected branch is
        // two distinct prohibitions, and collapsing them would under-report
        // what was attempted.
        if (effect.force) {
          refusals.push({
            rule: 'force-push',
            effect,
            reason:
              `Refused: force-push to ${effect.repository}@${effect.branch}. ` +
              'Force-pushing is never trustable (VISION §8), regardless of ' +
              'any grant.',
          });
        }
        if (effect.protectedBranch) {
          refusals.push({
            rule: 'protected-branch-write',
            effect,
            reason:
              `Refused: push to protected branch ${effect.repository}@` +
              `${effect.branch}. Writes to protected branches are never ` +
              'trustable (VISION §8), regardless of any grant.',
          });
        }
        break;
      }

      case 'delete': {
        // `run` and `work-order` are control-plane rows: Opifex's own record
        // of execution state (VISION §3.3), not artefacts a human authored or
        // GitHub holds. VISION §8's list is "branches, issues, or pull
        // requests" — user artefacts, where a deletion destroys something
        // nobody else has a copy of. Refusing a work-order cleanup would put
        // the guard in the way of ordinary housekeeping and teach operators
        // that refusals are noise.
        if (
          effect.subject === 'branch' ||
          effect.subject === 'issue' ||
          effect.subject === 'pull-request'
        ) {
          refusals.push({
            rule: 'destructive-delete',
            effect,
            reason:
              `Refused: delete of ${effect.subject} ${effect.ref}. Deleting ` +
              'branches, issues and pull requests is never trustable ' +
              '(VISION §8), regardless of any grant.',
          });
        }
        break;
      }

      case 'credential-access': {
        // Both modes. Reading is the one that looks harmless and is not: a
        // credential in a model's context has left the boundary permanently,
        // and no subsequent action can put it back.
        refusals.push({
          rule: 'credential-access',
          effect,
          reason:
            `Refused: ${effect.mode} access to credential "${effect.what}". ` +
            'Reading or writing credentials is never trustable (VISION §8), ' +
            'regardless of any grant.',
        });
        break;
      }

      case 'spend': {
        const refusal = spendRefusalReason(effect.usd, ceiling);
        if (refusal !== null) {
          refusals.push({
            rule: 'hard-spend-ceiling',
            effect,
            reason: refusal,
          });
        }
        break;
      }

      case 'file-write': {
        const forbidden = forbiddenPathReason(effect.path);
        if (forbidden !== null) {
          refusals.push({
            rule: 'self-modification',
            effect,
            reason:
              `Refused: write to ${effect.repository}:${effect.path}. ` +
              `${forbidden} — modifying CI workflows, the policy table or ` +
              'budget configuration is never trustable (VISION §8).',
          });
        }
        break;
      }

      case 'quarantine-clear': {
        // Always, with no condition to get wrong. VISION §8: "it cannot clear
        // its own quarantine." Quarantine exists because a human needs to
        // look, so an agent deciding nobody needs to look has removed the
        // only thing quarantine does.
        refusals.push({
          rule: 'quarantine-self-clear',
          effect,
          reason:
            `Refused: clearing quarantine on work order ${effect.workOrder}. ` +
            'Only a human clears quarantine (VISION §8) — the label ' +
            'factory:clear-quarantine is the human-authored input that does ' +
            'it.',
        });
        break;
      }

      case 'trust-grant-write': {
        // The asymmetry is the interesting part. Creating, widening or
        // renewing a grant is an agent enlarging its own authority — VISION
        // §8's "grant itself trust", the case it says matters most. Revoking
        // is the opposite motion, and VISION §8 requires it: "Auto-revoke —
        // failure rate or cost-per-PR crossing a threshold suspends the grant
        // and explains why" (#96). Narrowing trust can never be the step that
        // makes an incident worse, so refusing it would break a required
        // safety behaviour in the name of safety.
        if (effect.operation !== 'revoke') {
          refusals.push({
            rule: 'trust-self-grant',
            effect,
            reason:
              `Refused: ${effect.operation} of a trust grant. An agent that ` +
              'can grant itself trust has the appearance of guardrails and ' +
              'none of the substance (VISION §8); only revoke is permitted.',
          });
        }
        break;
      }

      case 'budget-config-write': {
        // Always, with no condition to get wrong, and deliberately NOT
        // conditioned on which setting or which direction. ADR-0018's own
        // alternatives section rejects "lowering is fine, raising is not" for
        // the write path, and the argument is sharper here: if something that
        // is not a human admin has reached this effect at all, it can lower
        // the ceiling to zero and stand the factory down, which is a
        // differently-shaped but still real harm.
        refusals.push({
          rule: 'budget-config-write',
          effect,
          reason:
            `Refused: write to budget configuration "${effect.setting}". ` +
            'Modifying budget configuration is never trustable outside an ' +
            'interactive, RBAC-gated admin action (VISION §8, ADR-0018 §6) — ' +
            'no trust grant, promoted action class or agent-reachable path ' +
            'moves a spend ceiling.',
        });
        break;
      }

      case 'issue-create':
      case 'issue-edit':
      case 'dispatch':
      case 'comment':
        // Ordinary, permitted effects. Listed rather than folded into a
        // `default`, so adding a member to `AutonomyEffect` is a compile error
        // here and a deliberate decision about which side of the list it falls
        // on — instead of silently landing on the permitted side.
        break;
    }
  }

  return refusals;
}

/**
 * Why this amount may not be spent, or `null` if it may.
 *
 * Four ways to refuse, and only one of them is "too much". The other three all
 * say the same thing in different words: the check could not be performed, and
 * an unbounded spend that cannot be checked does not proceed. #65's own
 * rationale for `no-hard-spend-ceiling-configured` is the argument, and it
 * applies here unchanged — VISION §3.5 gates on reversibility, and spend is
 * not reversible.
 */
function spendRefusalReason(usd: number, ceiling: HardCeiling): string | null {
  if (!Number.isFinite(usd) || usd < 0) {
    // An uncomputable cost is not a free one. VISION §6 makes cost reporting a
    // declared runner capability rather than a guarantee, so an absent number
    // means the runner did not say — and treating "did not say" as $0 would
    // make the ceiling unenforceable against exactly the runners that cannot
    // report against it.
    return (
      `Refused: spend of "${String(usd)}" is not a usable amount. An unknown ` +
      'cost is not a zero cost (VISION §6), so it is refused rather than ' +
      'assumed to be under the ceiling.'
    );
  }

  if (ceiling.malformed !== null) {
    // Checked before the unset case and reported as its own thing, because it
    // is the case where somebody believed they had set a limit. A ceiling that
    // failed to parse is not a ceiling.
    return (
      `Refused: spend of $${usd} cannot be checked — the configured hard ` +
      `ceiling ${JSON.stringify(ceiling.malformed)} is not a usable number ` +
      '(#65). A ceiling that failed to parse is not a ceiling.'
    );
  }

  if (ceiling.limitUsd === null) {
    // UNSET DOES NOT MEAN UNLIMITED, and this is the half a future reader will
    // otherwise "fix". Reading an absent ceiling as infinity would make the
    // strongest configuration — none at all — also the most permissive one,
    // so forgetting to set a limit would silently authorise every spend the
    // guard exists to stop.
    return (
      `Refused: spend of $${usd} cannot be checked — no hard spend ceiling ` +
      'is configured (#65). An unset ceiling is not an unlimited one: the ' +
      'guard has nothing to check against, so the spend does not proceed.'
    );
  }

  if (usd > ceiling.limitUsd) {
    // `>` and not `>=`: a spend of exactly the ceiling is at the ceiling, not
    // above it, and "ceiling" is the word VISION §8 uses.
    //
    // The sentence used to end "configuration may only lower it, and only by
    // restarting the process". That stopped being true in #345: an admin can
    // raise it from the Control Center. What did NOT change is the half this
    // message is actually about — no grant raises it — so the correction names
    // who can, rather than dropping the claim and leaving an operator who has
    // just been refused to go looking for the knob on their own.
    return (
      `Refused: spend of $${usd} exceeds the hard ceiling of ` +
      `$${ceiling.limitUsd}. No trust grant, promoted action class or agent ` +
      'raises it (VISION §8); only a signed-in admin can, interactively, on ' +
      'the record (ADR-0018 §6).'
    );
  }

  return null;
}

/**
 * The `why` of the first forbidden rule this path matches, or `null`.
 *
 * Normalisation is deliberately paranoid and hand-written; a glob library
 * would be a dependency in the one module whose value is that it depends on
 * nothing.
 */
export function forbiddenPathReason(rawPath: string): string | null {
  const path = normaliseWritePath(rawPath);

  if (path === null) {
    return 'a path containing ".." is a traversal attempt, not a file name';
  }

  for (const rule of FORBIDDEN_WRITE_PATHS) {
    if (matchesPattern(rule.pattern, path)) {
      return rule.why;
    }
  }

  return null;
}

/**
 * A repository-relative path in one canonical form, or `null` to refuse.
 *
 * Refusing on `..` ANYWHERE rather than resolving it: a resolver turns
 * `.github/workflows/../../x` into a path that matches nothing and is
 * therefore permitted, which converts an escape attempt into a permission.
 * Nothing in this system has a legitimate reason to write through a parent
 * reference, and the false positive — a file whose name genuinely contains
 * two dots — costs one human deciding to do it by hand.
 *
 * Case is preserved. `.GitHub/workflows` is a different directory on the Linux
 * checkout CI reads, so lower-casing would refuse writes to files that are not
 * the guarded ones while protecting nothing extra.
 */
export function normaliseWritePath(rawPath: string): string | null {
  const unified = rawPath.replace(/\\/g, '/');

  if (unified.includes('..')) {
    return null;
  }

  // Drops '', '.' and the leading slash in one pass, so './a//b' and '/a/./b'
  // both land on 'a/b'.
  const segments = unified
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.');

  return segments.join('/');
}

/** The three pattern forms documented on `ForbiddenPathRule.pattern`. */
function matchesPattern(pattern: string, path: string): boolean {
  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -3);
    return path === prefix || path.startsWith(`${prefix}/`);
  }

  if (pattern.startsWith('**/')) {
    return matchesBasename(pattern.slice(3), basenameOf(path));
  }

  return path === pattern;
}

/** A basename glob with at most one `*`, at one end. */
function matchesBasename(glob: string, name: string): boolean {
  if (glob.startsWith('*')) {
    const suffix = glob.slice(1);
    // `name.length > suffix.length` keeps `*.env` from matching `.env`
    // itself; `.env` has its own rule, and letting the wildcard cover it
    // would make removing that rule look harmless.
    return name.endsWith(suffix) && name.length > suffix.length;
  }

  if (glob.endsWith('*')) {
    const prefix = glob.slice(0, -1);
    return name.startsWith(prefix) && name.length > prefix.length;
  }

  return name === glob;
}

function basenameOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? path : path.slice(cut + 1);
}
