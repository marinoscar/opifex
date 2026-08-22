# Provenance: the commit trailer vocabulary

VISION §5 calls this **"the single cheapest high-leverage decision in this
project"**, and the reason is timing rather than cleverness: designing the
vocabulary *before* there is history to migrate costs nothing, and retrofitting
it costs everything. A commit written today without a `Work-Order:` trailer
cannot be given one later without rewriting history.

This document is the specification. It is written to be precise enough that the
CI check in #28 can be built from it alone, with no reference to the code that
emits the trailers.

## The graph, which is why the vocabulary is shaped this way

Trailers exist to make one traversal possible, in both directions, using
nothing but `git log` and the GitHub API:

```
Decision --informed--> Issue --generated--> WorkOrder --produced--> PR --contains--> Commit
```

Read left to right it answers *"what came of that ADR?"* Read right to left it
answers the question that actually matters at 2am: **"why does this line of
code exist, and who decided it should?"**

Every trailer below exists to carry exactly one edge of that chain. That is the
test for adding a new one: if it does not complete an edge, it is metadata, and
metadata belongs in the run record rather than in history that can never be
rewritten.

The shape is deliberately close to [PROV-O](https://www.w3.org/TR/prov-o/) —
`Decision` as `prov:Entity`, `WorkOrder` as `prov:Activity`, the runner as
`prov:Agent`. Nothing here commits to publishing RDF, and nothing should. The
point is that the option stays open, because a vocabulary that *cannot* be
mapped later is a decision made by accident.

## Format

Trailers follow [git's own trailer convention](https://git-scm.com/docs/git-interpret-trailers):
a block at the end of the commit message, separated from the body by one blank
line, each entry `Key: value` on its own line.

```
feat(api): add the widget listing endpoint

Adds a paginated GET /api/widgets behind the existing auth guard.

Work-Order: wo_opifex_312_a3f91c2_a1
Issue: #312
Decision: ADR-0042
Runner: claude-code-local@2.1.223
Run-Id: 018f2c31-7a4e-7c3b-9f21-4d5e6a7b8c9d
Attempt: 1
```

Rules that a checker can apply mechanically:

- The trailer block is the **last** block of the message.
- Keys are `Kebab-Case-Capitalised` exactly as spelled below. Matching is
  case-sensitive: `work-order:` does not count.
- One space after the colon. No leading whitespace.
- A key appears **at most once**. Two `Issue:` trailers is an error, not a list
  — see *Multiple issues* below.
- Unknown keys are permitted and ignored. Forbidding them would make the
  vocabulary impossible to extend without a flag day.

## The trailers

### `Work-Order:` — the WorkOrder node

| | |
|---|---|
| **Format** | `wo_{repo}_{issue}_{commit7}_a{attempt}`, matching `^wo_[a-z0-9-]+_\d+_[0-9a-f]{7}_a\d+$` |
| **Referent** | The work order's deterministic identity (#62). Resolves to a `work_orders` row and to the execution record at `.opifex/work-order.json` on the branch. |
| **Required** | Agent-authored commits only. |

The identity is content-addressed and stable, so this trailer keeps pointing at
the right thing even if the row is deleted — the string itself names the repo,
issue, base commit and attempt.

### `Issue:` — the Issue node

| | |
|---|---|
| **Format** | `#{number}` for the same repository, matching `^#\d+$`. Cross-repository: `{owner}/{repo}#{number}`. |
| **Referent** | The GitHub issue the work was authorized by. |
| **Required** | **Always** — agent and human alike. |

This is the one trailer with no exceptions. VISION §5: *"a single orphan puts a
hole in the graph, and holes are not detectable after the fact."* A commit with
no `Issue:` cannot be connected to a reason by any later effort.

### `Decision:` — the Decision node

| | |
|---|---|
| **Format** | `ADR-{4 digits}`, matching `^ADR-\d{4}$` |
| **Referent** | A file under `docs/adr/`. `ADR-0005` is `docs/adr/0005-*.md`. |
| **Required** | Optional. Present when the work implements or is constrained by a recorded decision. |

Optional because most commits implement no ADR, and a vocabulary that demanded
one would be satisfied with a fictional value within a week.

### `Runner:` — the Agent node

| | |
|---|---|
| **Format** | `{runner-key}@{version}`, matching `^[a-z0-9-]+@\S+$` |
| **Referent** | A `runners` row by `key`, at the version that produced the commit. |
| **Required** | Agent-authored commits only. Never present on human-authored ones. |

The version is part of the value rather than a separate trailer because the
question is always *"which runner, at which version, produced this?"* — and a
version that can go missing independently is a version that will.

**This trailer is the machine-readable definition of "agent-authored."** A
checker deciding which rules to apply keys off its presence, which is why it
must never appear on a human commit.

### `Run-Id:` — the execution

| | |
|---|---|
| **Format** | A UUID, matching `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$` |
| **Referent** | A `runs` row. |
| **Required** | Agent-authored commits only. |

Distinct from `Work-Order:` in exactly the way #60 established: the work order
identity names the **work** and survives a kill-and-re-run; the run id names
**one attempt at it**. Two commits with the same `Work-Order:` and different
`Run-Id:` are the signature of a run that was killed and re-run — which is a
thing an operator will want to search for.

### `Attempt:` — which attempt

| | |
|---|---|
| **Format** | A positive integer, matching `^[1-9]\d*$` |
| **Referent** | Nothing on its own. It is redundant with the `_a{n}` suffix of `Work-Order:`. |
| **Required** | Agent-authored commits only. |

Redundant on purpose. It is the input to success metric 4 (attempts per work
order), which VISION §13 uses to answer its own open question about how small a
work order should be — and a metric that requires parsing a composite string to
compute is a metric nobody computes. **If the two ever disagree, `Work-Order:`
is authoritative**, because it is the value everything else resolves through.

## Required by authorship

| Trailer | Agent-authored | Human-authored |
|---|---|---|
| `Issue:` | **required** | **required** |
| `Work-Order:` | **required** | must be absent |
| `Runner:` | **required** | must be absent |
| `Run-Id:` | **required** | must be absent |
| `Attempt:` | **required** | must be absent |
| `Decision:` | optional | optional |

A human PR legitimately carries only `Issue:` — and possibly `Decision:`. That
is not a lesser standard; a human commit has no work order, no runner and no
run, so demanding those fields would mean inventing them, and an invented
`Run-Id` is worse than an absent one. VISION §5's premise is that the chain is
*honest*, not that it is *full*.

**The five agent trailers are all-or-nothing.** A commit carrying `Runner:` and
no `Run-Id:` is malformed, not partially compliant: it claims to be
agent-authored and then cannot say which execution produced it.

## Cases a checker has to handle

**Merge commits.** Exempt. A merge commit is authored by whoever pressed the
button and its message is generated by GitHub; requiring trailers there would
mean either rewriting merge messages or failing every merge.

**Revert commits.** Treated as human-authored unless they carry `Runner:`. A
revert undoes work; it is not that work. It should carry the `Issue:` of the
problem it fixes, not of the work it reverts.

**Commits Opifex writes that are not a run's output.** The execution record
(ADR 0005) is written by the control plane before any runner touches the
branch. It carries `Work-Order:`, `Issue:`, `Attempt:` and, once routing has
chosen one, `Runner:` and `Run-Id:` — because by the time the branch is
created the runner and the run row both exist (#60). It is agent-authored in
every sense that matters here.

**Multiple issues.** One `Issue:` per commit, always. A commit that genuinely
serves two issues is a commit that should have been two commits — and CLAUDE.md
already requires one intent per commit. Making the trailer a list would make
the graph a many-to-many and the traversal ambiguous, to serve a case the
commit rules forbid anyway.

**Squash merges.** The trailers of the squashed commits do not survive. The
squash message must carry the trailers of the work, which for a factory PR
means the work order's. Repositories that squash-merge factory PRs need this
enforced at the merge, not at the commit — noted here because it is the most
likely way a hole appears in a repository that is otherwise doing everything
right.

## What this is not

Not an audit log. The trailers carry **identity**, never content: no cost, no
token counts, no timing, no summary of what the run did. All of that lives in
`run_events` and in the run-summary PR comment (#67), where it can be corrected
if it turns out to be wrong.

Anything written into a commit message is immutable. That is exactly what makes
it the right home for an identifier and the wrong home for a measurement.
