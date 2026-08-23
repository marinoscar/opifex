# 6. Provenance lives in git commit trailers, and carries identity only

- Status: Accepted
- Date: 2026-08-22
- Issue: #26
- Epic: #13

## Context

VISION §5 requires that any line of code be traceable back to the decision that
caused it, along this chain:

```
Decision --informed--> Issue --generated--> WorkOrder --produced--> PR --contains--> Commit
```

and calls the vocabulary that carries it _"the single cheapest high-leverage
decision in this project."_ The leverage is entirely in the timing. There are
currently a few dozen commits in this repository. Deciding the vocabulary now
costs an afternoon; deciding it after a thousand agent-authored commits means
either rewriting history or accepting a permanent gap between the old commits
and the new ones.

Something has to hold the `Commit -> WorkOrder -> Issue -> Decision` edges, and
it has to survive clone, fetch, rebase onto another branch, and the deletion of
every row in our database.

## Decision

**Git commit trailers**, specified in `docs/PROVENANCE.md`.

**They carry identity only** — `Work-Order:`, `Issue:`, `Decision:`, `Runner:`,
`Run-Id:`, `Attempt:` — and never measurements.

## Consequences

**The provenance travels with the code, not with us.** A commit trailer is part
of the commit object. It survives `git clone`, it appears in `git log` with no
tooling, and it is still there if Opifex is deleted tomorrow. Every alternative
below fails at least one of those.

**Immutability is the point, and it is also the constraint.** A trailer cannot
be corrected. That makes it exactly right for an identifier — an identifier
that changes was never an identifier — and exactly wrong for anything that
might turn out to be measured incorrectly. Hence identity only. Cost, duration,
token counts and what the run actually did live in `run_events` and the
run-summary PR comment (#67), where a wrong number can be fixed. A cost trailer
would bake the first version of our cost accounting into history permanently.

**Adding a trailer needs a reason of a specific shape.** The rule is that a
trailer completes an edge of the graph above. Anything else is metadata, and
this is a place metadata can never be removed from. `Attempt:` is the one
deliberate redundancy — it duplicates the `_a{n}` suffix already inside
`Work-Order:` — and it earns its place because success metric 4 is
attempts-per-work-order, and a metric requiring a string to be parsed before it
can be computed is a metric nobody computes.

**`Runner:` becomes the definition of "agent-authored."** A checker decides
which rules apply by its presence, so it must never appear on a human commit.
That gives a clean, mechanical answer to a question that would otherwise need a
username allowlist — which would break the first time somebody's account was
renamed.

**Only `Issue:` is universal.** A human PR carries `Issue:` and possibly
`Decision:`, and nothing else — a human commit has no work order, no runner and
no run, and demanding those fields would mean inventing them. An invented
`Run-Id` is worse than an absent one, because it resolves to nothing while
looking like it resolves to something. The premise of §5 is that the chain is
honest, not that every row is full.

**Squash merges are where a hole will appear.** Trailers of squashed commits do
not survive the squash. A repository that squash-merges factory PRs must carry
the work order's trailers into the squash message, and enforcing that belongs
at the merge rather than at the commit. This is the most likely way a
repository doing everything else right ends up with an untraceable commit, and
it is called out in `PROVENANCE.md` for that reason.

**A PROV-O mapping stays available and is not taken.** `Decision` maps to
`prov:Entity`, `WorkOrder` to `prov:Activity`, the runner to `prov:Agent`. The
vocabulary was chosen so that mapping is mechanical later. Publishing RDF now
would be building for a consumer that does not exist; choosing names that
_cannot_ be mapped would be a decision made by accident.

## Alternatives considered

**Structured data in the commit body, rather than trailers.** A fenced JSON
block would carry more and nest. It also breaks `git log --oneline`, defeats
`git interpret-trailers`, and every tool that understands trailers — GitHub's
`Co-authored-by`, gerrit's `Change-Id`, the kernel's `Signed-off-by` — would
see nothing. Trailers are a convention with an ecosystem; a JSON body is a
convention with a parser we would own.

**GitHub-side metadata: labels, issue links, PR body fields.** Easiest to write
and query, and it lives on GitHub rather than in the repository. A clone would
carry no provenance at all, and the chain would depend on one vendor's API
staying available and unchanged. The mirror labels (#48) are already deliberately
_derived_ state for exactly this reason; provenance is the opposite — it is the
source.

**`git notes`.** Mutable, which sounds like an advantage and is the
disqualifier: provenance that can be edited after the fact proves nothing.
Notes also do not transfer on clone or push without explicit refspec
configuration, so in practice most people would never see them.

**A sidecar file committed alongside the change.** The execution record
(ADR 0005) is exactly this, and it is complementary rather than an alternative:
it carries the _whole work order_ at the branch's first commit. It cannot
replace trailers, because it says what the branch was for, not what each
individual commit belongs to — and a commit cherry-picked to another branch
would leave its sidecar behind while carrying its trailers with it.
