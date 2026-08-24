# 14. Approval timeouts resolve by a total order, and the grant is what delivers autonomy

- Status: Proposed
- Date: 2026-08-24
- Issue: #234
- Epic: #22

## Context

VISION §8 gives the timeout policy as three rules: reversible → auto-approve on timeout,
logged; irreversible → park and escalate, never auto-approve; spends money → deny on
timeout.

Those three are not a partition, and it matters because the timeout is what happens when
nobody answers — the common case at 2am, the exact scenario VISION §8 is written about.
It is the _default_ behaviour of the whole approval system, not an edge case.

**They overlap.** `re-dispatch` is `reversible-with-effort` and `spendsMoney: true`. So
are `decomposition` and `issue-shaping`. Every autonomy-eligible class with a real effect
matches at least two rules.

**They do not cover the taxonomy.** ADR-0011 gave the registry three reversibility
values — `reversible`, `reversible-with-effort`, `irreversible`. VISION names only the
first and last. The middle band, where most of the registry sits, has no rule at all.

Issue #97 is explicit that the engine must "consume the existing reversibility
classification rather than defining a second one", so the answer cannot be a new axis —
it has to be a precedence over the axes that already exist. VISION §3.5's argument, that
sorting by reversibility rather than significance "reduces interruption volume by roughly
an order of magnitude without reducing safety," only holds if one classification is used
consistently.

## Decision

A **total order**, evaluated top-down, first match wins:

0. A never-trustable effect (ADR-0013) → refused outright, before the gate is consulted.
   Not a timeout outcome; listed so the order is complete.
1. `irreversible` → **park and escalate.** Never auto-approved, under any grant or any
   timeout.
2. `spendsMoney` → **deny on timeout.**
3. `reversible-with-effort` → **deny on timeout.**
4. `reversible` → **auto-approve on timeout**, recorded.

Two things need arguing properly.

**Why irreversibility ranks above spend.** Neither branch executes anything, so the
safety property is identical either way — only the _disposition_ differs:
escalate-and-keep-open versus deny-and-close. VISION §8 attaches escalation to the
irreversible case by name, and denying an irreversible action would close it silently,
meaning nobody is told about the case most worth telling them about. The alternative
ordering is defensible on the grounds that money is the one consequence that cannot be
undone by a later action, only compensated — say so, then say why it loses: below.

**Why rule 3 exists at all.** This is the addition VISION does not make, so it needs the
most argument. "Reversible with effort" means somebody pays in labour to undo it. Denying
costs a re-ask; auto-approving costs cleanup, and the operator can always approve
explicitly afterwards. VISION §8's auto-approve rule says "reversible", full stop —
reading the middle band into that bucket widens a rule the vision wrote narrowly, and the
widening would be invisible because it shows up only in what happened overnight.

## Consequences

### The trust grant, not the timeout, is what delivers autonomy

Under this order, **every autonomy-eligible class with a real effect denies on timeout**,
because `re-dispatch`, `decomposition`, and `issue-shaping` are all `spendsMoney: true`.
Auto-approve-on-timeout applies only to `run-diagnosis`, `spec-quality-feedback`, and
`daily-brief` — the three that change nothing outside the decision log.

So the timeout is **not** the autonomy mechanism. The **trust grant** is. The gate exists
mostly to be _bypassed_ by a valid grant, and a reader of issue #97 alone would reasonably
expect the opposite. This deserves its own subsection because it is the thing most likely
to be misread six months from now: someone will otherwise "fix" the timeout policy to
make autonomy work, undoing the safety property instead of creating a grant.

An auto-approval on timeout still records what would have been asked, per VISION §8's
digest ("auto-approved actions still record what _would_ have been asked"). Skipping that
record would leave #99's promotion ladder and #100's digest each measuring a partial
picture: the ladder needs the would-have-been-asked record to compute an approval rate for
the auto-approved classes, and the digest needs it to report what ran without a human
looking. Both silently underrepresent the same three classes if the record is skipped.

The safety argument. `irreversible → park` never yields to a grant, because rule 1 is
checked before the grant is consulted at all — a grant scopes _which_ classes are
eligible for auto-approval, per VISION §8's "Scope — action class × repository," and
`irreversible` classes are never in that set to begin with. So the total order is not
weakened by the existence of grants; it is the thing a grant operates inside of.

## Alternatives considered

**Spend above irreversibility.** Loses on the escalation argument above: an irreversible
action denied on timeout closes silently, and the case most worth surfacing gets no
signal at all. Money not spent because of a timeout is recoverable by asking again
tomorrow; an irreversible action nobody was told about is not recoverable by anything.

**Collapse `reversible-with-effort` into `irreversible` and drop the spend rule.**
Simpler, maximally conservative. Loses because it re-derives the classification #97
forbids re-deriving, discards a distinction ADR-0011 spent a decision establishing, and
makes the gate park on essentially everything — the stall VISION §8 names: "an agent
parked awaiting an answer while its operator sleeps is exactly the dead time this project
exists to eliminate."

**Per-class configurable timeouts.** Loses because a safety default that can be set per
class is a policy, not a guarantee, and the per-class knob is exactly what a tired
operator turns at 2am — the same friction argument VISION §8 makes about blanket trust.
