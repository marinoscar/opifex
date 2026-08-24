# 11. Grant autonomy per (capability, effect) pair, from one frozen registry

- Status: Proposed
- Date: 2026-08-24
- Issue: #218
- Epic: #21

## Context

VISION §7 makes the action class the unit of trust — "granted per **action class**, on
evidence, never in bulk" — and §14 calls it "the unit at which autonomy is granted —
never 'the agent' as a whole." So the class name is the partition key for every approval
rate the promotion ladder computes. Choosing it wrong is not a naming problem but a
measurement problem, and it is undetectable until a month of evidence has already been
binned the wrong way.

Two forces pull against each other and cannot both be satisfied.

Coarse classes accumulate samples quickly, so each one reaches a meaningful count inside
Phase 6's two-to-four week observation window. But promoting a coarse class grants more
authority than the evidence covers: a class called "modify GitHub" would earn its record
writing labels and then cash that record in creating issues.

Fine classes are exactly as wide as what was measured, so a grant cannot overreach. But a
class proposed twice in a month never leaves rung 2, and VISION §7's expected promotion
order — re-dispatch, then decomposition, then issue shaping — becomes unreachable in
practice. The ladder would exist with nothing able to climb it.

VISION §7 pins one side of the trade by name: quarantine decisions are "probably never"
promoted. That sentence is only expressible if quarantine is its own class, so the
taxonomy cannot be coarse enough to fold quarantine in with its neighbours.

A second question rides along. The taxonomy is consumed by the decision log (#90), by
every proposer (#92, #109, #110, #111), and later by the trust-grant model (#22, #99). A
Prisma enum, a TypeScript union, and a table in the docs would each drift from the other
two, and the drift would show up as an approval rate computed over a class that no longer
means what the grant thinks it means.

## Decision

An action class is one **(capability, effect) pair**: what the supervisor is proposing to
do, paired with what would change if a human said yes.

The taxonomy lives in exactly one place — `apps/api/src/supervisor/action-classes.ts` —
as a frozen registry. Each entry declares four things:

- `id`, the partition key, in `kebab-case`
- `definition`, a sentence describing what a proposal of this class actually asks for.
  Not a category label: "re-dispatch this work order as a new attempt after a failure
  whose cause was transient" rather than "re-dispatch".
- `reversibility`, per VISION §3.5, one of `reversible`, `reversible-with-effort`, or
  `irreversible`
- `autonomyEligible`, a boolean carrying VISION §7's judgement in the registry rather
  than in someone's memory. `quarantine-decision` is `false`.

The Prisma column storing a class is a plain `String`, validated against the registry at
the boundary. This is the shape `RunnerNeed` already uses, for the reason ADR-0010 gives:
widening a closed union must not require a migration on a table that holds authorisation
records. `isActionClass()` is the boundary check, and `ACTION_CLASS_IDS` is what
validation, the API contract, and the future trust model all read.

The seven classes are `run-diagnosis`, `re-dispatch`, `decomposition`, `issue-shaping`,
`spec-quality-feedback`, `daily-brief`, and `quarantine-decision`.

## Consequences

Each grant is exactly as wide as the evidence behind it. Promoting `re-dispatch` does not
quietly authorise `decomposition`, even though both end in a work order existing, because
they are separate bins from the first proposal onward.

The cost is real and lands on the measurement, not on the code: seven bins fill more
slowly than three would. Two classes are expected to stay sparse. `re-dispatch` has no
proposer in Phase 6 at all — the deterministic retry path already handles it, and #91's
taxonomy names the class so the ladder has somewhere to put evidence if a proposer is
built later. `quarantine-decision` is ineligible by declaration, so its sample count never
matters. That leaves five classes with producers, which is the number that has to reach
significance in the observation window.

Declaring `autonomyEligible: false` in the registry means an ineligible class cannot be
promoted by an oversight in the promotion code — the check reads the same registry the
proposal was written against. It does not, on its own, prevent execution; #90 handles that
structurally by giving the supervisor module no executor to reach.

The deciding argument: **the class is the unit of authority, so it must be no wider than
the narrowest thing a grant of it would permit.** If the promotion ladder ever grants
per-proposal rather than per-class, that argument expires and this is worth revisiting.

## Alternatives considered

**One class per advisory-column row in VISION §7's table.** Six classes, mapping directly
to the vision doc and to the proposers being built, so no class would sit at zero samples
by construction. Disqualified because that table describes _judgement work_, not
_authority_: "failure diagnosis and root-cause narration" changes nothing at all, while
"decomposition of oversized work orders" creates issues. Promoting both on the same kind
of evidence is precisely the bulk grant VISION §7 forbids.

**Classify by effect alone** — what the action changes: nothing, a label, an issue, a work
order, a run. Reversibility would become a property of the class rather than of the
instance, which is attractive. Disqualified because several proposers collapse into one
class, so its approval rate mixes capabilities that fail for unrelated reasons, and the
mixing is invisible in the resulting number. A class at 70% could be one capability at 95%
and another at 20%, and promotion would grant both.

**Free-form class strings, taxonomy by convention.** Zero upfront cost. Disqualified
because the partition key becomes a typo surface: a misspelled class silently opens a new
bin with one sample in it, and nothing fails. That is the failure mode that stays hidden
until the moment promotion depends on it.

**A Prisma enum instead of a registry module.** Database-level rejection of an unknown
class is genuinely stronger than a boundary check. Disqualified by ADR-0010: an enum
addition is a MAJOR schema bump, and adding an action class as the supervisor grows is an
ordinary event, not a breaking one. The registry keeps the same closed-union guarantee in
the type system without putting a migration in front of every new class.
