# 5. The control plane creates the factory branch and its first commit

- Status: Accepted
- Date: 2026-08-22
- Issue: #63
- Epic: #18

## Context

VISION §4 says a work order is recorded twice, in two places, for two reasons:

> The work order is posted to the issue as a fenced JSON comment (the
> *authorization record*) and committed to the branch as its first commit (the
> *execution record*).

#63 states what the pair buys:

> The authorization record proves what was approved. The execution record
> proves what the runner was actually given. Keeping both is what makes "the
> agent did something I did not ask for" a checkable claim rather than an
> argument.

It does not say **who writes the second one**, and #63 makes that an explicit
decision to record before implementing:

> VISION §4 and §6 can be read either way, and the two answers put the git
> credential in different components.

§4 describes the record as something that exists on the branch, which reads
like the control plane put it there. §6 describes a runner as the thing that
turns a repository at a commit into a branch, which reads like the runner
creates the branch and everything on it.

## Decision

**The control plane creates the factory branch and writes the execution record
as its first commit, at dispatch, before calling `submit`.**

The execution record lives at **`.opifex/work-order.json`** — a fixed path, so
it can be read back without searching — and its bytes are the *same
serialization* posted to the issue as the authorization record.

The runner receives a branch that already exists with exactly one commit on it.
It must not amend, rebase or force-push that commit.

## Consequences

**A record the subject writes about itself is not evidence.** This is the
argument that decided it. VISION §8 is explicit that the runner is never
trustable, and the execution record's stated job is to prove *what the runner
was given*. If the runner writes it, a misbehaving runner writes a record
matching whatever it actually did, and the comparison against the
authorization record catches accidents but never misbehaviour. Written by the
control plane, the record is testimony from the party that is not the subject.

**"Verifiably identical in content" becomes structural rather than aspirational.**
#63 requires the two records match. With one component serializing once and
writing the bytes to two destinations, they cannot drift. With two components
serializing independently, byte-identity is a property somebody has to keep
testing forever, and JSON key order alone would break it.

**First-commit ordering can actually be guaranteed.** The record must be the
branch's *first* commit. If the runner creates the branch, nothing stops it
committing work before writing the record, and there is no way to repair that
afterwards without rewriting history — which is the one thing a factory branch
must never need. Creating the ref ourselves makes "first" true by construction.

**The runner's idempotency check gets better, not worse.** The obvious
objection: VISION §4 says *"a runner checks whether its branch already exists
before doing anything"*, and under this decision the branch always exists, so
that check degenerates.

The replacement is strictly more informative. The execution-record commit has a
known SHA, handed to the runner. The check becomes:

| Branch HEAD | Means |
|---|---|
| equals the execution-record SHA | Dispatched, nothing done yet. Start work. |
| ahead of it | A previous run already did work. Do not start over. |
| branch missing | Dispatch did not complete. Refuse; the control plane will retry. |

"Does the branch exist" cannot distinguish the first two. That distinction is
exactly what a kill-and-re-run needs in order to avoid discarding work a dead
runner had already pushed.

**A failed `submit` leaves an orphan branch, and that is the right trade.**
Ordering is: create branch and execution record → `submit`. If `submit` throws
(no capacity, runner down), a factory branch exists carrying one commit and no
work. That is honest — it says "this was authorized and dispatch did not
complete" — it is cheap, and the reconciler recognises it on the next tick as
the third row of the table above. The alternative ordering, submitting first
and writing the record after, reintroduces the race the first-commit guarantee
exists to close.

**The credential moves, but less than it appears.** The runner needs push
access to `factory/*` regardless — it has to push its work. What changes is
that the control plane additionally needs ref-creation and commit-creation
(`contents: write`), used through the GitHub Git Data API with no local clone.
It already holds a GitHub credential and already writes labels, so this widens
an existing grant rather than creating a new one. Both remain behind
`GITHUB_WRITES_ENABLED`, so during VISION §12's observation week no branch is
ever created.

**The runner adapter fetches rather than branches.** A runner working from a
local clone must fetch the existing factory branch instead of branching from
the base commit itself. Marginally more work in the adapter, and it means an
adapter cannot operate fully offline from a stale clone. Acceptable: a runner
that cannot reach GitHub cannot push its results either.

**Dispatch costs four extra API calls per work order** — blob, tree, commit,
ref — once, at dispatch. Against a 5000/hour budget shared with a human
(VISION §11), that is not the constraint.

## Alternatives considered

**The runner creates the branch and the record on first contact.** Fewer calls
from the control plane, and natural for a runner that already has a clone. The
evidentiary problem is fatal: the record stops being independent testimony.
The ordering problem has no fix. And every new runner adapter would have to
reimplement the record correctly, which is exactly the vendor-specific
behaviour VISION §6 wants kept out of the seam.

**The control plane creates the branch; the runner writes the record.** Splits
the difference and gets the worst of both — the ordering guarantee holds, but
byte-identity does not, and the record is still written by the subject.

**No execution record; rely on the authorization comment alone.** Cheapest, and
it loses the property the pair exists for. An issue comment can be edited or
deleted; a commit in the branch's history cannot, and it travels with the PR to
anyone reviewing it later without leaving git.
