# The claude-code-api overflow runner: a plan (#112)

Epic #23 is Phase 8 of VISION §12's roadmap — **"Second runner. Only when quota
pressure or vendor risk justifies it."** This document is the plan that phase asks
for, and it is deliberately only that. VISION §3.7: _"Build one runner well. Build
the seam correctly from day one. Do not build the second runner until it is
needed."_ Nothing here is TypeScript, a schema file, or a manifest — those come
once §4's gate opens, and writing them now would be building the second thing
before it is needed.

What follows is: the capability manifest `claude-code-api` would declare, and which
parts of it are genuinely known versus assumed; how its cost model sits against
the hard spend ceiling (#65) and where that interaction is unresolved; the exact
shape a routing rule would take in `dispatch-policy.ts`; and the gate itself,
named plainly rather than gestured at.

---

## Standing note: `claude-code-cloud` is blocked, so this is currently the only viable second runner

VISION's planned-runners table (§6) scoped `claude-code-api` as the overflow of
_last_ resort, behind `claude-code-cloud`: `claude-code-local` is v1, own
infrastructure, full streaming; `claude-code-cloud` is v1.1, vendor cloud, free
compute, near-zero streaming; `claude-code-api` is own infrastructure, overflow
for when subscription quota is exhausted.

Investigation of `claude-code-cloud` (#102/#103), recorded as comments on both
issues, found the vendor CLI (`2.1.241`) refuses `--cloud` combined with `--print`
— _"Cloud sessions are interactive only."_ There is no non-interactive
submit/poll/cancel surface, so four required manifest fields
(`streamingFidelity`, `rateLimitSignal`, `reportsCost`, `maxConcurrency`) are
unobservable and `claude-code-cloud`'s manifest cannot honestly be written. It is
blocked on the vendor, not on anything in this codebase.

That changes this plan's standing without changing its gate. With
`claude-code-cloud` blocked, `claude-code-api` is currently the **only** viable
second runner — not a second-tier fallback behind one that already exists. That
is worth stating plainly so nobody reads this document assuming `claude-code-cloud`
is available to try first. It is not a reason to build `claude-code-api` now: the
§10 metric-2 gate (§4 below) still has to open, and VISION §3.7 still applies. The
only thing that has changed is which runner would be built when it does.

---

## 1. The expected capability manifest

Field by field, against `schemas/runner-capability.schema.json`. Every value below
is marked **Expected** or **Verify** — an expected value is the plan's best
reasoning about what a real integration would find; a value marked Verify is one
that must be confirmed against observed behaviour before it is written into an
actual manifest. Writing an expected value into a real manifest without that
verification is exactly the failure the schema's own description warns about:
_"an overstated manifest produces a control plane that trusts signal it is not
actually receiving."_ `claude-code-local`'s own history is the model to follow —
its `streamingFidelity` shipped `none`, honestly, for one PR before the mapper
that earned `full` existed (see its class doc comment).

### Fields fixed by convention, not by observation

These do not need verification against vendor behaviour because they are Opifex's
own choices, not claims about the vendor.

- **`schemaVersion`** — whatever 1.x is current at build time (`1.2.0` today).
  Administrative; the schema accepts any 1.x by design (ADR-0010).
- **`key`** — `claude-code-api`, fixed by VISION's own planned-runners table.
- **`displayName`** — `Claude Code (API)`, to distinguish it from `Claude Code
(local)` in any UI that lists runners.
- **`branchPatterns`** — `["factory/*"]`, the same convention every runner
  Opifex dispatches to declares (schema description). A control-plane
  convention, not a vendor fact.
- **`speaksSchemaVersions`** — absent. Ships and is maintained inside this repo,
  like `claude-code-local` — absent correctly means "the newest 1.x Opifex has"
  (schema description).

`version` is real but unknowable in advance: it is whatever SDK/CLI version string
the concrete integration reports, recorded on every run so a behaviour change
correlates with an upgrade — the same reason `claude-code-local` records its own.

### `invocationModel` — Expected: `http_api`

The control plane starts work with a network call rather than spawning a local
process. This is not cosmetic: `runner.types.ts`'s own doc comment says
invocation model "determines what cancellation MEANS" — a `process` can be
signalled (`ChildProcessSupervisor`'s SIGTERM/SIGKILL, as `claude-code-local`
does it), but an `http_api` call "must be asked to stop." **Verify:** whether the
concrete integration exposes any cooperative stop primitive at all. If it does
not, `cancel()` degrades to "stop polling and let it finish," which is a real
capability gap `invocationModel: http_api` does not by itself disclose — it would
need to be visible in `notes`.

### `executionLocus` — Expected: `own_infrastructure`

This is the field VISION's planned-runners table asserts directly, and it is the
fact that separates `claude-code-api` from `claude-code-cloud`: only the model
inference call leaves Opifex's own hardware. Tool execution, file edits, and git
operations run where `claude-code-local`'s already do. This is what makes work
orders declaring the `own-infrastructure` need (`RunnerNeed` in
`runner.types.ts`) eligible for `claude-code-api` but never for
`claude-code-cloud`.

### `streamingFidelity` — Expected: `full`, and the field most worth doubting

This is the schema's own "most consequential field," and the one `#102`'s finding
makes hardest to take on faith here. Two genuinely different integration shapes
are both plausible under `invocationModel: http_api`, and they imply different
answers:

- If the integration reuses the Claude Agent SDK's own event stream (the same
  `stream-json` protocol `claude-code-local/stream-json-mapper.ts` already maps,
  just transported over an API key instead of a CLI subprocess) — `full` is
  earnable cheaply, by extending an existing mapper rather than writing one.
- If the integration is a hand-rolled loop against the raw Anthropic Messages API
  — Anthropic's own streaming format (`message_start`,
  `content_block_delta`, tool-use blocks, `message_delta` with `usage`,
  `message_stop`) is also fine-grained, but nothing in this codebase maps it yet,
  and that mapper would be new work, not reuse.

