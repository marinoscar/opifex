# Architecture Decision Records

A decision that shaped this codebase lives here as a file. VISION §5 is
explicit about why it is a file and not an issue:

> Decisions are **files, not issues**. An ADR is a durable artifact that should
> be reviewed, versioned, and survive GitHub itself. An issue is a
> conversation. Conflating them loses both properties.

The reasoning behind the practice itself is [ADR-0009](0009-record-architecture-decisions.md).
This file is the operational half: the numbering, the lifecycle, and how to add
one.

## The index

| #                                                         | Decision                                                                                           | Status   | Issue                                                   |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------- |
| [0001](0001-github-authentication.md)                     | Authenticate to GitHub with a fine-grained personal access token                                   | Accepted | [#40](https://github.com/marinoscar/opifex/issues/40)   |
| [0002](0002-github-http-client.md)                        | Call GitHub with the platform `fetch`, not an SDK                                                  | Accepted | [#40](https://github.com/marinoscar/opifex/issues/40)   |
| [0003](0003-observability-backend.md)                     | Uptrace is the observability backend; Grafana is not deployed                                      | Accepted | [#59](https://github.com/marinoscar/opifex/issues/59)   |
| [0004](0004-notification-transport.md)                    | Web Push for notifications, with a configurable webhook as the second path                         | Accepted | [#58](https://github.com/marinoscar/opifex/issues/58)   |
| [0005](0005-execution-record-authorship.md)               | The control plane creates the factory branch and its first commit                                  | Accepted | [#63](https://github.com/marinoscar/opifex/issues/63)   |
| [0006](0006-provenance-in-commit-trailers.md)             | Provenance lives in git commit trailers, and carries identity only                                 | Accepted | [#26](https://github.com/marinoscar/opifex/issues/26)   |
| [0007](0007-preview-runner-acknowledgement.md)            | A single-runner fleet may be load-bearing only by explicit operator acknowledgement                | Accepted | [#147](https://github.com/marinoscar/opifex/issues/147) |
| [0008](0008-claude-code-local-invocation.md)              | Invoke `claude-code-local` as a subprocess, not through the Agent SDK                              | Accepted | [#61](https://github.com/marinoscar/opifex/issues/61)   |
| [0009](0009-record-architecture-decisions.md)             | Record architecture decisions in this directory, proposed by anyone and merged by a human          | Accepted | [#25](https://github.com/marinoscar/opifex/issues/25)   |
| [0010](0010-schema-versioning-and-compatibility.md)       | Schemas are versioned per major, strict, and the producer emits what the consumer speaks           | Accepted | [#34](https://github.com/marinoscar/opifex/issues/34)   |
| [0011](0011-supervisor-action-class-granularity.md)       | Grant autonomy per (capability, effect) pair, from one frozen registry                             | Accepted | [#218](https://github.com/marinoscar/opifex/issues/218) |
| [0012](0012-one-daily-artifact.md)                        | The trust digest extends the daily brief rather than competing with it                             | Accepted | [#226](https://github.com/marinoscar/opifex/issues/226) |
| [0013](0013-never-trustable-effects.md)                   | Never-trustable is a list of effects, checked at the execution boundary                            | Accepted | [#233](https://github.com/marinoscar/opifex/issues/233) |
| [0014](0014-approval-timeout-precedence.md)               | Approval timeouts resolve by a total order, and the grant is what delivers autonomy                | Accepted | [#234](https://github.com/marinoscar/opifex/issues/234) |
| [0015](0015-supervisor-model-http-client.md)              | Call the supervisor's model with the platform `fetch`, on a budget of its own                      | Accepted | [#230](https://github.com/marinoscar/opifex/issues/230) |
| [0016](0016-supervisor-live-run-ceiling.md)               | The live-run ceiling is removed; the quota gate keeps only the parked-run signal                   | Accepted | [#260](https://github.com/marinoscar/opifex/issues/260) |
| [0017](0017-supervisor-spend-ceiling.md)                  | The supervisor gets its own hard spend ceiling, enforced between model calls                       | Accepted | [#261](https://github.com/marinoscar/opifex/issues/261) |
| [0018](0018-operator-settings-resolution-and-ceilings.md) | Operator settings resolve default → env → DB row, and the hard spend ceilings join them            | Accepted | [#354](https://github.com/marinoscar/opifex/issues/354) |
| [0019](0019-fresh-install-ships-ready-not-running.md)     | A fresh install ships ready, not running — five defaults flip on, the hard spend ceiling stays off | Accepted | [#439](https://github.com/marinoscar/opifex/issues/439) |

`0000-template.md` is the template. It is not a decision and never becomes one;
see [Numbering](#numbering) for what that means for `Decision: ADR-0000`.

## Numbering

Four digits, zero-padded, in the filename: `0009-record-architecture-decisions.md`.
The heading inside the file writes the same number unpadded — `# 9.` — which is
how every ADR here is already written.

**Numbers are allocated once and never reused, and an ADR is never renumbered.**
This is the rule that makes `Decision: ADR-0006` mean something: a commit
trailer is immutable (ADR-0006), so the thing it points at has to be immutable
too. Renumbering an ADR silently redirects every trailer that already named it,
and nothing in the repository would report the change.

The one exception is a **collision**, where two files claim the same number and
the reference resolves to neither. That is not a renumber, it is a repair — the
reference was already broken. It happened once, in `65194e1`: two ADRs both
claimed 0006, so `Decision: ADR-0006` was ambiguous from the moment the second
one merged. The later file moved to 0008. Take the next free number by looking
at this directory, not by counting open pull requests, and the case does not
arise.

`0000` is reserved for the template. `Decision: ADR-0000` is rejected by
`scripts/check-provenance.mjs` rather than resolving to a template file, so a
placeholder trailer left in a commit message fails CI instead of looking like a
real decision reference.

## Lifecycle

| Status                   | Meaning                                                       |
| ------------------------ | ------------------------------------------------------------- |
| `Proposed`               | The ADR's pull request is open. The decision is not in force. |
| `Accepted`               | Merged. This is the current answer.                           |
| `Superseded by ADR-NNNN` | A later decision replaced it. The file stays.                 |

**`Status:` does not update itself when a pull request merges.** It is a line
in the file, and flipping it from `Proposed` to `Accepted` is something the
merging PR has to do — see step 5 under [Adding one](#adding-one) below,
which is where "once the discussion has settled" is defined as the trigger.
An ADR already on `main` that still reads `Proposed` is not a decision still
under discussion; it is that edit having been skipped, and the file
disagreeing with its own merge state is a bug to fix on sight, not a signal
about whether the decision is in force. That gap — nothing said what to do
when the flip was missed — is how eight ADRs (#400) sat merged, built on, and
`Proposed` at once, discovered only by rereading every file by hand.

**A reversed decision is superseded, not deleted or rewritten.** Editing an
accepted ADR to say the opposite destroys the record of what was believed and
why, which is the only thing the file is for. Instead:

- The new ADR carries `- Supersedes: ADR-NNNN` in its header and explains, in
  its Context, what changed — usually that the deciding argument in the old one
  expired rather than that it was wrong.
- The old ADR's `Status:` becomes `Superseded by ADR-NNNN`. Nothing else in it
  changes.

Correcting a typo, adding a link, or fixing a broken reference in an accepted
ADR is ordinary editing and needs none of this. The distinction is whether the
decision changed.

ADR-0007 predates this convention and records a partial supersession in an
ad-hoc `Supersedes part of:` line. Partial supersession is real and the header
above does not model it; where it happens, say what is superseded in prose in
the Context section, where a reader will find it.

## Adding one

1. **Open a discussion issue first**, with the **Decision proposal** form. VISION
   §5 gives decision discussion its own row in the artifact table — the issue is
   where options get argued, the ADR is where the outcome lands, and neither
   substitutes for the other.
2. Argue it out on the issue. If it turns out there was no real tension, close the
   issue and put the choice in a commit message; not every decision earns a file.
3. Copy `0000-template.md` to `NNNN-short-slug.md` with the next free number.
4. Fill in every section, and put the discussion issue in the `Issue:` header.
   `Alternatives considered` is not optional — an alternative dismissed without a
   stated reason gets relitigated.
5. **Open the PR with `Closes #N` for the discussion issue** — see
   [Closing the discussion](#closing-the-discussion) below. Start at
   `Status: Proposed`, flip it to `Accepted` in the same PR once the discussion has
   settled, and add the row to the index above.
6. Reference it from the work that implements it with a `Decision: ADR-NNNN`
   commit trailer. See [`../PROVENANCE.md`](../PROVENANCE.md) for the trailer
   vocabulary; `scripts/check-provenance.mjs` fails CI on a trailer that names
   no file here.

## Closing the discussion

**The ADR's pull request closes its discussion issue, and the merged ADR names
that issue in its `Issue:` header.** Both directions, deliberately:

- The **PR → issue** direction is the closing keyword, which is what actually
  ends the conversation at the moment the decision becomes real. An issue left
  open after its ADR merges says the question is still live when it is not.
- The **ADR → issue** direction is the `Issue:` header, which is what survives.
  A closing keyword lives in a PR body on one vendor's servers; the header is in
  the file, in the repository, and still resolves in a clone. `scripts/check-provenance.mjs`
  enforces it: an ADR here with no `Issue:` header fails CI.

Together they make `Decision --informed--> Issue` walkable from either end, which
is the whole point of VISION §5's chain. The trailer `Decision: ADR-NNNN` then
carries it down to the commits that implement the decision.

A decision that never had a discussion issue — because it was settled in review,
or inherited from before this convention — still needs the header. Point it at
the issue the work came from; an `Issue:` naming the nearest real conversation is
worth more than a blank.

## Who may write one

**Anyone may propose; a human merges.** This is VISION §13's open question —
_may agents author ADRs?_ — and its recorded answer. The reasoning, and what
would cause it to be revisited, is in [ADR-0009](0009-record-architecture-decisions.md).
