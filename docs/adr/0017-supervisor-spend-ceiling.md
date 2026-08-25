# 17. The supervisor gets its own hard spend ceiling, enforced between model calls

- Status: Proposed
- Date: 2026-08-25
- Issue: #261
- Epic: #21

## Context

Two prior decisions in this epic leave the supervisor's own spend in a specific, named
state: unbounded.

ADR-0015 moved the supervisor's model calls onto `SUPERVISOR_MODEL_API_KEY`, a
separately metered Anthropic credential, away from the interactive subscription
`claude-code-local` authenticates with. It did that specifically so "a supervisor
invocation no longer competes with a worker for anything a worker needs" — and it said,
in its own Consequences, exactly what it was declining to build: "This ADR also does not
give the supervisor's own API spend a ceiling... Whether the supervisor's diagnostic
spend needs its own ceiling is a separate question, open for now." #261 is that question,
closed.

ADR-0016 then removed `liveRunCeiling`, the quota gate's other arm, after finding it was
never a cost control in the first place — `SupervisorService.invoke()` runs every
registered proposer exactly once per tick regardless of how many runs are live, so gating
on `runsRunning` never bounded a dollar figure it had no relationship to. That ADR's own
argument for defaulting the (now-removed) ceiling off leaned on "the supervisor's own
spend is separately metered either way" — i.e., it assumed a real spend control existed
or would exist elsewhere. After ADR-0016, `quota-gate.ts`'s only remaining arm is
`standDownWhenBlocked`, which stands down on a fact about worker state, not a figure about
dollars. **Nothing in the running system today compares the supervisor's spend to
anything.** `SUPERVISOR_ENABLED=true` plus `SUPERVISOR_MODEL_API_KEY` set is sufficient,
today, for an hourly cron to spend an unbounded amount against a real credit card,
forever, with no operator-visible ceiling anywhere in the code that would say otherwise.
That is the bug #261 reports, stated exactly: not merely "no ceiling exists" but "nothing
stops the ceiling from reading `∞`, and nothing tells the operator that is what is
happening."

**The question this ADR has to answer is not only "should there be a ceiling" — #261
already establishes there must be — but whether that ceiling is the existing one
(`OPIFEX_HARD_SPEND_CEILING_USD`, `hard-spend-ceiling.ts`, `decideSpendAdmission`) or a
second, independent one scoped to the supervisor.**

### The case for sharing

`SpendLedgerService.tally()` already queries `Run.findMany` with no `runnerKey` filter —
it is fleet-wide by construction, summing every run's `costUsd` regardless of which runner
produced it. Extending that query to also sum `SupervisorInvocation.costUsd` is a small,
mechanical change, and it produces one number that answers "what has this cost me,
total" — which is a real question an operator asks, and which two ceilings cannot answer
between them without the operator doing the addition by hand.

### The case for separating

ADR-0015 spent real argument escaping exactly the loop a shared ceiling would recreate at
a different layer. The quota gate used to stand the supervisor down "because it competes
with workers for quota"; ADR-0015 made that literally false by moving the credential.
Folding the _dollar_ ceiling back together would reintroduce the same coupling the
_quota_ separation was built to remove: once workers have spent close to the shared
figure, the supervisor — the one component whose entire job is noticing and explaining
that spend is unusually high — goes quiet at exactly the moment an operator most needs
it to say so. **A supervisor that stops diagnosing because the workers spent the budget
is absent precisely when things are going wrong,** which is the inverse of VISION §7's
governing test ("if the AI supervisor is offline, the factory keeps running") — that test
protects the factory from a dead supervisor; nothing protects the supervisor's own
uptime from the factory's spend, unless the two are kept apart.

### The measurement argument, checked rather than assumed

The brief for this ADR raised a further argument: #89 requires supervisor cost be
tracked so it never distorts metric 5 ("cost per merged PR"), and if a shared tally folds
supervisor spend into the same figure the ceiling checks, metric 5 would have to subtract
it back out — at which point the two were separate all along and a shared ceiling only
obscured it. That argument turns out not to hold against the code as it stands today, and
it is worth saying exactly why, because the correction matters more than the argument it
replaces.