Either path plausibly earns `full` — this is not the `claude-code-cloud` situation,
where the surface does not exist at all. But plausible is not observed. **Verify:**
build the mapper, run it against real traffic, and only then declare `full` — the
same order `claude-code-local` followed, and for the same reason: a graded field
declared ahead of the mapping that earns it is a lie the control plane will act on.

### `rateLimitSignal` — Expected: `structured`, but a different _kind_ of rate limit

Anthropic's HTTP API returns standard rate-limit headers and 429 responses with
machine-readable reset information — plausibly more structured than parsing a
CLI's stderr text, which is what `claude-code-local`'s `structured` rests on.
**Verify:** whether the concrete HTTP client surfaces those headers to Opifex's
code (depends on which library is chosen).

Worth naming even before that: this would be a **request-rate** limit (requests
or tokens per minute against an API key), not the **session/usage quota** a
subscription runner is rate-limited by. VISION §10's metric 6, "quota burn vs.
reset window," describes the subscription kind. Metered billing has no comparable
reset window — there is no ceiling on how much can be spent per period except the
one Opifex itself imposes (§2 below). A `claude-code-api` manifest declaring
`structured` is making a true but narrower claim than it might look like next to
a subscription runner's identical value.

### `stabilityTier` — Expected: `experimental`, regardless of the vendor API's own maturity

This is the field most likely to be reasoned about wrong. The temptation is "the
Messages API is GA, so `stable`" — but `stabilityTier` is a claim about Opifex's
own confidence in _its integration_ of the runner, not about the vendor's SLA.
ADR-0007 is explicit that `claude-code-local` "stays experimental until something
has actually run unattended," even though the CLI it wraps was already GA at the
time. `claude-code-api` should follow the identical discipline: `experimental` at
first, promoted only on the same kind of evidence VISION §12's observation-week
gate asks for elsewhere in this system.

This has one concrete downstream effect worth flagging now: once (if ever)
`claude-code-api` is promoted to `stable`, it becomes eligible to serve as the GA
fallback `claude-code-cloud` needs under the existing preview rule (§3 below) —
without needing `DISPATCH_ALLOW_PREVIEW_RUNNER` at all, for any work order that
does not itself require `own-infrastructure`. That is a real consequence of this
plan for a runner this plan does not build, and it is exactly the kind of
interaction §3 is about.

