# 10. Schemas are versioned per major, strict, and the producer emits what the consumer speaks

- Status: Accepted
- Date: 2026-08-23
- Issue: #34
- Epic: #14

## Context

The three contracts — work order, runner capability manifest, run event — are the
seam VISION §6 says the whole system is built on: _"the data contract, not an
interface."_ They exist and validate their examples (#31, #32, #33, #36). What
does not exist is any statement of what happens when one of them changes.

Three properties of the schemas as written make that urgent, and they interact
badly.

**`schemaVersion` was `const: "1.0.0"`.** Not a range — a single accepted value.
The moment any schema moved to 1.1.0, every document already written would fail
validation against it, and every new document would fail against anything still
holding 1.0.0. There was no version in which both a producer and a consumer could
operate during a rollout. The field looked like a compatibility mechanism and was
the opposite of one.

**All three set `unevaluatedProperties: false`.** This is right — a typo in a
runner's event payload should be a loud failure, not a silently dropped field —
and it is the keyword doing most of the work in all three files. But it also
means **an added optional field is a breaking change to any consumer pinned at the
older version**. A runner validating an incoming work order against its own copy
of 1.0.0 rejects a 1.1.0 document over a field it does not recognise, even though
that field is optional and it could have ignored it. The usual reassurance —
"additive changes are backwards compatible" — is simply false under strict
validation, and stating it without saying so would have been the kind of policy
that holds until the first time anyone relies on it.

**VISION §3.4's recovery model is abandon-and-re-run from the pinned base
commit.** A work order can be re-run long after it was written; #34 names this as
the rule that matters most. So "old documents stay readable" is not a courtesy to
external integrators, it is a requirement of the control plane's own recovery
path.

There is also nowhere for a runner to say what it speaks. The manifest declares
invocation model, streaming fidelity and cost reporting, but not which versions of
the two contracts it can actually read and write — so the control plane has no
basis for choosing what to send it other than assuming.

## Decision

**Versions are semver, and every document carries one.** `schemaVersion` on the
document itself, never inferred from a URL or a header, because a work order
persisted in an issue comment has neither.

**One schema file per major. It describes the newest minor and accepts the whole
major.** `schemaVersion` becomes `"pattern": "^1\\.\\d+\\.\\d+$"` with
`"default"` naming the current version — the one a producer should write. A 2.x
document is rejected by the 1.x file; majors get their own file and the old file
**stays in the repository forever**, so a work order persisted at 1.0.0 still has
a validator after the contract has moved to 3.0.0. That is what makes re-running
an old order possible, and it costs one file per major.

**Minor is additive-only, and additive means exactly one thing: a new optional
property.** Everything else is major. In particular a **new enum value is a major
change**, because consumers switch on those: a seventh run-event type, an eighth
`invocationModel`, a new `stabilityTier` all break every reader that handled the
closed set exhaustively. This is the rule that settles arguments, so it is stated
as a list rather than a principle:

| Change                                                          | Bump      |
| --------------------------------------------------------------- | --------- |
| Add an optional property                                        | minor     |
| Add a required property                                         | **major** |
| Remove or rename any property                                   | **major** |
| Make an optional property required                              | **major** |
| Add a value to any enum                                         | **major** |
| Narrow a type, pattern, or range                                | **major** |
| Widen a type, pattern, or range                                 | **major** |
| Change what an existing field means, without changing its shape | **major** |
| Change a description, `$comment`, or example                    | patch     |

Widening is major rather than minor on purpose. It is safe for the consumer that
receives the document and unsafe for every other consumer of the same data — a
field that could not previously be null and now can breaks readers that never
checked.

**The producer emits at a version the consumer declares it speaks.** This is the
part that makes strictness and evolution coexist. The capability manifest gains an
optional `speaksSchemaVersions`, naming the work-order versions the runner
consumes and the run-event versions it emits. The control plane sends the highest
work-order version the runner claims, not the highest it has. Absent, it means
"the newest 1.x the control plane has" — correct for a runner that ships with
Opifex and moves with it, wrong for an independent one, which should say so.

**The control plane is the version authority.** It ships the schemas, so it is
never behind a runner. A runner declaring a version the control plane does not
have is a misconfiguration, refused at registration rather than at dispatch.

**Retiring a major** is allowed only when nothing persisted still declares it —
which is a query, not a judgement call. Until then the file stays.

## Consequences

**`speaksSchemaVersions` is optional in 1.1.0, and this is a compromise.** #34
asks that runners declare their versions; a field they may omit declares nothing.
Making it required would have been a major bump — the first application of the
table above, on the day it was written — and its only benefit today would be
enforcing a declaration against the one runner that ships in this repository and
already moves in lockstep. So it is optional now with a defined meaning when
absent, and the honest statement is that it becomes **required at 2.0.0**, when
there is an independent runner for the requirement to bite on.

**Every consumer must validate against the version it speaks, not the newest.**
This falls directly out of strictness, and it is the sharpest edge of this
decision: a consumer that upgrades its schema copy without upgrading its
declaration will reject documents it asked for. The mitigation is that the
declaration and the copy live in the same manifest, so they move together or the
mismatch is visible.

**Widening is major, so the schemas will accumulate majors faster than most
projects.** That is the intended trade: a major is one more file, and a wrong
"this is only additive" call is a runner silently dropping data. The cost is paid
in files, which are cheap, rather than in trust, which is not.

**`default` now carries meaning that JSON Schema does not enforce.** Nothing makes
a producer write the default, so the current version is pinned by tests instead —
`run-event.types.spec.ts` asserts the constant this code emits equals the schema's
`default`. A schema bumped without the code following fails there.

**None of this is retroactive.** Every existing document is 1.0.0, every schema
accepts 1.x, and the first real exercise of the policy is `runner-capability`
going to 1.1.0 in this change — whose 1.0.0 examples still validate, which is the
property the whole policy exists to provide and is asserted as a test rather than
claimed here.

## Alternatives considered

**Loosen `unevaluatedProperties` and be a tolerant reader.** Postel's law, and it
makes additive changes genuinely free: unknown fields are ignored, old consumers
survive new producers, and no version negotiation is needed. It is the standard
answer and it was rejected for a specific reason — the manifest's own description
says an overstated capability produces _"a healthy-looking run that nobody is
really watching."_ A tolerant reader turns `reportsCost: ture` into a runner that
reports no cost, silently, forever. The strictness is not incidental; it is what
makes the manifests trustworthy, and trading it for cheaper evolution would trade
the property the contracts exist for.

**Version by `$id` URL and negotiate over the wire.** Conventional for HTTP APIs
and genuinely better where every exchange is a live request. Most of these
documents are not: a work order lives in an issue comment, an execution record
lives in a commit. A version that lives in the transport cannot survive being
written down, and these are written down by design.

**Keep `const` and give every version its own file, including minors.** Maximum
precision — each file describes exactly one version and nothing else, and old
documents always have their exact validator. It also means a consumer must hold
every file it might ever encounter, and a minor bump becomes a distribution event
for everyone rather than a no-op for anyone who does not care. The major-only
split keeps the strong guarantee where it matters and drops the ceremony where it
does not.

**No policy; decide each change when it comes up.** Defensible while there is one
runner and no external consumers, and it is what was in force until now. It fails
at exactly the moment it is most expensive: the first disagreement about whether a
change is breaking happens when someone has already shipped it, and the argument
is then about blame rather than about the change. Writing the table down while
nothing is at stake is the cheapest this decision will ever be.