`MetricsService.costPerMergedPr` (`apps/api/src/cockpit/metrics.service.ts`) queries
`Run.findMany` directly — `pullRequestState: 'merged'`, selecting `costUsd` off `Run`
rows only — and divides by the count of merged pull requests. It does not call
`SpendLedgerService.tally()`, does not read `SupervisorInvocation` in any form, and has no
path by which a change to the ceiling's tally could reach it. **Folding
`SupervisorInvocation.costUsd` into `SpendLedgerService.tally()` would not, today, distort
metric 5 at all** — the two are already structurally disconnected, independent of what
this ADR decides. The subtract-it-back-out consequence the framing predicted does not
follow from the code as written; checking it, as instructed, found it wrong.

What _does_ hold, and settles the question on its own: `schema.prisma`'s doc comment on
`SupervisorInvocation.costUsd` already states the reason that column is where it is —
"SEPARATE from `Run.costUsd` by construction - a different table entirely - because #89
requires supervisor cost never distort success metric 5." That separation is not this
ADR's proposal; it is a standing architectural commitment made under #89, before #261 was
filed. A shared ledger that sums `Run.costUsd` and `SupervisorInvocation.costUsd` into one
figure for the purpose of a ceiling would be the first place in this codebase those two
columns are added together for any purpose — and having built that combined figure once,
for the ceiling, it becomes exactly the number a future change would reach for the next
time someone wants "total spend" for a dashboard, an alert, or metric 5 itself. The
schema's separation exists to make that mixing structurally awkward to do by accident;
routing the ceiling through a shared tally is the one place that would make it easy. The
measurement argument survives, but on architectural-consistency grounds — protecting a
boundary the schema already drew — not on the mechanical "metric 5 would need to
subtract" claim, which the current code does not support.

### Where this leaves the decision

Two independent arguments point the same direction — the anti-competing-loop argument
(the deciding one) and the schema-consistency argument (real, but narrower than first
stated) — and the measurement argument that seemed to settle it on paper turns out to be
moot given how metric 5 is actually written. **Separate.**

## Decision

**The supervisor gets its own hard spend ceiling: a new environment variable, a new
tally over `SupervisorInvocation` only, and a new pure gate function — structurally a
sibling of `hard-spend-ceiling.ts` / `decideSpendAdmission`, not an extension of them.**
It does not touch `OPIFEX_HARD_SPEND_CEILING_USD`, `HardSpendCeilingService`,
`SpendLedgerService`, or `decideSpendAdmission` in any way. Those remain exactly what
ADR-0015 already said they are: a ceiling on what dispatch may spend on runs.

### Configuration

Two new variables, named and shaped like the existing ceiling's, under the `SUPERVISOR_`
prefix rather than `OPIFEX_` — this is supervisor-owned configuration, read alongside
`SUPERVISOR_MODEL_API_KEY` and friends, not a second instance of the one thing
`OPIFEX_HARD_SPEND_CEILING_USD` already names:

- `SUPERVISOR_HARD_SPEND_CEILING_USD` — dollars, rolling window. Unset is the
  unconfigured path (see "Unset refuses" below), exactly mirroring
  `OPIFEX_HARD_SPEND_CEILING_USD`'s own unset behaviour.