### `reportsCost` — Expected: `true`, and a stronger `true` than `claude-code-local`'s

The Anthropic Messages API returns token `usage` on every response, against
published per-model, per-token pricing — a genuine, computable dollar figure.
That is a materially different position from `claude-code-local`, whose CLI
"reports cost once, on its final `result` line" (`budget-overrun.ts`'s doc
comment) with a per-message `usage` field that is "a streaming snapshot... that
does not sum to the total." If `claude-code-api`'s integration surfaces `usage`
on every individual response rather than hiding a multi-turn session behind one
terminal number, `reportsCost: true` here could mean something
`claude-code-local`'s never could: a cost figure available _during_ the run, not
only after it. Whether that
promise holds is the entire subject of §2's hard problem — this field states the
capability; it does not by itself resolve how it gets used.

### `resumable` — Expected: `false`

No architectural reason has surfaced to build or rely on vendor-side session
resumption for this runner. VISION §3.4 allows it as an optimization and forbids
it being load-bearing either way, so the default costs nothing to leave at
`false` until a concrete reason to set it `true` appears.

### `maxConcurrency` — a policy decision married to an unverified account fact, not a technical constant

For `claude-code-local`, this number reflects the machine's own resource limits
for concurrent CLI subprocesses (`CLAUDE_CODE_MAX_CONCURRENCY=2` in
`infra/compose/.env.example`, matching the schema's own worked example). For
`claude-code-api` there is no subscription seat to protect — the schema
description's framing, "not a performance hint... the runner's own limit on how
much of that quota it will take," stops mapping cleanly, because there is no
shared subscription pool here to take from. Two different unknowns compose into
this one number: Anthropic's actual RPM/TPM tier for whatever API key is used
(a fact to look up, not to guess), and how many simultaneous dollar-spending runs
an operator is willing to have in flight before the hard spend ceiling (§2) is
what stops them (a risk-tolerance decision, not a fact at all). **Expected:** a
small number, on the order of `claude-code-local`'s example of `2`, as a starting
point pending both halves. **Verify:** the account's actual rate-limit tier before
setting it higher, and treat the operator's own comfort with concurrent metered
spend as a deliberate configuration decision, not a default to infer.

### `modelTiers` — Expected: absent (serves any tier), with a lever available later

Absent means "serves everything," and there is no reason yet to restrict it —
restricting it now would be a rule built ahead of the evidence that would justify
it, which is exactly what §3.7 warns against. The field stays available as a
cost-control lever for later: if usage data (once `claude-code-api` exists and
is measured) shows one tier disproportionately drives spend, `modelTiers` is
where that gets encoded, not a new field.

### `notes` — recommended, though not required while `reportsCost: true`

Not required by the schema's conditional rule (`reportsCost: false` is what
triggers it), but worth using anyway to record the one fact a reader of the raw
manifest cannot get from any other field: that `reportsCost: true` describes
whether a dollar figure is _knowable_, not whether it is knowable _in time to stop
a live run_. Something like: _"reportsCost describes cost visibility, not mid-run
enforceability — see docs/claude-code-api-runner-plan.md for what would have to
be true for a ceiling to bind during a run rather than after one."_

---

## 2. The cost model, and its collision with #65

### Two different things both called "quota"

`claude-code-cloud` (were it available) would share the same **subscription**
quota pool `claude-code-local` already draws from — VISION §11's "shared quota,"
a rate/session limit with no dollar cost visible per run. `claude-code-api` draws
from a genuinely independent pool: **metered billing**, a marginal dollar cost
per token, with no session limit in the subscription sense at all. Conflating
these is an easy mistake because both get called "quota exhaustion" colloquially.
They are not the same failure: a subscription pool being exhausted is a
_rate-limit_ problem (nothing more can run until a reset time, VISION §10 metric
6); a metered pool "running out" is not a technical limit at all — it is only
Opifex's own hard spend ceiling (#65) choosing to say no. This is precisely why
`claude-code-api` is a genuine answer to subscription exhaustion: when the
subscription pool is rate-limited, the metered pool is not rate-limited by the
same constraint — it is limited by money instead, which is a limit Opifex
imposes on itself, not one the vendor imposes.

