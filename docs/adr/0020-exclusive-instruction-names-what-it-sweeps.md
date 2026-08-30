# 20. An exclusive instruction names what it sweeps

- Status: Accepted
- Date: 2026-08-30
- Issue: #458
- Epic: #457

## Context

`SteeringService.propose` (`apps/api/src/steering/steering.service.ts:158`) computes
the set of repositories an "everything else" sweep reaches with one line:

```ts
const sweepRepos = requested !== null ? [requested] : registered.map(toRef);
```

`requested` comes only from `ProposeSteeringDto.repository`
(`steering.service.ts:111-114`), an optional `owner/name` field
(`dto/steering.dto.ts:82`). The sweep itself only runs when
`parsed.exclusive && parsed.intent === 'ready'` (`steering.service.ts:161`) — an
instruction whose second half is, in effect, "hold everything else." So an exclusive
`ready` instruction with no `repository` field applies that "everything else" half
across every repository with `retiredAt: null` and `observeEnabled: true`
(`registeredRepositories`, `steering.service.ts:502-511`), silently, on a single
missing field.

The deciding argument is that **the same service already refuses to guess on the
narrow path and guesses maximally on the wide one.** With more than one repository
registered and no scope, a bare `#12` is not resolved to a guess — `repositoryFor`
reports it as `ambiguous-repository`, with the detail at `steering.service.ts:573-582`:

> `${registered.length} repositories are registered, so \`${target.reference}\` could
> mean any of them. Write it as \`owner/name#${target.number}\`, or send a
> \`repository\` with the instruction.`

on the stated ground, in the DTO's own doc comment
(`dto/steering.dto.ts:78-80`), that guessing "would write labels to an issue in a
repository the operator was not thinking about." The sweep is the identical guess
about the identical missing input — which repository the operator meant — made
across every repository at once instead of one, and today it is taken without a word.
A one-word omission (`repository`) is refused when it would misname one issue and
honoured when it would misname an unbounded number of them. That inconsistency is the
bug; the fix is to make the wide path behave like the narrow one it already sits
beside, in the same function, reading the same field.

With exactly one registered repository, `repositoryFor` does not ask — a bare `#12`
resolves against it directly (`steering.service.ts:558-560`) — because there is
nothing to be ambiguous about. The fix below preserves that shortcut for the sweep
too, for the identical reason.

Two more forces bear on the shape of the fix, not just whether one is needed:

**A project is not a tenancy boundary.** `schema.prisma:341-344` states plainly that
`Project` is "an organisational convenience, not a tenancy boundary. A repository may
exist without one" — `projectId` is nullable, and every repository registered before
#404 shipped is unassigned. Any scope model that treats a project as the unit that
covers a deployment reaches nothing on such an install.

**Nothing about scope may be stored.** `dto/steering.dto.ts:10-26` states the
architectural commitment epic #419 exists to protect: "There is no scope object, no
priority, no ordering, and no identifier for a stored proposal... A `scope` table the
dispatcher consulted would make labels and that table two expressions of the same
intent, leaving the reconciler to arbitrate between them — the two-sources-of-truth
bug epic #332 spent twenty-one issues removing." ADR-0018 §1 makes the general
argument this is an instance of: two things that can answer the same question
independently eventually answer it differently. A scope field is a request-time
selector, never a row.

## Decision

**1. An exclusive `ready` instruction with no scope, over more than one registered
repository, is unresolved rather than swept.** `propose` reports a new reason,
`ambiguous-scope`, instead of running the sweep across every registered repository. A
deployment with exactly one registered repository is unaffected: the sweep resolves
against it exactly as `repositoryFor` already resolves a bare `#12` against it, with
no scope required.

**2. "Every observed repository" becomes a scope an operator states, not the meaning
of an absent field.** It remains a legitimate thing to want — it now has to be typed.

**3. The accepted scopes are a repository, a project, the unassigned bucket, or every
observed repository — never a project alone.** `Project.repositories` is a first-class
relation, so expanding a project to its repositories is cheap, but `schema.prisma:341-344`
rules out a project as the only unit of scope: a picker offering only projects reaches
nothing on a deployment where every repository predates #404 and none has been
assigned one. `projectId: null` — the unassigned bucket — is therefore one of the
four accepted scopes, not an edge case of the project scope.

**4. Nothing about the chosen scope is persisted.** It expands to a concrete
repository set inside `propose`, at request time, and is carried on the wire in the
returned proposal exactly the way `scope.repositories` already is
(`steeringScopeSchema`, `dto/steering.dto.ts:233-254`) — never written to a table
`apply` or the dispatcher would later consult. This is `dto/steering.dto.ts:10-26`'s
rule, applied to one more field the way ADR-0018 §1 applied it to managed settings.

### The concrete shape

`proposeSteeringSchema` (`dto/steering.dto.ts:64-92`) keeps `repository` and gains:

```ts
project: z.union([z.uuid(), z.literal('none')]).optional(),
allRepositories: z.literal(true).optional(),
```

`'none'` names the unassigned bucket, matching the idiom `listRepositoriesQuerySchema`
already uses for the identical concept (`apps/api/src/repositories/dto/repository.dto.ts:144-167`):

> `none` is a member of this filter rather than a separate `unassigned` flag because
> unassigned is an ANSWER to "which project", not a different question.

`allRepositories` is the explicit, deployment-wide choice — `true` or absent, nothing
else, so there is no falsy-but-present state to reason about. At most one of
`repository`, `project`, and `allRepositories` may be supplied; sending two is a
validation error, not a precedence rule to document and remember.

