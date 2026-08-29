# 18. Operator settings resolve default → env → DB row, and the hard spend ceilings join them

- Status: Accepted
- Date: 2026-08-26
- Issue: #354
- Epic: #332
- Supersedes part of: ADR-0017's "no runtime path" guarantee for `SUPERVISOR_HARD_SPEND_CEILING_USD`

## Context

Every tunable in this codebase today reads through exactly one of two paths, and the
paths do not talk to each other. `ConfigService`, wired from `apps/api/src/config/configuration.ts`,
reads `process.env` once at boot and stays fixed for the life of the process —
`dispatch.retryCeiling`, `reconciler.intervalMs`, `supervisor.standDownWhenBlocked`, and
everything else `configuration.ts` manufactures. Changing one of these means editing the
environment and restarting. The other path — `user_settings` and `system_settings`,
JSONB rows read and written over HTTP — is exactly the opposite: live, no restart, gated
by RBAC. #354 is the proposal to let a defined set of **managed keys** — the operational
knobs that today only live in `configuration.ts` — move onto the second path without
losing the guarantees the first path was built to hold. #333 tracks the work; this ADR
settles the shape.

That shape is not free to pick arbitrarily, because two things this codebase has already
argued hard for sit directly in its way:

**`apps/api/src/common/schemas/user-settings-namespaces.schema.ts`** already fought this
exact battle for user-facing settings and left the scar tissue in its own header:

> CRITICAL: NO `.default()` ANYWHERE IN THIS FILE ... Absent MUST mean "use the
> application's built-in defaults", computed at read time by the consumer. This is
> load-bearing, not style.

The file's own example is precise: if `visibleColumns` defaulted to `[]`, the first time
a user touched an unrelated preference the persisted entry would freeze today's column
list, and every column added afterward would be silently invisible to that user forever.
A managed key that gained a `.default()` in its DB-backed schema would freeze the same
way — the first admin who edits an unrelated setting materializes today's `retryCeiling`
into the row, and a later release's change to the built-in default never reaches a
deployment that has one. The resolution order this ADR settles is this file's rule,
applied one layer further out.

**`apps/api/src/budget/hard-spend-ceiling.ts` and
`apps/api/src/supervisor/invocation/supervisor-spend-ceiling.ts`** both refuse this
proposal outright, by name, in their own file headers, and both name the mechanism this
ADR is about as the threat:

> `ConfigService` has a public `set()`. Any code holding the injected instance can raise
> a value that came from `configuration.ts` at runtime, and nothing would record that it
> happened. `system_settings` is worse — it is a JSONB row an Admin can `PATCH` over
> HTTP, which is precisely a trust grant reaching the limit.
> — `hard-spend-ceiling.ts:13-17`

VISION §8 backs both files: "Modifying CI workflows, the policy table, or budget
configuration" is on the never-trustable list, hardcoded, "not policy-configurable,
regardless of any grant." Two ceilings in this codebase exist for no other reason than to
make that sentence true in code, not just in prose.

So the real tension #354 forces is not "should settings be editable at runtime" —
`system_settings` already answers that for UI preferences and feature flags. It is
**which specific things get to move, under what resolution rule, and whether the two
files built to make VISION §8's never-trustable clause literally true get to stay
exceptions forever or get folded in under a different guarantee.** This ADR answers all
six parts of that question the epic surfaced, in order.

## Decision

### 1. `OperatorSettingsService` is the one read path for a managed key

For every key this migration touches, `OperatorSettingsService` — living alongside
`apps/api/src/settings/system-settings/system-settings.service.ts`, the existing
DB-backed settings service it is structurally a sibling of — becomes the **only** call
site. The corresponding line in `configuration.ts` is deleted, not left as a second,
unused way to reach the same fact. `dispatch.retryCeiling`, `reconciler.intervalMs`,
`supervisor.standDownWhenBlocked`, `supervisor.logSkippedInvocations`, and the rest of the
operationally-tunable (non-secret, non-enablement-kill-switch) values in `configuration.ts`
are removed from the object that factory function returns; `this.config.get('dispatch.retryCeiling')`
becomes a dead call with nothing behind it, which is the point — grepping the codebase for
that call site after this migration should return zero results outside
`OperatorSettingsService` itself. This is the same argument ADR-0011 made about
`ACTION_CLASSES` and ADR-0013 made about the forbidden-effect registry: two things that
can answer the same question independently will eventually answer it differently, and the
fix is never "keep both in sync," it is "only one of them exists."

