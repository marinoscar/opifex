# 9. Record architecture decisions in this directory, proposed by anyone and merged by a human

- Status: Accepted
- Date: 2026-08-23
- Issue: #25
- Epic: #13

## Context

Eight ADRs already sit in this directory. None of them was written against a
recorded convention: the numbering, the header fields, the lifecycle and the
authorship policy were all inferred from whichever file the author happened to
open first. That worked because there were eight of them and one author.

Two things then went wrong in the space of two days, and both are the same
failure.

**The `Decision:` trailer had nothing authoritative to point at.** ADR-0006
made provenance immutable by putting it in commit trailers, and VISION §5's
vocabulary includes `Decision: ADR-0042`. `docs/PROVENANCE.md` says the
referent is "a file under `docs/adr/`" — but nothing said what a file under
`docs/adr/` *is*, whether its number could change, or what happens to the
trailer if it does. An immutable pointer to a mutable target is not a pointer.

**Two ADRs both claimed 0006.** `Decision: ADR-0006` was ambiguous from the
moment the second one merged, and nothing noticed until the CI provenance check
(#28) was being built and needed the reference to resolve. That is the
diagnostic detail: the collision was not caught by review, it was caught by the
first tool that tried to follow the link. An unwritten convention is not
enforced by anyone, and it is not violated deliberately — it is violated by
someone who never knew it existed, which in this project will routinely be an
agent that read the directory and guessed.

VISION §12 puts conventions in Phase 0 for this reason, and §5 states the goal
the whole vocabulary serves: that "why does this module work this way?" is a
graph traversal rather than an archaeology session. The `Decision` node is the
root of that graph. It is the one node whose contents are prose rather than
identifiers, and the only one a human reads directly.

## Decision

**Architecture decisions are recorded as files in `docs/adr/`**, one file per
decision, numbered with four digits, in the format `0000-template.md`
establishes. `README.md` in this directory holds the index and the operational
rules; this ADR holds the reasoning.

Three rules are load-bearing rather than stylistic:

**Numbers are allocated once, never reused, and never renumbered.** A commit
trailer cannot be corrected (ADR-0006), so the thing it names must not move. A
number collision is the sole exception, and is a repair of an already-broken
reference rather than a renumber.

**`0000` is reserved for the template and resolves to nothing.**
`scripts/check-provenance.mjs` rejects `Decision: ADR-0000` outright. A
placeholder copied out of the template and left in a commit message must fail
loudly, not resolve to a file full of instructions.

**A reversed decision is superseded, never edited into its opposite.** The old
file keeps its number and its argument, its status becomes
`Superseded by ADR-NNNN`, and the new one states what changed. Editing an
accepted ADR to say the reverse destroys the record of what was believed and
why, which is the only durable thing a decision record has.

**Anyone may propose an ADR; a human merges it.** This is VISION §13's open
question — *may agents author ADRs?* — recorded as its current answer rather
than left implicit. It is revisited after three months of evidence, and the
evidence to look at is whether agent-proposed ADRs were *reversed* or *ignored*,
not whether they were well-written.

An ADR is warranted when a choice had real tension — two options that could not
both be true, with a cost either way. A choice with an obvious answer belongs in
a commit message.

## Consequences

**The deciding argument is that the convention already had a victim.** This is
not a hypothetical standard adopted in advance of need; the 0006 collision and
the dangling-referent problem both happened first, and both were caused by
exactly the thing being written down here. That matters for whether this ADR
still applies later: if the repository ever stops referencing decisions from
commit trailers, the immutability rule loses its reason and should be revisited
rather than inherited.

**The provenance check now depends on this directory's shape.** `resolvesToAdr`
in `scripts/check-provenance.mjs` requires that `ADR-NNNN` match exactly one
`docs/adr/NNNN-*.md`. Two files with one number fails; zero files fails. The
convention is enforced mechanically from here on, which is the point — but it
also means a careless rename breaks CI for every commit that referenced the
file, not just the PR doing the renaming.

**The index in `README.md` is maintained by hand and will therefore rot.** A
generated index would not, and was considered below. The honest position is
that a nine-row table costs less to maintain than a generator costs to own, and
that this trade goes the other way somewhere around thirty ADRs. It should be
revisited then rather than defended.

**Propose-only makes the human the throughput limit on decisions, deliberately.**
VISION §3.6 — "the agent proposes; code disposes" — is about mechanical
enforcement, and there is none available here: no linter can tell a sound
architectural argument from a fluent one. An agent that could merge its own ADRs
could also manufacture the justification for its next change and then cite it,
which is the same structural problem VISION §8 names for the runner editing its
own guardrails. The cost is real and is accepted: decisions queue behind a
human's attention, and some will be made implicitly in code because nobody had
time to write the file.

**Requiring a discussion issue adds a step to every decision.** The step is
where the alternatives get argued in the open, and where a decision that turns
out to be uncontroversial gets closed cheaply. The convention that the ADR's PR
closes its discussion issue, and a dedicated issue form for it, are #114.

## Alternatives considered

**Decisions as issues, with a label.** By far the least friction: no file, no
number, no PR, and the discussion and the outcome live in one place. It fails
on durability, which VISION §5 states as the requirement — an issue is not
versioned, does not diff, cannot be reviewed line by line, and does not survive
leaving GitHub. It also fails on reference: `Decision: #312` would point at a
thread whose conclusion is somewhere in the middle of it, and whose title is
usually the question rather than the answer.

**One long `DECISIONS.md`.** Keeps everything in view and removes the numbering
problem entirely. It makes every decision a merge-conflict surface for every
other, gives no stable anchor for a trailer to name, and — the deciding
objection — makes superseding a diff that rewrites history in place, which is
precisely the property being avoided.

**Fold decisions into `VISION.MD`.** VISION states what the system is and why;
ADRs state what was chosen along the way. Merging them means either VISION
grows a changelog of reversals, or reversals get edited in silently and VISION
stops being a description of the current intent. The two documents have
different half-lives, and the split is what lets VISION stay short.

**Adopt `adr-tools` or an equivalent generator.** It would allocate numbers,
generate the index, and make the collision above impossible. It is a dependency,
a shell tool every contributor has to install, and it owns a directory format
that is then awkward to deviate from — and the deviations here are already real
(the `Issue:`/`Epic:` header fields, the `Alternatives considered` section this
repository actually uses). The collision it would have prevented is instead
prevented by the provenance check, which is code this repository already owns
and already runs in CI.

**No ADRs; rely on commit messages.** The commit messages in this repository
are unusually thorough and genuinely carry a lot of this reasoning already. But
a commit message is attached to a change, not to a decision that outlives it: it
cannot be superseded, cannot be found without knowing which commit to look in,
and cannot be pointed at by the work that comes later. `git log` answers "what
happened"; it does not answer "what is true".
