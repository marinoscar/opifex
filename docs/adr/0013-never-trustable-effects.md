# 13. Never-trustable is a list of effects, checked at the execution boundary

- Status: Proposed
- Date: 2026-08-24
- Issue: #233
- Epic: #22

## Context

VISION §8 names five things no grant may ever authorise: force-push or write to a
protected branch; delete a branch, issue, or pull request; read or write credentials;
spend above the hard ceiling; modify CI workflows, the policy table, or budget
configuration.

None of those five is an action class. `apps/api/src/supervisor/action-classes.ts`
(ADR-0011) registers seven: `run-diagnosis`, `re-dispatch`, `decomposition`,
`issue-shaping`, `spec-quality-feedback`, `daily-brief`, `quarantine-decision`. Walk the
list in both directions and it does not close: none of VISION §8's five sentences names
one of the seven registered classes, and none of the seven is force-push, deletion,
credential access, overspend, or a CI/policy/budget edit. `decomposition`'s effect is
"new GitHub issues, created only through the gated issue-creation adapter" — it creates.
Nothing in the taxonomy deletes one. There is no class called "delete a branch" to mark
ineligible, because deleting a branch was never proposed as a class in the first place.

So the never-trustable list cannot be expressed as a flag on the registry. A flag
narrows something the registry already enumerates — `autonomyEligible: false` on
`quarantine-decision` says "this class is never promoted," and it can say that because
`quarantine-decision` is a row in the table. VISION §8's list is not made of rows in that
table. It is made of things no class describes, because they are not proposals about
what kind of judgment call is being made; they are constraints on what any proposal, of
any class, is permitted to do once approved.