**Which keys move is not fully enumerated here.** The candidates named throughout this
ADR — `dispatch.retryCeiling`, `reconciler.intervalMs`, the two hard spend ceilings, the
supervisor's stand-down and skip-logging flags — are illustrative of the shape, not an
exhaustive list #333 must reproduce exactly. What is settled, for every key that does
move: it moves entirely, or not at all. A key half-migrated — read from
`OperatorSettingsService` in one call site and `ConfigService` in another — reintroduces
the exact two-paths problem this section exists to close, one key at a time.

**What never moves.** Anything that is raw secret material — `JWT_SECRET`,
`GOOGLE_CLIENT_SECRET`, `GITHUB_TOKEN`, `SUPERVISOR_MODEL_API_KEY` (superseded
by one per-provider key per vendor — `MODEL_ANTHROPIC_API_KEY`,
`MODEL_OPENAI_API_KEY` — since #422), the database credentials, the VAPID
private key — is never a managed key, structurally, not by oversight. See
point 3.

### 2. Resolution order is `default → env → DB row`, and absence never coerces to `false`

For a managed key, three layers, checked in this order:

1. The application's own hardcoded default — the literal already embedded in today's
   `configuration.ts` (`?? 3`, `|| '15'`, `?? 60_000`).
2. The environment variable, if set — exactly what `configuration.ts` reads today.
3. A row in the operator-settings table, if `OperatorSettingsService` holds one for that
   key.

**Absence at any layer falls through to the next; it is never read as a value.** This is
the `user-settings-namespaces.schema.ts` rule again, restated for a layer that file did
not have to reason about: an absent DB row means "nothing here," and "nothing here" means
"ask the layer below," all the way down to the hardcoded default — never `false`, never
`0`, never `null` read as the answer. A boolean managed key with no row and no env var set
must resolve to whatever the hardcoded default says, not to `false` by construction of the
lookup. Concretely: `OperatorSettingsService.get('supervisor.standDownWhenBlocked')`
returning `undefined` for "no row" and being coalesced with `?? false` by a careless call
site would silently invert a switch that defaults **on** — this is exactly the shape of
bug the resolution chain exists to make structurally unreachable, by making the service
itself walk all three layers before returning, rather than handing a partial answer to a
caller that has to remember to fall through correctly every time it calls `.get()`.

**A `PATCH` sending `null` for a managed key means "delete the row for this key; revert to
env."** This mirrors `dataTablesPatchSchema`'s JSON Merge Patch convention
(`{ dataTables: { jobs: null } }` deletes the `jobs` entry) and `navigationPatchSchema`'s
per-field null-means-revert. The one difference from user settings: "revert" for a managed
key does not land on a single hardcoded default the way `railCollapsed`'s does — it lands
on whatever the next layer down currently says, which may itself be an env var an operator
set. That is deliberate: an operator who set `DISPATCH_RETRY_CEILING=5` in the environment
and then, later, PATCHed a DB override to `10`, and then PATCHed `null` to remove the
override, gets back **5**, not the code's `?? 3`. The env layer is a real, intentional
choice an operator already made outside the running system; a revert must not erase it.

### 3. Secrets never enter `process.env` or `ConfigService` through this mechanism — and neither does anything else, for a second, independent reason

No managed key is ever secret material (point 1). That is the first, sufficient reason
`OperatorSettingsService` never needs to write a secret into `ConfigService`. The second
reason applies regardless of secrecy, to every key, and it is why
`OperatorSettingsService` must never call `ConfigService.set()` at all, for anything —
because `set()`'s own source makes that call load-bearing in a way its name does not
suggest:

```js
set(propertyPath, value) {
    const oldValue = this.get(propertyPath);
    (0, set_1.default)(this.internalConfig, propertyPath, value);
    if (typeof propertyPath === 'string') {
        process.env[propertyPath] = String(value);
        this.updateInterpolatedEnv(propertyPath, String(value));
    }
    if (this.isCacheEnabled) {
        this.setInCacheIfDefined(propertyPath, value);
    }
    this._changes$.next({
        path: propertyPath,
        oldValue,
        newValue: value,
    });
}
```

— `node_modules/@nestjs/config/dist/config.service.js`

Line four of the body is `process.env[propertyPath] = String(value)`. `set()` does not
just update `ConfigService`'s own internal map — it writes the value into the process's
actual environment, readable by anything in the process that reads `process.env` directly,
including a child process spawned with an inherited environment. `claude-code-local`
(ADR-0008) is exactly such a child process. A convenience implementation of
`OperatorSettingsService` that used `ConfigService.set()` internally, so that existing
`this.config.get(...)` call sites kept working unmodified, would silently rebuild the
bridge `hard-spend-ceiling.ts`'s header names as the specific thing it exists to have no
path through — for every managed key, not only the ceilings. This is why point 1 requires
deleting the `configuration.ts` line rather than overwriting it at runtime: there must be
no `ConfigService.set()` call anywhere in this design, full stop, which is only checkable
if `ConfigService` itself is left completely untouched by the new service.

**The second failure is independent of intent and does not require anyone to try to set a
secret.** `set(propertyPath, undefined)` — an entirely plausible way to implement "clear
the override" if `OperatorSettingsService` were built on top of `ConfigService.set` —
computes `String(undefined)`, which is the four-character string `'undefined'`, and writes
_that_ into `process.env[propertyPath]`. The read path does not catch it:
`getFromProcessEnv` returns whatever `process.env` holds, and the string `'undefined'` is
not `isUndefined` — it is a defined, non-empty string, so `ConfigService.get()` returns it
as the value, never falling through to any further default. A caller like
`apps/api/src/dispatch/dispatch.service.ts:96`,

```ts
globalMaxConcurrent:
  this.config.get<number | null>('dispatch.maxConcurrent') ?? null,
```

does not see this: `?? null` only fires on `null`/`undefined`, and the string
`'undefined'` is neither. `globalMaxConcurrent` becomes the _string_ `'undefined'`,
typed as `number | null` and trusted as one by everything downstream. Any numeric
comparison against it (`liveRuns < globalMaxConcurrent`) coerces the string through
`Number('undefined')`, which is `NaN`, and every comparison against `NaN` is `false` — so
the fleet concurrency ceiling silently stops constraining anything, with no thrown error,
no failed type check, and no log line, because nothing here is malformed by
`ConfigService`'s own definition of the word. This is not a hypothetical about secrets; it
is what happens to _any_ managed key the moment something clears an override through
`ConfigService.set()` rather than through a real `DELETE`/`PATCH null` against the
operator-settings row. It is the second, independent reason `ConfigService.set()` is never
called by this design, for any key, secret or not.

### 4. The coherence unit is one tick, not the life of the process

`ReconcilerService`'s constructor reads `dispatch.retryCeiling` once and holds it in a
field, with a comment explaining why:

> Read once at construction, like the rate-limit floor: the projection is pure and takes
> this as an input, so a value that changed between ticks would make two identical
> observations produce different desired states.
> — `reconciler.service.ts:89-94`

The invariant that comment protects is real and this ADR keeps it: **one tick's
computation must not see two different values for the same key.** What is wrong is the
scope the comment gives that invariant. "At construction" reads the value once for the
entire life of the process — every tick from boot to restart, not just one. But the
reconciler's own class doc already states the actual unit of coherence this system needs:
"a reconciler recomputes from scratch every tick." Nothing about that design requires
`retryCeiling` to agree between tick 100 and tick 101; it requires `retryCeiling` to agree
within the boundary of computing tick 100. Freezing it for the process's lifetime is a
strictly stronger promise than the argument that motivated it actually needs, and it is
exactly the promise that makes `retryCeiling` unable to become a managed key at all: a
value that can only change at boot cannot be edited at runtime by definition.

This ADR supersedes that scope, not that argument: `retryCeiling` (and every managed key
a tick's computation reads) is read once **per tick**, at the top of `runTick()`, and
threaded through everything that tick computes — the same shape `DispatchService.decide()`
already uses for its own clock reading:

> The one clock reading on this path. `decideDispatch` is pure and has no now of its own,
> so every time comparison the decision depends on happens here, against this instant.
> — `dispatch.service.ts:83-86`

**The inconsistency this closes is not hypothetical — it already exists, just not
observably, because nothing today can move the value out from under a running process.**
`reconciler.service.ts:94` freezes `retryCeiling` at construction. `run-summary.service.ts:127`
reads the identical key live, on every call:

```ts
retryCeiling: this.config.get<number>('dispatch.retryCeiling') ?? 3,
```

Today these two call sites always agree, because `ConfigService` never changes underneath
a running process — nothing calls `.set()` for this key, so "frozen at boot" and "read
live" produce the same number for the process's entire life. The moment `retryCeiling`
becomes a DB-editable managed key (points 1–2), that agreement stops being guaranteed by
the absence of any write path and starts depending on how each reader is scoped. Without
this ADR's fix, an admin's `PATCH` would reach `RunSummaryService.postOne()` on its very
next sweep — it already reads per call — while `ReconcilerService` kept quarantining work
orders against the number it read at boot, for however long the process happened to stay
up. Two components disagreeing about how many attempts a work order gets before
quarantine, for an unbounded window, is a real bug this migration would introduce if
`retryCeiling`'s reconciler-side read were left as-is. Making it tick-scoped instead of
process-scoped bounds that disagreement to, at most, one tick interval (60 seconds by
default) — the gap between an operator's edit landing and the next tick picking it up —
which is the entire benefit tick-scoping buys over tallying the value at boot.
`rateLimitFloor`, read in the same constructor by the same pattern, gets the identical
fix for the identical reason; it is not argued separately here because the argument does
not change.

### 5. Always register the interval; gate enablement inside the callback

`ReconcilerTask.onModuleInit()` and `RunPollerTask.onModuleInit()` both currently decide,
once, whether to call `setInterval` at all:

> No interval is registered at all, rather than one that returns early. A disabled
> reconciler that still wakes every 60 seconds to decide it is disabled shows up in every
> profile and every log, and invites the question of whether it is really off.
> — `reconciler.task.ts:98-101`, and the identical argument at `run-poller.task.ts:45-48`

That argument is correct exactly as long as enablement can only change at boot — in that
world, "off" is a fact fixed for the process's entire life, and never registering the
interval is strictly better than registering one that immediately no-ops: zero wakeups,
zero ambiguity. The moment enablement becomes a managed key an admin can flip live, the
argument inverts. `onModuleInit()` runs exactly once, at boot. An interval that is only
ever created there, conditioned on the value _at that instant_, has no way to come into
existence later — a `PATCH` that turns the reconciler on has nothing to turn on, silently,
until the process restarts. The interval's mere presence or absence becomes a **second,
stale copy of the enablement flag**, and the two can now disagree for as long as the
process stays up: exactly the two-sources-of-truth failure this whole ADR exists to close
everywhere else.

This ADR supersedes both comments: **the interval is always registered, unconditionally,
in `onModuleInit()`, and the enablement check moves inside the callback, re-read on every
firing.** This is not a new pattern for this codebase — it is the one the existing `@Cron`
tasks already use, for the identical reason. `SupervisorTask` registers
`@Cron(CronExpression.EVERY_HOUR)` unconditionally at class-definition time
(`supervisor.task.ts:39`) and checks the live value inside the handler:

```ts
if (!this.supervisor.enabled && !this.logSkips) return;
```

— `supervisor.task.ts:46`, reading `this.supervisor.enabled` and `this.logSkips` fresh
every hour, not once at boot.

`ReconcilerTask` and `RunPollerTask` gain the identical shape: `setInterval` is called
every time, and the first statement inside each callback re-reads the (now
`OperatorSettingsService`-backed) enablement key and returns early when it is off — every
firing, not only the first.

**The cost is real and this ADR accepts it rather than hiding it.** A disabled reconciler
now does wake every `intervalMs` to decide it is disabled — the exact overhead the
superseded comments were written to eliminate reappears, and a profile of a deployment
that has never turned the reconciler on will show a periodic no-op callback for a
subsystem nobody is using. That cost buys the only thing that makes "enabled" actually
mean live, rather than "fixed at whatever it was when the process last started" — which is
the entire point of this migration for a boolean managed key.

**This does not settle live period changes.** `reconciler.intervalMs` becoming a managed
key does not, on its own, make a change to it take effect before the process restarts:
`setInterval`'s period is fixed at the call that created it, and always-register-gate-inside
only fixes enablement, not cadence. Reacting to a live interval-length change would require
clearing and re-registering the interval on every observed change — real, additional
machinery this ADR does not build, and a stale interval length is a latency cost, not a
coherence bug on the order of point 4's `retryCeiling`. Left to the implementer as a
follow-on, not decided here.

### 6. The hard spend ceilings become editable — a deliberate, honest downgrade, conditional on the rest of the epic

`hard-spend-ceiling.ts` and `supervisor-spend-ceiling.ts` both refuse `ConfigService` and
`system_settings` explicitly, and both name a settings UI as the threat they are built
against:

> `ConfigService` has a public `set()`. Any code holding the injected instance can raise a
> value that came from `configuration.ts` at runtime... `system_settings` is worse — it is
> a JSONB row an Admin can `PATCH` over HTTP, which is precisely a trust grant reaching
> the limit.
> — `hard-spend-ceiling.ts:13-17`

> The same reason the dispatch ceiling does not [go through `ConfigService`], and it is
> worth restating rather than cross-referencing, because the value is what it protects.
> `ConfigService` has a public `set()`, and `system_settings` is a JSONB row an Admin can
> `PATCH` over HTTP. VISION §8: "a limit an agent can raise is not a limit."
> — `supervisor-spend-ceiling.ts:25-28`

VISION §8 backs both, unconditionally: "Modifying CI workflows, the policy table, or
budget configuration" is never-trustable, "hardcoded, not policy-configurable, regardless
of any grant." This ADR makes both ceilings managed keys anyway, writable through
`OperatorSettingsService`'s admin-gated `PATCH` path. That is not a finding that the two
files above, or VISION §8, were wrong. **Both were right about the risk they were defending
against, and nothing about that risk has changed.** What changes is which guarantee the
codebase relies on to hold it off.

**The guarantee moves from structural to access-controlled, and that is a real
downgrade, named as one rather than smoothed over.** Today's guarantee is structural: no
setter exists anywhere in the running process, for anyone or anything running inside it —
an autonomous proposer, a fully-promoted trust grant, a bug — because there is genuinely
no code path from any of them to this number. A structural guarantee has no failure mode
_inside_ the process, because there is nothing inside it to compromise. The guarantee this
ADR replaces it with is different in kind, not degree: a setter now exists (an admin-only
`PATCH` on the settings endpoint, RBAC-gated the same way `PATCH /api/system-settings`
already is), and the entire claim becomes "the agent provably cannot reach it." That claim
has a failure mode a structural guarantee did not: something that is not a deliberate human
admin action reaching the write path at all. This ADR is only willing to make that trade
because two other pieces of this same epic exist specifically to close that failure mode,
and it says so rather than treating the trade as already safe:

- **#334 (allowlisted agent environment).** If an agent's own execution environment can
  reach whatever holds an admin's live session the way a human's browser does, the ceiling
  is not access-controlled — it is unlocked, and the "provably cannot reach it" claim this
  section rests on is simply false.
- **#346 (refusing non-interactive credentials on the settings write path).** A Personal
  Access Token authenticates "as the user who created it, inheriting that user's roles and
  permissions" and is explicitly built for "automated or non-interactive clients"
  (`docs/personal-access-tokens.md`). An Admin-scoped PAT reaching this endpoint would be
  indistinguishable, in the audit log, from the same admin acting deliberately — and
  nothing about a PAT requires a human to be at a keyboard at the moment it is used. If
  #346 does not restrict this specific write path to interactive, session-authenticated
  requests, an agent legitimately holding an Admin's PAT for unrelated automation could
  raise its own spend ceiling non-interactively, and the access control this section
  describes would exist in name only.

**Both preconditions are named explicitly because either one missing is sufficient to
invalidate this decision, not merely weaken it.** That condition is now satisfied: #334
merged, and #346 merged with `auth/guards/interactive-session.guard.ts` refusing any
credential on the settings write path that cannot prove a human was present, whatever
permissions it carries. #345 is where the migration itself landed — both ceilings resolve
through `OperatorSettingsService`, both follow a change without a restart, and every
change is filed in `audit_events` by the write path that makes it.

The condition this paragraph set is spent, but it is not deleted, because it is the
record of what had to be true before the reversal was allowed to ship. If either barrier
is ever removed, this decision goes with it: the ceilings do not quietly revert to being
merely RBAC-gated, they revert to `process.env` with no setter, which is what
`hard-spend-ceiling.ts` and `supervisor-spend-ceiling.ts` were before and what their
headers describe as the guarantee that was given up. Everything else ADR-0017 decided —
the separate ceiling, the tally scoped to `SupervisorInvocation` only, the separate pure
gate function, the one-day default window, unset-refuses, the between-proposers check
inside `SupervisorService.invoke()` — is untouched by this ADR. Only the _source_ the
value is read from, and the fact that a write path exists at all, changed.

**This creates a new effect this codebase has no name for yet, and closing that gap is
part of implementing this decision, not a later cleanup.** ADR-0013's `Effect` union —
`git-push`, `delete`, `credential-access`, `spend`, `file-write`, `quarantine-clear`,
`trust-grant-write` — has no entry for "write to the ceiling's own configuration," and it
did not need one: there was no reachable code path a `file-write` or any other effect
could describe, because `hard-spend-ceiling.ts` had no setter for anything to call.
`OperatorSettingsService`'s write path is exactly the reachable path ADR-0013 did not have
to model. ADR-0013's own Consequences already say what follows from that: "An effect kind
that is real but not yet modelled in the `Effect` union is not caught, because the guard
can only refuse what it can name." This ADR requires a `budget-config-write` effect
(or equivalently named) be added to `never-trustable.ts`'s forbidden list, covering writes
to `OPIFEX_HARD_SPEND_CEILING_USD` and `SUPERVISOR_HARD_SPEND_CEILING_USD` specifically —
not because this ADR's own design (point 6's access control) should ever let an action
class's `effectsFor` legitimately produce that effect, but because a promotion mistake or
a future executor wired incorrectly is exactly the case `checkNeverTrustable` exists to
catch regardless of what the class registry says, per ADR-0013's own "the guard does not
ask what class an action belongs to" argument. Without this addition, the one write path
this ADR creates for the one thing VISION §8 names by itself ("budget configuration") is
the one write path the never-trustable guard has no name for.

## Consequences

**What this makes harder.** A managed key stops being fully described by grepping
`.env.example` and `configuration.ts`; an operator (or an AI agent reading this repository)
now has to check a database row before concluding what value a running deployment is
actually using for `dispatch.retryCeiling` or any other migrated key. `docs/DEVELOPMENT.md`,
the root `CLAUDE.md`'s Environment Variables section, and `infra/compose/.env.example`
all currently describe these keys as env-only; they now need to say the env value is a
_fallback_, not the last word, for every key this migration actually moves. This ADR does
not perform that documentation update — #333 or a follow-on `docs` change should, and this
paragraph is the flag that it is owed.

**`OperatorSettingsService.get()` lands on a hot path it was not on before.** The
reconciler ticks every 60 seconds by default, the run poller and the supervisor cron fire
on their own schedules, and every one of them now reads at least one managed key on every
firing (point 4's tick-scoping requires exactly this, to keep coherence). If each read is
a database round trip, this migration adds I/O to loops that previously touched only an
in-memory map. Point 4 bounds this to _at most one read per key per tick_ rather than one
per repository or per issue, but it does not specify caching, invalidation, or batching —
left to the implementer, and worth measuring rather than assuming is free.

**The interval-always-registered change (point 5) reintroduces the exact overhead its
superseded comments existed to avoid**, for every deployment that leaves a migrated
subsystem disabled. That is stated plainly in point 5 rather than only implied here: it is
a real, ongoing cost, accepted because a live-editable enablement flag cannot be reconciled
with an interval that only exists when the flag happened to be true at boot.

**Point 6 is a genuine, named narrowing of what VISION §8 currently claims, and VISION.MD
itself is not edited by this ADR.** §8's current text —

> - **Modifying CI workflows, the policy table, or budget configuration**

— states, without qualification, that budget configuration can never be modified by any
grant. After this ADR (and only once #334 and #346 land), that sentence is no longer true:
budget configuration _can_ be modified, by a human admin, through an access-controlled
path. The needed amendment, as specifically as this ADR can state it without editing the
file: narrow that bullet so it forbids budget configuration being modified **by any trust
grant, any promoted action class, or any agent-reachable path**, while permitting it
through the operator's own admin-gated settings write path — i.e., split "modifying CI
workflows or the policy table" (which remain absolutely never-trustable, unchanged) from
"modifying budget configuration outside an interactive, RBAC-gated admin action," which is
the actual boundary this ADR draws. This ADR flags the exact text and the exact correction;
it does not make the edit, per the instruction under which it was written, and the operator
should decide whether the VISION.MD change belongs in this PR or a PR of its own.

**The migration is only as safe as its two preconditions, and this ADR does not build
them.** #334 and #346 are named, not implemented, here; both have since landed, and #345
shipped point 6 on the strength of them. Shipping point 6 before either had landed would
have shipped the exact vulnerability VISION §8's clause exists to prevent, under the
appearance of an access-controlled guarantee that was not actually in force — and the
same is true of any future change that weakens either barrier while leaving the ceilings
writable.

## Alternatives considered

**Leave both hard spend ceilings permanently env-only, forever excluded from the managed-key
migration.** The simplest option, and the one with no new failure mode. Rejected because
it defeats the specific case an operator most wants live control over: an incident where
spend is running unexpectedly high and the fastest available response — lowering the
ceiling right now — is exactly the one action this alternative still requires an SSH
session and a restart for. A permanent exception here is not neutral; it is the single
worst case to leave slow.

**Restrict the write path to lowering the ceiling, never raising it, even for an
authenticated admin.** A tempting middle ground, since VISION §8's own reasoning
("a limit an agent can raise is not a limit") is specifically about raising. Rejected
because it answers the wrong question: the actual threat this ADR's access-control model
defends against is an _agent_ reaching the write path at all, not a _human_ choosing to
raise a number they are entitled to raise. If an agent can reach the endpoint, restricting
the direction does not stop it — it can still lower the ceiling to zero and stand the
factory down, a differently-shaped but still real harm. And if only a human admin can
reach it (the actual guarantee points 6 and #334/#346 are building), restricting a human's
own ability to raise a number they administer solves nothing while making the feature less
useful the one time an operator legitimately under-provisioned it.

**A separate, special-cased break-glass mechanism for the ceilings — a signal to the
process or a CLI flag — instead of routing them through `OperatorSettingsService` at all.**
Keeps points 1–5 untouched by the one exception. Rejected on the same grounds as point 1's
core argument: it is a third read path for exactly the number that most needs to have only
one, and it requires shell or process access an operator using the Settings UI for every
other migrated key would not expect to need for this one. #334 and #346 exist specifically
to make the HTTP path safe for this case; building around them contradicts why they sit in
this epic.

**Coherence scoped per-repository within a tick, rather than per-tick globally (point
4).** Considered because it would read `retryCeiling` closer to the point of use. Rejected:
`reconciler.service.ts`'s own comment already requires the value be identical across every
repository observed within one tick's projection — nothing about it is repository-specific
— so reading it per repository adds N reads for no coherence benefit, and opens a narrower
but real window where repository 1 and repository 40 of the same sweep could observe
different values if a `PATCH` landed mid-sweep. Per-tick is strictly better on both cost
and correctness.

**Event-driven interval management — `OperatorSettingsService` emits a change event,
`ReconcilerTask` subscribes and clears/re-registers the interval on every change (point
5).** Solves both enablement _and_ interval-period liveness in one mechanism, which
always-register-gate-inside does not. Deferred rather than built here: it requires
`OperatorSettingsService` to be an event source, materially more machinery than the defect
being fixed (a flag flip having no effect until restart) needs, and point 5 does not claim
to solve live period changes — only enablement. Worth building later if a live interval
length turns out to matter in practice; not required to close the bug this ADR is fixing.
