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

| # | Decision | Status | Issue |
|---|---|---|---|
| [0001](0001-github-authentication.md) | Authenticate to GitHub with a fine-grained personal access token | Accepted | [#40](https://github.com/marinoscar/opifex/issues/40) |
| [0002](0002-github-http-client.md) | Call GitHub with the platform `fetch`, not an SDK | Accepted | [#40](https://github.com/marinoscar/opifex/issues/40) |
| [0003](0003-observability-backend.md) | Uptrace is the observability backend; Grafana is not deployed | Accepted | [#59](https://github.com/marinoscar/opifex/issues/59) |
| [0004](0004-notification-transport.md) | Web Push for notifications, with a configurable webhook as the second path | Accepted | [#58](https://github.com/marinoscar/opifex/issues/58) |
| [0005](0005-execution-record-authorship.md) | The control plane creates the factory branch and its first commit | Accepted | [#63](https://github.com/marinoscar/opifex/issues/63) |
| [0006](0006-provenance-in-commit-trailers.md) | Provenance lives in git commit trailers, and carries identity only | Accepted | [#26](https://github.com/marinoscar/opifex/issues/26) |
| [0007](0007-preview-runner-acknowledgement.md) | A single-runner fleet may be load-bearing only by explicit operator acknowledgement | Accepted | [#147](https://github.com/marinoscar/opifex/issues/147) |
| [0008](0008-claude-code-local-invocation.md) | Invoke `claude-code-local` as a subprocess, not through the Agent SDK | Accepted | [#61](https://github.com/marinoscar/opifex/issues/61) |
| [0009](0009-record-architecture-decisions.md) | Record architecture decisions in this directory, proposed by anyone and merged by a human | Accepted | [#25](https://github.com/marinoscar/opifex/issues/25) |

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

| Status | Meaning |
|---|---|
| `Proposed` | The ADR's pull request is open. The decision is not in force. |
| `Accepted` | Merged. This is the current answer. |
| `Superseded by ADR-NNNN` | A later decision replaced it. The file stays. |

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

1. **Open a discussion issue first.** VISION §5 gives decision discussion its
   own row in the artifact table — the issue is where options get argued, the
   ADR is where the outcome lands. A dedicated issue form and the convention
   that the ADR's PR closes its discussion issue are [#114](https://github.com/marinoscar/opifex/issues/114);
   until that lands, an ordinary issue and a closing keyword do the same job.
2. Copy `0000-template.md` to `NNNN-short-slug.md` with the next free number.
3. Fill in every section. `Alternatives considered` is not optional — an
   alternative dismissed without a stated reason gets relitigated.
4. Open the PR with `Status: Proposed`, flip it to `Accepted` in the same PR
   once the discussion has settled, and add the row to the index above.
5. Reference it from the work that implements it with a `Decision: ADR-NNNN`
   commit trailer. See [`../PROVENANCE.md`](../PROVENANCE.md) for the trailer
   vocabulary; `scripts/check-provenance.mjs` fails CI on a trailer that names
   no file here.

## Who may write one

**Anyone may propose; a human merges.** This is VISION §13's open question —
*may agents author ADRs?* — and its recorded answer. The reasoning, and what
would cause it to be revisited, is in [ADR-0009](0009-record-architecture-decisions.md).