- `SUPERVISOR_HARD_SPEND_CEILING_WINDOW_DAYS` — default **`1`**, not 30 (see "The
  window" below).

`SUPERVISOR_LIVE_RUN_CEILING`'s retirement comment in `.env.example` already points here
("For a real cap on the supervisor's metered spend, see #261") — that comment should be
rewritten to name these two variables once they exist, rather than pointing at a still-open
issue.

### A new type and a new service, deliberately not a second `HardSpendCeilingService`

The value shape is identical to `HardCeiling` (`limitUsd: number | null`,
`windowDays: number`, `malformed: string | null`) and should reuse that interface directly
— `import type { HardCeiling } from '../../budget/hard-spend-ceiling'` — rather than
inventing a structurally identical twin. The _parsing rules_ are identical in spirit to
`parseHardCeiling` (malformed is not absent; an empty string is not a ceiling of zero; a
negative number is malformed) and should reuse or closely mirror that logic. What must
NOT be reused is the class: a new `SupervisorSpendCeilingService`, living in
`apps/api/src/supervisor/invocation/`, holds this value read once from `process.env` in
its constructor with no setter — the same non-negotiable pattern `HardSpendCeilingService`
uses and for the same reason (VISION §8: "a limit an agent can raise is not a limit"),
applied to a different number. Keeping it a separate class means `HardSpendCeilingService`
continues to mean exactly one thing everywhere it is referenced — the dispatch ceiling —
and a reader never has to ask "which ceiling" when they see that name.

This does not violate `apps/api/test/governing/supervisor-offline.spec.ts`'s import
boundary: that test forbids `budget/`, `dispatch/`, `watchdog/`, and the other hot-path
directories from importing anything from `src/supervisor/`. It says nothing about the
reverse — the supervisor module depending on a pure, side-effect-free type from `budget/`
is one-directional and off the hot path, exactly like the supervisor already depends on
`SnapshotService`. The new service itself, however, should live under `supervisor/`, not
`budget/`: this is the supervisor's own ceiling, and `budget/`'s existing file header is
explicit that it is dispatch's.

### The tally: `SupervisorInvocation` only, a floor when anything is unpriced

A new tally, read the same way `SpendLedgerService.tally()` is — rows read and reduced in
code, not `SUM`med in SQL, for the same reason: a `SUM` over a nullable column drops nulls
silently, and the count of what was dropped is the point. Query
`SupervisorInvocation.findMany` for invocations `startedAt` within the rolling window, and
reduce to:

- `reportedUsd` — the sum of `costUsd` for invocations that reported one.
- `unpricedCount` — how many invocations, or calls within them, priced at null.

There is no third leg equivalent to `SpendLedgerService`'s `estimatedUsd`. That estimate
exists there because a work order carries an operator-authorized `budgetCeilingUsd` to
serve as an honest upper bound when the runner reports nothing — a figure someone actually
set, standing in for a figure nobody measured. A supervisor tick has no equivalent
per-call authorization to borrow from, so there is nothing honest to estimate _from_; the
tally does not invent one. `reportedUsd` is compared to the limit directly, and whenever
`unpricedCount > 0` it is a floor exactly the way `SpendLedgerService.tally().totalUsd`
is a floor when `unboundedRuns > 0` — surfaced in the gate's reason text, never silently
read as the whole truth.

### The gate: a new pure function, checked twice per invocation, in two different shapes

A new pure function, e.g. `assessSupervisorSpend(ceiling, tally): SupervisorSpendVerdict`,
mirroring `decideSpendAdmission`'s ordering discipline without its `OrderBudget` concept
(there is no "order" here, only "may this tick spend at all"):

1. A malformed ceiling refuses, named as its own case — not absence.
2. An unset ceiling refuses (see "Unset refuses" below).
3. `reportedUsd >= limit` refuses, naming the figures, exactly as
   `decideSpendAdmission`'s "already at the ceiling" rule does.
4. Otherwise, admit, reporting headroom.

This function is called from **two different places in `SupervisorService.invoke()`**,
because the supervisor's cost is knowable at two different resolutions that a runner's is
not.

**Before the tick starts.** Immediately after the `enabled` check and before
`snapshots.collect()` — earlier than today's `assessQuota` call, and deliberately so: the
spend check needs none of the snapshot state `assessQuota` reads, and refusing early
avoids a wasted query when the answer is already "no." If refused, record a new outcome,
`skipped_budget` (see "Recording the refusal" below), and never call `assessQuota` or run
a single proposer. If admitted, proceed to `snapshots.collect()` and `assessQuota` exactly
as today — the parked-run check is unchanged and keeps running after the budget check,
mirroring `decideSpendAdmission`'s own precedent that a budget-shaped refusal is checked
before anything situational.

**Between proposers, inside the loop that is already there.** This is the second half of
point 1's answer, and it is the part that makes this design more than a copy of the
dispatch ceiling. `decideBudgetOverrun`'s `stoppable` arm is, by that file's own comment,
never reachable for the one runner that exists: `claude-code-local` reports cost once, on
its final `result` line, so by the time a dollar figure exists the run it describes is
already over. The supervisor's situation is structurally different, not merely smaller:
each proposer makes **at most one** `model.ask()` call (ADR-0015's own accounting), and
`priceUsd()` resolves synchronously the instant that call's response returns — before the
next proposer in the loop is ever invoked. A tick is a short, enumerable sequence of
atomic, immediately-priced calls, which is exactly the shape a between-calls check needs
and a runner's run does not have.

So: `SupervisorService.invoke()` tracks a running `spentThisTick` figure as the existing
`meter()` wrapper already accumulates `costUsd` per response, and before invoking each
proposer after the first, re-evaluates `reportedUsd(tally) + spentThisTick` against the
limit. If it would already be at or over, the remaining proposers for this tick are not
called. The invocation still writes a row — its `outcome` is `partial`, the value that
already means "not everything happened, and what did is recorded" — with a
`failureReason` that names the cause explicitly: something like `"Stopped after 2 of 4
proposers: the supervisor's spend ceiling ($5.00 per 1d) was reached mid-invocation."`
This is a genuinely different fact from today's only `partial` cause (`"At least one
proposer failed."`), and the two must read differently in the log, even though they share
one enum value — see "Recording the refusal" below for why a sixth enum value is not
needed here specifically.

`quota-gate.ts` is **not** the home for either check, and that is a decision, not an
omission. Its own file header states its identity in words chosen for exactly this
question: "this gate reads STATE rather than any budget." A spend check is a budget check
by definition; putting it there would falsify the sentence the file leads with, the same
category of error ADR-0015 and ADR-0016 both spent a full document correcting elsewhere in
this same file. `assessQuota`'s signature was also narrowed by ADR-0016, on purpose, to
`Pick<SnapshotTotals, 'runsBlocked'>` specifically so "the gate cannot regrow a
`runsRunning` branch without the signature changing in a diff" — extending it with a spend
figure is exactly the shape of change that guard exists to make visible, and it would
still be the wrong shape even if made visible: `assessQuota` is pure over a snapshot taken
once, and the between-proposers check genuinely cannot be, because it depends on results
produced by calls already made _within_ the invocation it is judging. Keeping the two
gates as two files, called from two different points in `SupervisorService.invoke()`,
keeps each one's contract honest about what kind of check it is.

### What an unknown cost does — to the tally, and to the gate

`priceUsd()` returns `null`, never zero, for a model missing from `MODEL_RATES` or for a
response missing a token count. That must not become zero here either, for the reason
`model-pricing.ts`'s own header gives: a run of zeroes would answer "yes, worth it" to a
question nobody measured. But it must also not stop the supervisor outright — ADR-0015's
Consequences already committed to this for the cost-_reporting_ path ("the null case must
report null, never zero, and never fail the invocation"), and this ADR extends the same
rule to the ceiling that reads that column.

The resolution: an unpriced call is counted in `unpricedCount`, contributes nothing to
`reportedUsd`, and is surfaced in whichever verdict's reason string fires next — never
silent, never blocking on its own. This accepts a real, bounded gap, and the honest move
is to name it rather than paper over it, the way `decideSpendAdmission`'s own doc comment
names its gap ("An order with no ceiling of its own... is admitted whenever the tally is
below the limit — because there is no figure to project with... a real gap"). The
equivalent gap here: a run of calls to a model outside the price table is under-bounded
by this ceiling until `model-pricing.ts` is updated for it, exactly as
`model-pricing.ts`'s own header already accepts ("this table is hand-maintained and it
will drift... the day `SUPERVISOR_MODEL_NAME` is pointed at a model this table has not
been updated for" the cost column goes null). Closing that gap would mean refusing to run
any call on an unpriced model at all — which was considered and rejected, because it
converts an ordinary, expected event (Anthropic ships a model, the table has not caught up
yet) into an indefinite outage of the entire supervisor, which is a worse failure than an
under-bounded floor. An under-measured ceiling is a known, named limitation; a supervisor
that goes dark the day a config value points at a model released last week is the "halt
forever" outcome this decision is explicitly told to avoid.

**A prerequisite this decision depends on, found while researching it, and required as
part of implementing this ADR rather than left for later:** `SupervisorService`'s existing
`meter()`/`add()` pair (`supervisor.service.ts`) already has a version of this problem,
and it is not currently handled correctly. `add(total, value)` treats `value === null` as
"add nothing," which correctly keeps a fully-unpriced tick's `costUsd` at `null` — but a
**mixed** tick, where one proposer's call priced and another's did not, ends up with
`costUsd` equal to only the _known_ portion, indistinguishable from a tick where every
call priced and happened to sum to that figure. That silently treats the unpriced call as
if it cost nothing, for exactly the case the "never zero" rule exists to prevent. This
predates #261 and is not itself the ceiling, but the new tally reads the same column this
bug corrupts, so it must be fixed as part of this work: `SupervisorInvocation` needs a way
to say "this invocation's `costUsd` is a floor" — a boolean or a count, alongside the
existing `costUsd` — the same shape `SpendLedgerService` already uses for
`unboundedRuns`, so a mixed tick is visible as partially-unknown rather than quietly
under-reported.

### Unset refuses — a deliberate behaviour change, not a default choice made lightly

`decideSpendAdmission` refuses when `OPIFEX_HARD_SPEND_CEILING_USD` is unset, and its own
doc comment gives the reason in general terms: "an unbounded action that cannot be checked
does not proceed" (VISION §3.5, spend is not reversible). This ADR follows the identical
precedent for the supervisor's ceiling, for a reason specific to this moment rather than
merely by analogy: **ADR-0016 already removed the only other thing that ever stood the
supervisor down for a spend-adjacent reason**, and #261 exists because, right now, in a
running deployment with `SUPERVISOR_ENABLED=true` and a model key set, nothing bounds
spend at all. "Unset means unlimited" is not a neutral default here — it is the literal
bug this ADR was filed to close, restated as a default. Following `decideSpendAdmission`'s
fail-closed precedent is not optional if this ADR is to actually answer #261's title
("does not reach the hard limit") rather than relocate the same gap one file over.

**Say plainly what this changes for a deployment that has the supervisor running today
with no ceiling configured, because there is one:** the moment this ships, that
deployment's supervisor stops running, silently from the operator's point of view until
they read the boot log, and stays stopped until `SUPERVISOR_HARD_SPEND_CEILING_USD` is
set. That is not a regression to soften — it is the closing of the exact hole #261
reports. Shipping a permissive default here to avoid surprising an existing deployment
would mean shipping this ADR without actually fixing the bug it exists to fix.

**What an operator sees.** `SupervisorSpendCeilingService` announces its state at boot,
mirroring `HardSpendCeilingService.announce()`'s three cases (malformed is an error,
unset is a warning naming the variable and what it will do, configured is a log line
stating the figure and window) — but only when `SUPERVISOR_ENABLED` is true, so a
deployment that has never turned the supervisor on does not accumulate an hourly warning
about a feature it is not using. Per tick, a refusal is recorded in the decision log with
the same reason-string discipline `decideSpendAdmission` uses: the figure spent, the
figure it is measured against, and the window, so an operator reading one row does not
need to read this file to understand why the supervisor did not run.

### The window: one day, not thirty

`HardCeiling.windowDays` defaults to 30 for the dispatch ceiling, and that default is
right for what it measures: runner spend is bursty and irregular — a work order might cost
nothing for days and then several dollars in an afternoon — and a rolling month is what an
operator actually means by "I will spend at most this much." The supervisor's spend
pattern is close to the opposite of that. `SupervisorTask` runs on `CronExpression.
EVERY_HOUR` — twenty-four ticks a day, each running every registered proposer once,
regardless of factory activity (ADR-0016's own finding). Per-tick cost is small and close
to constant, set almost entirely by which model `SUPERVISOR_MODEL_NAME` names.

A 30-day window sized for bursty runner spend is the wrong instrument for a near-constant
hourly cost stream, in both directions at once. It is **slow to catch**: a
misconfiguration that points the supervisor at a materially more expensive model — Opus is
roughly fifteen to twenty times Haiku's per-token rate in `MODEL_RATES` — would run for
potentially weeks, at twenty-four ticks a day, before a monthly figure caught up to a
monthly ceiling sized for the old rate. It is also **slow to recover**: once a 30-day
ceiling did trip, the supervisor would then be dark for up to a month, which is the
"absent when things are going wrong" failure this whole ADR exists to avoid, self-inflicted
by the ceiling meant to prevent overspend. A window scaled to the cadence — this ADR
picks **one day** as the default — catches a regression within roughly twenty-four ticks
instead of several hundred, and recovers automatically as the window rolls forward rather
than requiring an operator to notice and intervene before the supervisor runs again. An
operator who genuinely wants a monthly figure can set
`SUPERVISOR_HARD_SPEND_CEILING_WINDOW_DAYS=30`; the default should not force that choice
on a deployment that has not thought about it.

### Recording the refusal — distinguishable from `skipped_quota`, without over-growing the enum

Two additions to `SupervisorInvocationOutcome` (`schema.prisma`) and `InvocationOutcome`
(`decision-log.types.ts`), not one, and they are not symmetric:

- **`skipped_budget`** — a new enum value, for the pre-tick refusal. This needs its own
  value rather than reusing `skipped_quota`, because the two name different facts an
  operator needs to tell apart: `skipped_quota` says "workers are parked, there is nothing
  worth diagnosing yet"; `skipped_budget` says "this would cost money the ceiling does not
  have room for." One is about the state of the factory; the other is about a dollar
  figure. Collapsing them would put a reader back where ADR-0016's Context describes
  `quota-gate.spec.ts` having been before it added a reason-string assertion: a plausible
  sentence nobody can check against the fact it claims. `SupervisorService.recordSkip()`'s
  `Extract<InvocationOutcome, 'skipped_disabled' | 'skipped_quota' | 'failed'>` parameter
  type gains `'skipped_budget'` alongside the others it already lists.
- **No new value for the mid-tick stoppage.** `partial` already means "the invocation ran
  but not everything in it completed, and what did is recorded" — a budget-stopped tick is
  exactly that, not a new shape of outcome. What must change is that `failureReason` never
  reads identically for a proposer error and a budget stoppage: today `anyFailed` always
  writes the literal string `"At least one proposer failed."`; this ADR requires a second,
  distinct string for the budget case (see "Between proposers" above) so a reader
  scanning `failureReason` — not just `outcome` — can always tell which happened without
  cross-referencing `costUsd` by hand. Distinguishing at the reason-text layer rather than
  minting a `partial_budget` enum value keeps the small, already-meaningful `outcome` enum
  from growing a value for every reason a tick can end up partial, which is a slope this
  ADR declines to start down.

## Consequences

### What this does not settle

Whether `parseHardCeiling`'s parsing logic should be refactored to take its env var names
as parameters (and reused literally) or duplicated into a sibling function is left to the
implementer; either is consistent with this decision as long as the malformed/absent/
fail-closed rules are identical in behaviour, not merely similar in spirit. Whether
`unpricedCount` crossing some threshold should ever escalate into its own refusal — e.g.
"N consecutive unpriced ticks" treated as an operational problem worth surfacing more
loudly than a reason string — is not decided here; nothing in this ADR requires it, and
inventing it now would be adding a control nobody has asked for evidence to justify, the
exact pattern ADR-0016 spent itself correcting for `liveRunCeiling`. If real invocation
data eventually shows unpriced ticks are common enough to matter, that is a future
decision, made on that evidence, not on the possibility of it today.

This ADR also does not revisit `hard-spend-ceiling.ts`, `SpendLedgerService`, or
`decideSpendAdmission` in any way — they are unmodified, and nothing here should be read
as implying dispatch's ceiling now accounts for supervisor spend, or vice versa. An
operator who wants a true combined figure across both must currently read two numbers and
add them; nothing in this decision produces a merged view, and building one — a dashboard
figure, not an enforcement mechanism — is explicitly not disqualified by anything here,
only left undone.

### The framing this ADR corrects

The brief this ADR was written from treated "if both land in one tally, metric 5 must
subtract supervisor spend back out" as a live consideration worth checking before relying
on it. It was checked, and it does not hold against the code as written: `metrics.
service.ts`'s `costPerMergedPr` reads `Run.costUsd` directly and has no path through
`SpendLedgerService` or `SupervisorInvocation` by which a shared tally could reach it.
Recorded here so a future reader does not re-derive the same mistaken mechanism from the
same plausible-sounding premise — the real argument for separation is the anti-competing-
loop one, with the schema's own documented table-separation as a second, narrower,
architectural-consistency argument. The measurement-distortion mechanism as originally
stated is not it.

## Alternatives considered

**Shared — fold `SupervisorInvocation.costUsd` into `SpendLedgerService.tally()` and
enforce through the existing `OPIFEX_HARD_SPEND_CEILING_USD` / `decideSpendAdmission`.**
Rejected on the anti-competing-loop argument: it recreates, at the dollar layer, the exact
coupling ADR-0015 spent a full document removing at the credential layer — a supervisor
whose ability to run depends on how much workers have spent goes quiet exactly when
worker spend is the thing worth explaining. Secondarily rejected because it would be the
first place in this codebase `Run.costUsd` and `SupervisorInvocation.costUsd` are summed
together, working against a separation `schema.prisma` already documents as deliberate.

**Extend `quota-gate.ts` / `assessQuota` with a spend figure.** Rejected because it
contradicts the file's own stated identity ("reads STATE rather than any budget"),
reopens the exact "signature grows a branch nobody argued for" pattern ADR-0016 built a
guard against, and cannot represent the mid-tick, incrementally-updated check this ADR
relies on — `assessQuota` is pure over a snapshot taken once, and that check by
construction is not.

**No enforcement beyond after-the-fact detection, the way `decideBudgetOverrun` handles a
runner overrun.** Rejected, not merely because it is weaker, but because it gives up a
check this ADR's own point 1 shows is actually reachable here. `decideBudgetOverrun`'s
`stoppable` arm is documented as never firing for `claude-code-local`, because cost
arrives once, after the money is already spent. The supervisor's calls do not share that
constraint — each proposer's cost is known synchronously before the next proposer runs —
so choosing the weaker, after-the-fact pattern here would be discarding a genuinely better
option available for this specific case, not merely reusing an existing one.

**Unset ceiling permits unlimited spend (status quo, restated as a default).** Rejected:
this is #261 itself, not an answer to it. ADR-0016 already removed the only other thing
standing between an enabled supervisor and unbounded spend; a permissive default here
would leave that removal's premise — "the supervisor's own spend is separately metered
either way" — still unfulfilled the moment this ADR ships.

**A 30-day default window, matching `OPIFEX_HARD_SPEND_CEILING_WINDOW_DAYS`.** Rejected
for the cadence mismatch argued above: a window sized for bursty, irregular runner spend
is both slow to catch a regression in a near-constant, twenty-four-times-a-day cost stream
and slow to recover once tripped — the worst combination for a control whose failure mode
is the supervisor's own extended absence.