Internally, the one overloaded `requested` in `propose` splits into two named sets:

- the **resolution set** — what a bare `#12` may resolve against, exactly as
  `repositoryFor` computes it today;
- the **sweep set** — what "everything else" reaches.

They are the same set whenever a scope is supplied. They differ only in today's
no-scope case: resolution keeps its existing behaviour (single repository resolves,
more than one reports `ambiguous-repository`), and the sweep — which today silently
took `registered.map(toRef)` — refuses with `ambiguous-scope` instead.

Two new entries join `unresolvedReasonSchema` (`dto/steering.dto.ts:105-120`):

- `ambiguous-scope` — an exclusive `ready` instruction, more than one registered
  repository, no `repository`/`project`/`allRepositories` supplied.
- `empty-scope` — a `project` scope that expands to zero observed repositories,
  reported distinctly rather than the sweep silently proposing nothing and leaving
  the operator to guess why.

A `project` naming no existing project is a 404, the same shape `requireRegistered`
already gives an unregistered `repository` (`steering.service.ts:513-527`) — a
request parameter naming something Opifex does not know about is, in
`steering.service.spec.ts:539-551`'s own words, "a caller mistake, not an observation
about the backlog," and belongs in the same status code, not in `unresolved`.

## Consequences

**A multi-repository deployment's default behaviour changes, deliberately.** Today, an
exclusive `ready` instruction with no `repository` field sweeps every registered
repository. After this decision, the identical instruction reports `ambiguous-scope`
and sweeps nothing. This is a real behaviour change to an endpoint #425 shipped, not a
bug fix that leaves existing callers untouched — any operator or integration relying
on the old silent-sweep default has to add one explicit scope
(`allRepositories: true` reproduces today's behaviour exactly, if that is genuinely
what was wanted).

**`steering.service.spec.ts:612-651`'s governing assertion gets one more permitted
read, not a looser rule.** `expect(h.touched).toEqual(['repository.findMany'])` pins
an exact array — propose touches Prisma for repository reads and nothing else.
Resolving a `project` scope adds a `Project` read, so both that assertion and the
`recordingPrisma` handler map at `steering.service.spec.ts:122-125` need a
`project.findUnique` (or equivalent) entry. The property the test protects — propose
writes nothing — is unchanged; only the read side of the exact-array grows by one
entry. Loosening the assertion to "no writes" instead of an exact array would discard
the part of the test that has value: that the read side is also fully accounted for,
not merely that nothing was written.

**Steering keeps reading `Project`/`Repository` rows under `workorders:write` alone —
deliberately, not by oversight.** `steering.controller.ts:60` gates both routes on
`PERMISSIONS.WORKORDERS_WRITE` and gives its own reason: steering writes the same
`factory:hold`/`factory:ready` labels that hold and release already write under that
permission, "and inventing a `steering:*` permission would let a deployment grant one
and not the other while both write the same labels to the same issues." Accepting a
`project` scope means propose now reads project and repository rows without holding
`projects:read`. Adding `PROJECTS_READ` to the route would be an ALL-of tightening
that could break a role already holding `workorders:write` without `projects:read` —
and the scope is a filter over rows the operator already steers by name, not a new
read surface into project data the operator could not otherwise reach. This is stated
here as the deliberate choice it is, not left for a later reviewer to flag as a gap.

**The web picker has to offer the unassigned bucket, or unassigned repositories become
unsteerable from the UI.** A picker that lists only projects reproduces the exact
failure decision point 3 rules out at the API layer, one layer up, on any deployment
where repositories predate #404.

## Alternatives considered

**Leave scope optional; ship only a picker in the UI.** Fixes discoverability and
typos in `repository`, and leaves the empty-field sweep exactly as it is today.
Disqualified: a picker with nothing selected makes the wide action easier to trigger
by accident, not harder, because a blank picker reads as a deliberate "no filter"
choice rather than as an unfilled required field the way a raw optional API parameter
does.

**Require a scope on every steering instruction, exclusive or not.** Uniformly safe,
and simplest to reason about — one rule, no exception. Disqualified: it taxes the
single-repository deployment, where the current implicit default is provably correct
(there is exactly one thing "everything else" could mean) and the API already resolves
a bare `#12` with no scope input at all. Friction with no risk behind it trains an
operator to click past the control rather than read it.

**Require it only for exclusive instructions, keeping the single-repository shortcut.**
This is the decision recorded above, not a rejected alternative.

**Make a project a tenancy boundary and require every repository to belong to one.**
Disqualified twice over: `schema.prisma:341-344` states directly that a project is "an
organisational convenience, not a tenancy boundary," and VISION §11 rules out the
premise a step further up — Opifex is single-operator by design, and "Multi-user is
not a deferred feature — it is a different product," so there is no tenancy concept
for a project to become the boundary of. It would also require a migration assigning
every repository registered before #404 to a synthetic project, solely to satisfy a
constraint this codebase has already argued against twice.

**Store the chosen scope on the proposal so apply can re-derive it instead of
re-expanding it.** Disqualified by `dto/steering.dto.ts:10-26` and ADR-0018 §1 — this
is the two-sources-of-truth alternative epic #419 already rejected once, for exactly
this class of field. `apply` re-reads and re-checks drift against the labels
`observedInputLabels` carried on the wire precisely so that it never needs a stored
scope to know what it is confirming; a stored scope would be a second place that
answer could live, and could disagree with the labels on the first apply that ran
after someone edited GitHub directly.