### The global ceiling already generalizes; nothing new is required there

`apps/api/src/budget/hard-spend-ceiling.ts`'s `HardCeiling` is a single,
runner-agnostic dollar figure, read once from `OPIFEX_HARD_SPEND_CEILING_USD` and
never on any code path an agent can reach. `SpendLedgerService.tally()`
(`spend-ledger.service.ts`) confirms this is fleet-wide by construction: it
queries `Run.findMany` with no `runnerKey` filter at all and sums every run's
`costUsd` into one `SpendTally`, regardless of which runner produced it. So a
`claude-code-api` run's reported cost counts against the exact same ceiling, in
the exact same dollars, through the exact same column, as anything
`claude-code-local` ever reports. **No new global-accounting mechanism is needed**
for the ceiling itself to correctly bound a second, metered runner — this is a
genuine finding of this plan, not an assumption: the architecture built for one
runner's occasional reported cost already generalizes to a runner whose cost is
the entire point.

What is _not_ already adequate is the per-order picture, and the mid-run picture.

### The per-order gap, and a narrow fix scoped to metered runners

`decideSpendAdmission` (`spend-admission.ts`) already documents its own gap
plainly: an order naming no `budgetCeilingUsd`, heading to a runner that reports
cost, is "admitted on headroom alone" — bounded only by whatever the run
eventually reports, after the fact. Its own doc comment names the proper fix as
out of its scope: _"Closing it properly means requiring a ceiling on every order,
which is #31's schema decision to make, not this gate's."_

For `claude-code-local` this gap is tolerable — a subscription run's marginal
dollar cost, if it reports one at all today, is not the pressure point. For
`claude-code-api` it is the opposite: every token is a marginal dollar, and this
is precisely the runner where an unbounded order is a real exposure rather than a
theoretical one.

