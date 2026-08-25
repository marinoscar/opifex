# 15. Call the supervisor's model with the platform `fetch`, on a budget of its own

- Status: Proposed
- Date: 2026-08-25
- Issue: #230
- Epic: #21

## Context

#89 built the seam and deliberately shipped it empty. `SupervisorModel`
(`apps/api/src/supervisor/invocation/supervisor-model.port.ts`) is text in,
text out — no tools, no handle onto the control plane — and the only
bound implementation is `UnavailableSupervisorModel`, which rejects and says
so in the decision log. `SupervisorModule` binds no `SUPERVISOR_MODEL`
provider at all, which is why the `model ?? new UnavailableSupervisorModel()`
default in `SupervisorService`'s constructor always wins today. #230 is the
decision that ends that: pick the adapter, and answer the question #89 left
open on purpose — whose budget the calls land on.

Two axes are tangled together in that one question, and both need an answer
before anything can be built.

**The transport.** An official Anthropic SDK is the comfortable choice —
typed requests, built-in retry, streaming helpers. `apps/api/src/github/`
already faced this exact fork for GitHub and went the other way
(ADR-0002): platform `fetch`, no Octokit, because the SDK's defaults
(Octokit's throttling plugin sleeping through a rate-limit reset) fought the
one behaviour the reconciler needed. The question here is whether the same
argument holds for a client that, unlike the GitHub pipeline, issues exactly
one request per invocation and does not paginate, cache, or retry into
anything.

There is a second precedent pulling the other way: ADR-0008 chose a
subprocess over the Agent SDK for `claude-code-local`, for reasons that look
superficially similar — avoid an SDK, keep a hard process boundary. #230
argues that reasoning does not transfer to the supervisor's call, and that
argument has to be made properly rather than assumed, because ADR-0008 is the
more recent and more carefully reasoned precedent in this codebase and simply
asserting "different case" would be exactly the kind of unearned claim these
documents exist to prevent.

**The budget.** `SupervisorService`'s quota gate (`quota-gate.ts`) stands the
supervisor down whenever a run is parked on a rate limit, and its own
docstring states why: "It consumes the same quota as the workers, and a
supervisor competing for the quota it is managing is a bad loop" (VISION §7).
That sentence is a factual claim about which budget an invocation spends
from, not a policy applied for its own sake — and #230 asks whether that
factual claim survives the decision below. If the supervisor's model calls
land on a metered API key rather than the subscription `claude-code-local`
authenticates with, the claim stops being true the moment this ADR is
implemented, and the code that states it has to be found and corrected rather
than left to assert something false.

## Decision

**The transport is the platform `fetch`, calling Anthropic's Messages API
directly. No `@anthropic-ai/sdk` dependency is added.** One adapter,
`SupervisorModel`'s only production implementation, lives beside the port in
`apps/api/src/supervisor/invocation/` and is bound to the `SUPERVISOR_MODEL`
token in `SupervisorModule`.

**The model is named by an environment variable, `SUPERVISOR_MODEL_NAME`, not
hardcoded anywhere in source.** The adapter sends that string verbatim as the
API request's `model` field and returns it verbatim from `SupervisorModel.name`
— what gets written to `SupervisorInvocation.model` is therefore the exact
string that was actually sent, not a config file's claim about what would be
sent, which is precisely what the port's own doc comment asks for: recording
the model "makes 'runs on a small model' a claim checkable against the log
rather than against the config file as it reads today."

Configuration, read through `ConfigService` under a new `supervisor.model`
key, mirroring `github`'s existing shape in `configuration.ts`:

- `SUPERVISOR_MODEL_API_KEY` → `supervisor.model.apiKey`. Default unset.
  Anthropic API key. Unset is the unconfigured path — see below.
- `SUPERVISOR_MODEL_NAME` → `supervisor.model.name`. Default unset. Sent
  verbatim as the API request's `model` field and as `SupervisorModel.name`.
  Unset while the API key IS set is a half-configured deployment rather than an
  unconfigured one — see "A key with no model name is half-configured" below.
- `SUPERVISOR_MODEL_BASE_URL` → `supervisor.model.baseUrl`. Default
  `https://api.anthropic.com`. Override point for tests, mirroring
  `github.apiBaseUrl`.
- `SUPERVISOR_MODEL_TIMEOUT_MS` → `supervisor.model.timeoutMs`. Default
  `60000`. Passed to `AbortSignal.timeout`, as `GitHubHttpService` already
  does.
- `SUPERVISOR_MODEL_DEFAULT_MAX_TOKENS` → `supervisor.model.defaultMaxTokens`.
  Default `1024`. Anthropic requires `max_tokens`; used when
  `SupervisorModelRequest.maxOutputTokens` is absent.

`SupervisorModule`'s provider for `SUPERVISOR_MODEL` is a factory: when
`SUPERVISOR_MODEL_API_KEY` is set, it constructs the adapter; when it is not,
the factory **yields no adapter**, and `@Optional()` in `SupervisorService`'s
constructor leaves `model` `undefined`, which is what already falls back to
`new UnavailableSupervisorModel()` today. Nothing about that fallback path
changes — see "The unconfigured path is unchanged" below.

"Yields no adapter" rather than "contributes no provider at all", which is how
this paragraph read in the first draft. Nest gives a factory no way to abstain:
the provider is in the DI graph and its value is `undefined`, which is exactly
what `@Optional()` needs and which produces precisely the outcome this
paragraph specifies. The literal alternative — assembling the `providers` array
conditionally — would have to read `process.env` at module-DEFINITION time,
which runs while `app.module.ts` is being imported and therefore before
`ConfigModule.forRoot()` has loaded a `.env` file: right in a container, wrong
on a developer's machine. The wording is corrected rather than quietly left in
place, because "no provider at all" is the kind of phrase a later reader would
try to make literally true.

**One request, mapped directly:**

```
POST {baseUrl}/v1/messages
headers:
  x-api-key: {SUPERVISOR_MODEL_API_KEY}
  anthropic-version: 2023-06-01
  content-type: application/json
body:
  {
    "model": "{SUPERVISOR_MODEL_NAME}",
    "max_tokens": request.maxOutputTokens ?? defaultMaxTokens,
    "messages": [
      { "role": "user", "content": `${request.snapshot}\n\n${request.instruction}` }
    ]
  }
```

The response maps back onto `SupervisorModelResponse` directly: `text` is the
concatenated text blocks of `content`; `tokensInput`/`tokensOutput` are
`usage.input_tokens`/`usage.output_tokens`.

`costUsd` is computed by the adapter from those token counts against a small,
adapter-owned rate table keyed by the exact `SUPERVISOR_MODEL_NAME` string. A
model name the table has no rate for reports `costUsd: null` — not zero,
exactly as the port's own doc distinguishes "the adapter cannot say" from
"free." This table will need maintaining as Anthropic's pricing changes;
that cost is accepted explicitly rather than discovered later, see
Consequences.

**No retry, no backoff.** `ask()` issues exactly one `fetch` call. Any
non-2xx response, network failure, or timeout throws — there is no retry
loop anywhere in the adapter. This is not an omission; it is the deciding
argument, below.

## Consequences

### The deciding argument, made properly

ADR-0002 rejected an SDK for GitHub because Octokit's defaults actively
fought the behaviour the reconciler needed: the throttling plugin sleeps
through a rate-limit reset, which blocks a tick that is supposed to be
observing everything else. That argument does not transfer here unchanged —
the supervisor has no tick to block, since `invoke()` already runs off a cron
and already treats every failure as terminal for that attempt. What transfers
is the underlying reasoning one level up: **an SDK's value is the amount of
its own machinery a caller actually uses**, and here that amount is close to
zero.

Look at what an SDK would supply against what `SupervisorService.invoke()`
actually does with the call (`supervisor.service.ts:133-150`): one `await
proposer.propose(...)` per proposer, each making at most one `model.ask()`
call, wrapped in a `try`/`catch` that already records the failure and moves
to the next proposer. There is no retry to hand to a library, because the
caller's contract is explicit that there is none to want — the port's own
doc says it outright: "Throws on failure; the caller records the failure and
moves on." There is no streaming to parse, because the request is
non-streaming by construction (`SupervisorModelRequest` has no callback, no
async iterator). There is no pagination, because the API returns one
response to one request. There is no rate-limit-aware backoff to want either,
because a failed invocation simply waits for the next scheduled tick — there
is always a next tick, on a schedule, so "try again in a moment" is a
property the _scheduler_ already provides for free, not something the
transport needs to add.

So the GitHub case and this one are not merely similar; the argument applies
**more strongly** here, because GitHub's pipeline genuinely does own retry,
pagination, and conditional-request logic that an SDK would otherwise
provide and that ADR-0002 explicitly budgets for reimplementing. The
supervisor's adapter owns none of that. What is left after subtracting
everything unused is authentication headers and a JSON request/response
shape — the same shape `github-http.service.ts` already demonstrates is
comfortably hand-written and, per ADR-0002, "considerably easier to write
against than a mocked SDK."

### Why ADR-0008's reasoning does not transfer, checked rather than assumed

ADR-0008 chose a subprocess for `claude-code-local` on two grounds: **crash
isolation** (a bug in an in-process SDK integration would take down the
component whose job is noticing that runs have failed) and **unconditional
cancellation** (`SIGTERM` to a process group is a fact, not a request, and
the watchdog needs to kill a misbehaving run for real).

Neither ground has a counterpart in the supervisor's call. There is nothing
here for a subprocess boundary to isolate the supervisor _from_, because the
call is not a long-running, tool-calling loop that can wander — the port
forbids that by construction ("it has no tools, no function calling, no
handle onto the control plane"). What can go wrong is exactly two things: the
HTTP request errors, or it does not return before `AbortSignal.timeout`
fires. Both are already caught by `SupervisorService`'s existing `try`/`catch`
around each proposer, in-process, with no isolation gap to close — a crash
containment mechanism sized for a runner that can loop indefinitely on tool
calls is solving a problem this call cannot have.

Cancellation fares the same way. ADR-0008's watchdog kills a run because a
long streaming process might not stop on its own; there is no watchdog here
because there is nothing that runs long enough to need one — the call either
returns inside its own timeout or the timeout ends it. A subprocess adds an
OS-level kill switch for a call that already terminates itself.

What a subprocess would cost, concretely, if taken anyway: it needs its own
CLI binary, its own version to track, and — this is the part that matters
most — its own credential. The natural credential for a CLI shaped like
`claude-code-local`'s is the same interactive subscription the workers
authenticate with, which is precisely the shared-quota loop VISION §7 warns
about and precisely what routing the supervisor's calls to a separately
metered API key (below) is meant to get away from. Reaching for ADR-0008's
mechanism here would reintroduce the problem this ADR exists to close.

### Option C — dispatch the supervisor's ask as a work order — is disqualified, not merely rejected

There is a difference between an alternative that lost an argument and one
that cannot be chosen at all, and this ADR keeps that distinction visible
rather than flattening it into "rejected" like the others.

`apps/api/test/governing/supervisor-offline.spec.ts` is the governing test
for VISION §7's headline property — "if the AI supervisor is offline, the
factory keeps running" — and it enforces two things relevant here. Structurally,
it asserts that no file under `dispatch/`, `watchdog/`, `budget/`,
`reconciler/`, `run-events/`, `work-orders/`, or `escalations/` imports
anything from `src/supervisor/` at all (`supervisorImporters`, checked per
row of VISION §7's left-hand column). Behaviourally, it constructs a real,
broken `SupervisorService` — disabled, throwing, and hanging — and asserts
dispatch, stall detection, parking, budget enforcement, and escalation all
produce identical verdicts whether or not it is running, including while an
invocation is left permanently unsettled (`withBrokenSupervisorsRunning`).

Routing the supervisor's model call through the work-order/runner seam would
put a supervisor invocation on the dispatch path this test exists to keep
clear: `decideDispatch` would have to reason about a work order whose
purpose is asking a question rather than shipping a change, `WorkOrderSpec`
would need to represent something with no branch, no acceptance criteria,
and no commit — and the moment any hot-path file imports anything to make
that work, the structural half of the test fails by construction, not by
oversight. This is not a case where the option is merely more expensive or
less elegant than B; it is a case where choosing it puts a passing test on
the losing side of its own assertion. That is what "disqualified" means here
and why it is recorded separately from the alternatives that were merely
weighed and declined below.

### The quota gate keeps standing down, on a different fact

Before this decision, `quota-gate.ts`'s own docstring stated the gate's
justification as a fact about shared infrastructure: _"It consumes the same
quota as the workers, and a supervisor competing for the quota it is
managing is a bad loop."_ `configuration.ts:157` and `.env.example:484-487`
say the same thing in the same words. All three describe a world where the
supervisor's model calls draw on the same agent subscription
`claude-code-local` authenticates with — which was a reasonable thing to
write down before an adapter existed, since it named the only plausible
mechanism at the time.

This ADR makes that sentence false. `SUPERVISOR_MODEL_API_KEY` is a
separately metered Anthropic API credential, not the interactive
subscription VISION §11 calls "shared quota" and that `claude-code-local`
draws from. A supervisor invocation no longer competes with a worker for
anything workers need. **The gate should stay exactly as it is — standing
down when a run is parked, standing down under live-run pressure — but for a
different reason, and a future reader deserves to be told which reason the
code is actually making rather than left to infer it from a comment that
used to be true.**

The reason that survives: a parked worker is evidence that everything the
supervisor exists to advise about is not moving. Diagnosis produced while
every run is stalled has nothing live to act on it — the daily brief will
say the same thing whether it is computed now or once runs resume, and a
re-dispatch or decomposition proposal has no target that can execute on it
until a worker is unblocked. Standing down is still correct; it is no longer
"protecting the budget," it is "there is nothing worth diagnosing while
everything is parked."

**This changes text, not behaviour, and the ADR names where to start
looking:** `quota-gate.ts`'s file-header docstring — both the "It consumes the
same quota as the workers" paragraph and the "A supervisor invocation while
workers are parked spends budget that a parked run is waiting for" sentence,
which are BOTH in that header. The first draft of this ADR placed the second in
`assessQuota`'s doc comment; it is not there, and `assessQuota`'s own doc
comment asserts only that the function is pure, which is still true. Then
`configuration.ts`'s `supervisor` block, and the `SUPERVISOR_ENABLED` block in
`.env.example`. The same claim recurs a few lines below each of those, in the
`standDownWhenBlocked` justification, and once more in
`run-diagnosis.proposer.ts`'s comment explaining why its model calls are
sequential. Every site that states the old reason needs correcting alongside
the adapter; the names above are where to start the search, not its extent.

**The `liveRunCeiling` exemption in the first draft was an error, and is
withdrawn.** That draft asserted the ceiling's justification — "pressure is not
exhaustion" — "does not depend on shared budget and needs no change". Two
things it actually says do depend on shared budget, and are false for exactly
the reason the rest of this section exists: `quota-gate.ts`'s header claims the
supervisor's "marginal call is more likely to be the one that tips a worker
into parking", and the verdict the gate RETURNS says "The supervisor yields the
shared quota to the workers." The second is worse than a stale comment rather
than better, because it is logged output — an operator reading a
`skipped_quota` row is told something untrue about why the supervisor stood
down, in the log this system asks them to trust.

The ceiling's BEHAVIOUR stays exactly as it is: same threshold, same
comparison, same default of no ceiling at all. Its stated reason takes the same
correction as the stand-down reason. With many runs live there is a great deal
in flight and little worth diagnosing until some of it lands — a diagnosis
written against a factory mid-flight is out of date by the time anything can
act on it — and the supervisor's own spend is separately metered either way.
"Pressure is not exhaustion" survives intact as the argument for the default
being OFF; what does not survive is the claim about whose budget the pressure
falls on.

### The model is named, not tiered — and that is a deliberate departure from `ModelTier`

`ModelTier` (`apps/api/src/runners/runner.types.ts`) is `'small' | 'standard'
| 'large'` by design, specifically so a work order's `modelTier` field never
leaks a vendor's catalogue into a contract every runner has to speak — the
type's own doc comment is explicit that naming a model there "would put a
vendor's catalogue into the contract." `SUPERVISOR_MODEL_NAME` does exactly
the thing that field was built to avoid: it puts a literal catalogue entry
(`claude-haiku-4-5-...` or whatever string Anthropic assigns) into
configuration.

This ADR takes the position that the difference is warranted, not
overlooked, for a reason specific to what each field feeds. `modelTier` is
read by `decideDispatch` (`dispatch/dispatch-policy.ts`) to route a work
order to one of potentially several _runners_, each of which may serve a
different vendor's models under the same tier — the abstraction exists
because the same work order has to mean the same thing whether it lands on
`claude-code-local` or a runner that does not exist yet. The supervisor is
not a runner, does not implement `Runner`, and does not go through
`decideDispatch`; `SupervisorModel` is bound once, in one module, to one
concrete adapter that speaks to exactly one vendor's API. There is no second
implementation for a tier to route between, and inventing one — a
`SUPERVISOR_MODEL_TIER` env var plus a `Record<ModelTier, string>` mapping
table maintained somewhere in the adapter — would not remove the vendor
dependency `ModelTier` exists to hide; it would only add one more layer of
indirection between the config file and the same literal string, and that
mapping table would itself go stale exactly the way #89's doc comment warns
a hardcoded model name would: a claim in a config file that the log cannot
check.

The literal string is honest about what actually happens, and it satisfies
the same test the port's doc comment sets: recording `SupervisorModel.name`
per invocation "makes 'runs on a small model' a claim checkable against the
log rather than against the config file as it reads today." A tier name checked
against the log would tell a reader "standard was asked for"; the literal
name tells them which model actually answered. If a second supervisor-model
vendor is ever added, that is the moment to revisit this — the port
(`SupervisorModel`) does not need to change to add a second adapter, only the
factory that chooses between them, and _that_ is where `ModelTier`'s argument
would start to bind. It does not bind today, because there is only one
implementation to name.

### The unconfigured path is unchanged, and must stay that way

`UnavailableSupervisorModel` keeps rejecting when no adapter is bound, and
that behaviour is not something this ADR asks the implementer to improve on.
An unset `SUPERVISOR_MODEL_API_KEY` must not crash the API, must not
silently disable the supervisor without a trace, and must not be
"helpfully" swallowed into a quieter failure mode. `SupervisorService`'s
`@Optional()` constructor parameter and its `model ?? new
UnavailableSupervisorModel()` fallback are exactly right today and stay
exactly as they are: the new factory provider for `SUPERVISOR_MODEL`
yields no adapter when the key is absent, which is what makes `@Optional()`
see `undefined` and fall back, precisely as it does before this ADR is
implemented. The refusal is recorded in the decision log
via the existing `skipped_disabled` / thrown-error path — nothing about that
recording changes.

### A key with no model name is half-configured, not unconfigured

The trigger for binding the adapter is `SUPERVISOR_MODEL_API_KEY` alone, and
the first draft of this ADR said nothing about the corner that leaves: a key
set with no `SUPERVISOR_MODEL_NAME` beside it. The adapter is constructed —
the key is present — but there is no model string to send.

The resolution: **construct the adapter, warn once at startup, and refuse per
call with an error naming the missing variable**, reporting
`SupervisorModel.name` as the literal `'unconfigured'` so the decision log
records what actually happened rather than a model that was never asked.

Falling back to `UnavailableSupervisorModel` instead would be the tidier-looking
choice and is the wrong one: it would make a typo in a model name
indistinguishable from a deliberate decision not to run a supervisor at all,
and those are the two states this whole seam exists to keep apart. Throwing at
construction is also wrong, for the reason the unset-key path is wrong to
throw on — a misconfiguration must not stop the API booting. What is left is a
supervisor that says, once an hour, in the log, exactly which variable is
missing.

### What this does not settle

The per-model cost table the adapter owns is a real, ongoing maintenance
cost this ADR accepts rather than solves — Anthropic's pricing is not
queryable from the Messages API response, so the table is hand-maintained
and will drift the way any hand-maintained table does. A model name missing
from it reports `costUsd: null`, which is the correct degraded behaviour
(unknown, not free) but is a degradation nonetheless, and it will happen the
day `SUPERVISOR_MODEL_NAME` is pointed at a model this table has not been
updated for. This ADR does not propose a fix beyond "the null case must
report null, never zero, and never fail the invocation" — a future ADR could
revisit whether pricing belongs in a config file, a fetched table, or
somewhere else, if the maintenance burden turns out to matter in practice.

This ADR also does not give the supervisor's own API spend a ceiling. VISION
§8's hard spend ceiling (`OPIFEX_HARD_SPEND_CEILING_USD`,
`apps/api/src/budget/hard-spend-ceiling.ts`) bounds what dispatch may spend
on runs; nothing in this decision routes the supervisor's own cost through
it, and nothing here should be read as implying it does. Whether the
supervisor's diagnostic spend needs its own ceiling is a separate question,
open for now.

## Alternatives considered

**The Anthropic SDK, in-process.** Typed requests and built-in retry, at the
cost of a dependency whose retry, streaming, and pagination machinery this
adapter has no use for — see "The deciding argument, made properly" above.
Rejected on the same grounds ADR-0002 rejected Octokit, applied more
strongly because this adapter owns even less of what an SDK would supply.

**Reuse `claude-code-local`'s subprocess/CLI invocation path (ADR-0008's
mechanism).** Rejected because ADR-0008's two justifying arguments —
crash isolation from a long-running, tool-calling loop and unconditional
process-group cancellation — have no counterpart in a single bounded,
tool-free HTTP call, and because the natural credential for a CLI shaped
like `claude-code-local` is the same subscription the workers use, which
would reintroduce the shared-quota problem this ADR exists to leave behind.
See "Why ADR-0008's reasoning does not transfer" above.

**C — dispatch the supervisor's ask as a work order through the runner
seam.** Disqualified, not merely rejected: it would put a supervisor
invocation on the dispatch path `apps/api/test/governing/supervisor-offline.spec.ts`
asserts it is structurally not on, both by the import-boundary check and by
the behavioural check that dispatch decisions are unaffected by a broken
supervisor. See its own subsection above.

**Leave `UnavailableSupervisorModel` as the only implementation
indefinitely.** Not a real alternative so much as the status quo #230 was
filed to end: `SupervisorInvocation.costUsd` stays permanently null, "runs
on a small model" (VISION §7) stays an unverifiable claim about a config
file that names nothing, and the observe phase of VISION §7's promotion
ladder (#99) never accumulates the evidence it needs, because there is
nothing for a proposer to reason about without a model answering it.