The stakes are concrete: Phase 7 is the first point at which anything the supervisor
produces gets executed at all. Before Phase 7 there is no executor to reach
(`supervisor-isolation.spec.ts`, #90) and the never-trustable list is moot. Once an
executor exists, "checked somewhere, by someone, eventually" is not a guarantee — a
guarantee that depends on being remembered is the thing VISION §3.6 already rejected for
model output, and the argument applies just as hard to the code that carries the
model's proposal into effect.

ADR-0011 is explicit about why one registry exists rather than several: "A Prisma enum,
a TypeScript union, and a table in the docs would each drift from the other two, and the
drift would show up as an approval rate computed over a class that no longer means what
the grant thinks it means." A second list is the exact failure ADR-0011 exists to
prevent — so adding one needs an argument, not an assumption that this case is different.
This ADR makes that argument.

## Decision

**The never-trustable list is a list of effects, not of action classes, and it is
checked at the execution boundary against what an action is about to do.**

### The forbidden-effect registry is a separate module, over a separate kind of object

`apps/api/src/autonomy/never-trustable.ts` holds a frozen list of forbidden effect
predicates. An effect is a discriminated union describing a concrete operation, not a
judgment: `git-push` (carrying `force` and `branch`), `delete` (carrying `subject`:
`branch` | `issue` | `pull-request`), `credential-access`, `spend` (carrying `usd`),
`file-write` (carrying `path`), `quarantine-clear`, `trust-grant-write`. The guard walks
the list of effects an action is about to produce, checks each against the forbidden
predicates, and returns a refusal naming which rule matched — not a bare boolean, because
"denied" without a reason is exactly the kind of check an operator has to re-derive by
hand the first time it fires.

### This is not a second registry, because it partitions a different kind of thing

`ACTION_CLASSES` partitions _proposals_ — what the supervisor is asking to do, for the
purpose of measurement. `NEVER_TRUSTABLE` partitions _effects_ — what a proposal, once
approved, would actually change, for the purpose of prohibition. A registry and a guard
list are not two descriptions of the same object competing to be the source of truth for
it; they describe two different objects that happen to be produced together. They cannot
drift against each other because there is no shared fact for them to disagree about.

The one place they meet is `effectsFor(actionClass: ActionClassId, params: unknown):
Effect[]` — a single function, not a convention each executor is trusted to follow on its
own. Every action class maps to the effects a concrete instance of it would produce
before the guard ever runs. `re-dispatch` maps to a `git-push` (never `force`, never
`protected`) plus a `spend` bounded by the work order's budget ceiling. `decomposition`
maps to zero or more issue-creation effects, never a `delete`. If a future action class's
`effectsFor` entry ever produced a `delete` or a `force` push, that is not a bug in the
guard — the guard would refuse it correctly. It is a bug in the mapping, and the mapping
lives in one file, reviewed once, rather than in however many places call it.

### Effects are declared in the type, so omission is a compile error

The autonomy execution request carries a required, non-optional `effects: Effect[]`
field. There is no path from a proposal to the execution boundary that skips populating
it — an executor without effects does not typecheck, let alone run. This is what closes
the honesty hole a self-reported, _optional_ declaration would leave open: an optional
field is a field someone forgets, and "someone forgot" is not a security property.

It closes that hole partially, and the ADR should say so rather than imply otherwise: a
required field guarantees an executor produces _some_ effect list, not that the list is
_correct_. A caller that lies about its own effects — reports `file-write` for something
that also force-pushes — still passes the guard. That is why `effectsFor` is centralised
and tested rather than delegated to each caller's self-report: the honesty of the
declaration is a property of one function, tested once, instead of a property trusted
of every executor that will ever exist.

### The module reads no configuration

`never-trustable.ts` imports no `ConfigService`, reads no `process.env`, and performs no
database lookup. It does not own a spend ceiling either — it takes one as a parameter.

That last point is a correction worth stating plainly, because the obvious design is
wrong. A literal `HARD_SPEND_CEILING_USD` in this module would be a _second_ ceiling: the
repo already has one, built for #65 at `apps/api/src/budget/hard-spend-ceiling.ts`, and
its header already argues the VISION §8 case — it reads `OPIFEX_HARD_SPEND_CEILING_USD`
from `process.env` once, in a constructor, into `readonly` fields with no setter,
deliberately bypassing `ConfigService` because `ConfigService.set()` would itself be a
runtime path to a higher limit. Two ceilings would disagree the moment either moved, and
a guard checking the wrong one is worse than no guard, because it reports success. This
is the same drift argument ADR-0011 makes about registries, arriving at the same answer:
one source, consumed everywhere.

So `checkNeverTrustable(effects: readonly AutonomyEffect[], ceiling: SpendCeiling):
NeverTrustableRefusal[]` stays pure and config-free by not holding the number at all —
`SpendCeiling` is `HardCeiling` from `hard-spend-ceiling.ts` (`{ limitUsd: number | null;
windowDays: number; malformed: string | null }`), not a locally redefined shape.
`NeverTrustableService` injects `HardSpendCeilingService` and passes `.value` through,
which means `AutonomyModule` adds `BudgetModule` to its own `imports` — `BudgetModule`
already exports `HardSpendCeilingService` for `DispatchModule`'s use, so this is wiring,
not new surface. The `spend` rule refuses when a proposed `usd` is non-finite or
negative (unknown is not zero), when `ceiling.limitUsd` is `null` — the non-obvious half,
carried over from #65 and not to be softened here: an **unset** ceiling does not mean
unlimited, it means the guard has nothing to check against, and an unbounded spend that
cannot be checked does not proceed — or when `usd > ceiling.limitUsd`. Exactly at the
ceiling still passes.

#95's requirement is that the ceiling be "provably unreachable from config," and a claim
about what a module does not import is the kind of claim a test proves by inspecting the
source, in the same style `supervisor-isolation.spec.ts` already uses for the
supervisor's isolation from execution: read the file, assert the forbidden imports are
absent, fail the build the day someone adds one. Here the assertion is stronger than a
check on a literal's value — it is that this file declares no ceiling of its own, which
proves there is exactly one in the codebase rather than proving this copy happens to
match.

### A refusal is recorded

Every refusal writes an `AuditEvent` with `action: 'autonomy.refused'`, carrying the
matched rule and the effect that triggered it. A system that repeatedly attempts a
forbidden action is a signal worth seeing on its own terms, independent of whether the
attempt succeeded — and a refusal that is silently dropped at the boundary makes that
signal invisible at the exact moment it would matter most: repeated attempts are how a
misbehaving proposer or a promotion mistake would first show up.

## Consequences

Every executor must enumerate its effects through `effectsFor` before it can reach the
boundary. That is friction by design, not an oversight to streamline later — an executor
that cannot state what it is about to do is exactly the thing the guard exists to stop.

`effectsFor` becomes the single highest-leverage file in the autonomy path and deserves
review proportional to that: it is the one place a correct guard can still be fed a wrong
answer. A bug in the guard's rules is caught by testing the guard. A bug in
`effectsFor` — a class that should map to a `delete` mapping to a `file-write` instead —
is caught only by testing the mapping itself, which is why it is centralised rather than
left to each caller.

The forbidden-effect list is a floor, not a ceiling. An effect kind that is real but not
yet modelled in the `Effect` union is not caught, because the guard can only refuse what
it can name. Widening the `Effect` union is therefore itself a change worth the same
scrutiny as widening the action-class registry, even though it is a different file.

The guard's independence from the class registry cuts both ways, and the direction that
matters is worth stating rather than leaving implicit: a never-trustable refusal can fire
against an action of a class nobody has ever promoted, or that has no `autonomyEligible`
row at all. That is correct behaviour, not a gap — the guard does not ask what class an
action belongs to before deciding whether to refuse it, because the whole point of
putting the check on the effect rather than the class is that it does not need the class
to be right.

## Alternatives considered

**A — extend the action-class registry with forbidden entries.** Keep one registry, as
ADR-0011 argues for, by adding rows like `force-push` and `delete-branch` with
`autonomyEligible: false`. Disqualified on several independent grounds: it makes the
registry mean two things at once — partition key for measurement, and prohibition list —
where ADR-0011 built it to mean exactly one; it puts classes that structurally cannot be
proposed (nothing in the taxonomy proposes a force-push) into the same table whose
`ACTION_CLASS_IDS` the API contract publishes as the classes the supervisor can propose,
which would have the API advertise a capability the system does not have; it pollutes the
approval-rate denominator with entries that can never accumulate evidence because nothing
generates them. The disqualifying reason is structural rather than cosmetic: it puts the
guarantee on the same axis as the measurement. A promotion bug that flipped
`autonomyEligible` on the wrong row would unlock force-push, because the same boolean
that decides "may this be promoted" would also decide "may this ever run." Those need to
fail independently.

**B — a separate forbidden-effect list, checked at the execution boundary.** Chosen. The
argument above.

**C — both, as defence in depth.** Keep a class-level advisory flag and add the
effect-level guard underneath it. Disqualified for two reasons. First, VISION §3.7
commits to building one runner well before building a second — the same discipline
applies to guardrails: build the mechanism that actually closes the gap before building
a second one that overlaps it, rather than building both because neither commitment is
fully trusted. Second, and more concretely, two mechanisms that can disagree are worse
than one: if the class-level flag and the effect-level guard ever computed different
answers for the same action, neither one would be _the_ guarantee any more — an operator
reading an incident would not know which layer to trust, and "we have two checks" is not
an answer to "which one is authoritative."