This plan's recommendation is narrower than #31's full fix, and does not require
a work-order schema change: extend `OrderBudget` (in `spend-admission.ts`) with
a `quotaPool: 'subscription' | 'metered'` field — read from the chosen runner's
capabilities, the same way `runnerReportsCost` already is in
`run-executor.service.ts`'s call site — and tighten the `order.ceilingUsd ===
null` branch to also refuse when `quotaPool === 'metered'`, reusing the existing
`work-order-cannot-be-budgeted` refusal (no new `SpendRefusal` value needed; "no
ceiling and nothing downstream could bound it" is exactly as true for a metered
run with no order ceiling as it is for one whose runner cannot report cost at
all — `decideBudgetOverrun` literally cannot fire without a ceiling to compare
against, regardless of `reportsCost`). This is a **budget-module** change, at the
same call site that already exists in `RunExecutorService.dispatchWorkOrder`,
_after_ a runner has been selected — it does not touch `decideDispatch` or
`dispatch-policy.ts`, and so does not collide with #105 (see §3).

### The hard problem: mid-run enforcement, which this plan does not resolve

This is the substantive risk, and it must be stated rather than papered over.

`claude-code-local`'s class doc comment gives the honest finding this whole plan
inherits: the wall-clock ceiling is enforceable because time is observable from
outside the process (`run-deadline.ts`'s `decideDeadline`, backstopped against
the runner's own timer), but a dollar ceiling is not, "because the CLI reports
cost once at the end." `budget-overrun.ts`'s `decideBudgetOverrun` already
encodes the consequence: its `stoppable` arm exists but "will never fire" for
`claude-code-local`, because `costUsd` never arrives until the run is already
over. A run that overspends is _recorded and escalated_, never _stopped_.

`invocationModel: http_api` changes the _shape_ of this problem but does not by
itself resolve it, and which of two things it becomes depends entirely on which
concrete integration is chosen — a decision this plan does not make, because
making it would be building the runner:

- **If Opifex owns the turn loop** — calling the Messages API directly, one
  request per turn, receiving `usage` on each response before deciding whether to
  issue the next request — there is a real, buildable checkpoint: refuse to make
  request _N+1_ once the running tally plus a worst-case estimate for one more
  turn would exceed the order's ceiling. This is a genuine improvement over
  `claude-code-local`'s position, and it is the reason `reportsCost: true` for
  this runner is a _stronger_ claim than the same field is for the local one (§1
  above).
- **If the integration instead calls a hosted, agentic endpoint** that runs its
  own multi-step tool loop server-side across many internal model calls before
  returning one response — Opifex is back to a single terminal report, and the
  problem is structurally identical to `claude-code-local`'s, despite
  `invocationModel: http_api` and `reportsCost: true` both being true. The
  manifest would say nothing false in this case, but an operator reading
  `http_api` + `reportsCost: true` and assuming mid-run enforcement follows would
  be wrong, which is exactly why §1 recommends recording the distinction in
  `notes`.

Three mechanisms are worth naming as candidates, none of them decided here:

1. **Per-turn cost checkpoint**, as above — best fidelity, but only available
   under the first integration shape, and it means Opifex owns and maintains an
   agent loop rather than delegating to a vendor's, which is real, ongoing
   implementation weight, not a one-time cost.
2. **A vendor-side token budget passed with the request** (if Anthropic's API
   exposes a session- or request-level spend cap) — bounds a single request's
   worst case, but not a multi-request run's total; would still need to be
   combined with (1). Whether such a parameter exists is unverified.
3. **A wall-clock proxy for spend** — reuse `run-deadline.ts`'s already-built,
   already-enforceable mechanism, on the theory that time is a rough proxy for
   tokens burned. Cheap, but a poor proxy: burn rate varies by model tier and by
   task shape (a `large`-tier run doing heavy tool use burns dollars far faster
   per minute than a `small`-tier one waiting on a slow tool call), so one number
   either overprotects cheap runs or underprotects expensive ones. Tightening it
   per `modelTiers` is a calibration exercise this plan has no usage data to do.

**What this plan concludes, stated plainly:** the mid-run enforcement gap is real,
it is worse for a metered runner than it is for `claude-code-local` today, and it
is not resolved by anything in this document. Which of the mechanisms above (or
some combination) is viable depends on an integration decision — Opifex-owned
loop versus vendor-hosted agent — that has not been made, and this plan does not
make it, because making it is design work belonging to the build, not the plan.
Until it is made and verified, `claude-code-api` must be treated, for budget
purposes, as no safer than `claude-code-local`'s after-the-fact-only model,
regardless of what its manifest otherwise declares. The admission-time fix in the
previous section (requiring an order ceiling for metered runners) narrows the
_exposure window_ — it does not solve the mid-run problem, it only guarantees
there is always a number to compare a report against once one arrives.

---

## 3. The routing stance, for #105 to consume

VISION §6's rule for this runner is stated once, informally: never selected while
a subscription runner has both capability and headroom. This section makes it
concrete against `decideDispatch`'s actual structure in
`apps/api/src/dispatch/dispatch-policy.ts`.

### The recommendation: a capability field, plus a new eligibility branch

Add an optional field to the capability manifest and to `RunnerCapabilities`:
`quotaPool: 'subscription' | 'metered'`. Absent means `'subscription'` — the same
additive-default pattern `modelTiers` already uses, and it is correct today for
every runner that exists: `claude-code-local` draws on the subscription pool, and
an absent field must not change its eligibility.

In `decideDispatch`, add a check structurally parallel to the existing
preview/GA-fallback rule (`isPreview(entry.capabilities) &&
!hasGaFallback(input.needs)`, lines ~278–301 today): before marking a `metered`
candidate eligible, check whether any _other_ enabled candidate meeting the same
`needs` and `modelTier` is `quotaPool === 'subscription'` **and** currently has
headroom (`maxConcurrency - liveRuns > 0`). If one does, the metered candidate is
marked ineligible, with a `reason` naming the specific subscription runner and
its headroom — the same standard #64 already holds every other verdict to:
_"a reviewer must be able to reconstruct the decision from this line... without
reading code."_ If no subscription-pool candidate has both the capability and the
headroom — including the case where a capable one exists but is momentarily
full — the metered candidate falls through to the ordinary headroom/eligibility
checks that already exist, and can be dispatched to.

This does not need a new `QueueReason`. The rule only ever produces `eligible:
false` on one _candidate_; it never causes the overall decision to queue, because
firing the rule is only possible when an eligible subscription alternative
exists — that alternative is what gets dispatched instead. `diagnose()` and
`explain()` need no changes.

### Alternative rejected: a soft preference in `byPreference`

`byPreference` already sorts by headroom, descending, as a tiebreak. Folding
"prefer subscription pool" into that sort — rather than into eligibility — was
considered and rejected. VISION's own wording is a hard constraint ("never
selected while..."), not a tiebreak, and a sort-order change could still be
overridden by the existing headroom tiebreak in a case where the metered runner
happens to have more free slots. A hard eligibility rule also produces an honest
`reason` on the losing candidate; a sort-order change produces nothing a reader
could point to — it would be a policy enforced silently, which is exactly what
#64's "decision must be reconstructible from the reason alone" standard exists to
prevent.

### Interaction with the preview rule and `allowPreviewWithoutGaFallback`

Two separate rules, evaluated independently, and worth being explicit about how
they compose:

- `claude-code-api`, expected `stabilityTier: 'experimental'` at first (§1), is
  itself subject to the _existing_ preview/GA-fallback rule the moment it is
  registered — it would need `claude-code-local` (once, per ADR-0007, that
  runner itself is promoted past `experimental`) or an operator's
  `DISPATCH_ALLOW_PREVIEW_RUNNER` acknowledgement to be eligible for anything at
  all, exactly as `claude-code-local` needed in ADR-0007.
- Once `claude-code-api` is eventually promoted to `stable` (on the same
  evidence-based schedule every runner here is held to), it becomes a candidate
  GA fallback for `claude-code-cloud`, for any work order that does not require
  `own-infrastructure` as a need — `claude-code-cloud`'s `executionLocus` is
  `vendor_cloud`, so a work order requiring `own-infrastructure` was never going
  to route there regardless. That is a real future consequence of this plan
  worth flagging now, even though this document builds nothing.
- The new `quotaPool` holdback rule and the preview/GA-fallback rule can both
  apply to the same candidate but ask different questions and do not conflict:
  the GA-fallback check asks "could a stable runner take this exact order at
  all," ignoring headroom by design (`hasGaFallback`'s own comment: "whether or
  not it currently has headroom"); the `quotaPool` check asks "does a
  subscription runner have headroom _right now_." A metered runner can be a
  legitimate GA fallback for a preview subscription runner while simultaneously
  being held back from an individual dispatch because that same subscription
  runner currently has a free slot.

### A note on timing

This recommendation is written against `dispatch-policy.ts` as read while writing
this plan, and #105 (quota-aware routing) is being implemented against the same
file concurrently. Whoever picks up `quotaPool` should re-read `decideDispatch`,
`byPreference`, and the `QueueReason` union against whatever #105 has actually
landed before implementing anything here — this plan's line numbers and function
shapes are a snapshot, not a guarantee.

---

## 4. The gate

This is not built until quota exhaustion is measurably costing dead time — VISION
§10's metric 2, dead time per day, crossing from "a number nobody is tracking" to
"a number that is visibly, repeatedly non-trivial because of subscription quota
specifically." Two open issues are the prerequisite for that measurement to exist
at all, and naming them is part of naming this gate honestly rather than leaving
it as a phrase nobody could act on:

- **#231** — record agent-subscription quota consumption and reset windows. Without
  this, "quota pressure" (the condition VISION §12 names as the trigger) has no
  number behind it at all.
- **#232** — record stall durations, so dead time per day can actually be computed.
  Without this, metric 2 itself does not exist as a measured quantity, quota-caused
  or otherwise.

A gate whose measurement does not yet exist is worth naming as such rather than
leaving implicit. With `claude-code-cloud` blocked (see the standing note above),
`claude-code-api` is now the only route by which a second runner could ever close
this gate — which raises the stakes on #231 and #232 landing, but does not move
the gate itself, and does not license building ahead of it.
