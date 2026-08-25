# 16. The live-run ceiling is removed; the quota gate keeps only the parked-run signal

- Status: Proposed
- Date: 2026-08-25
- Issue: #260
- Epic: #21

## Context

ADR-0015 moved the supervisor's model calls onto `SUPERVISOR_MODEL_API_KEY`, a separately
metered Anthropic credential, away from the interactive subscription `claude-code-local`
authenticates with. That decision made a factual claim in `quota-gate.ts` false — the file's
own header used to justify the gate with VISION §7's "It consumes the same quota as the
workers, and a supervisor competing for the quota it is managing is a bad loop" — and ADR-0015
corrected it for both arms of the gate, with very different results.

**The parked-run arm** (`standDownWhenBlocked`) got a replacement reason that does not depend on
shared budget at all: a run parked on a rate limit is evidence that everything the supervisor
exists to advise about has stopped moving, and a diagnosis nobody can act on is worth waiting
for. That argument is unaffected by whose budget the supervisor spends from. It needs nothing
revisited here, and this ADR does not touch it.

**The live-run ceiling** (`liveRunCeiling`) did not get an equally solid replacement. Before
ADR-0015, `quota-gate.ts`'s header claimed the supervisor's "marginal call is more likely to be
the one that tips a worker into parking," and the verdict the gate _returned_ — logged output an
operator reads, not a code comment — said "The supervisor yields the shared quota to the
workers." ADR-0015 withdrew both sentences as false (its first draft had asserted the ceiling
"does not depend on shared budget and needs no change," which was itself wrong and corrected in
the same document) and replaced them with: "There is little worth diagnosing while that much is
still in flight." The implementer flagged that replacement rather than defending it: **many live
runs means work is proceeding**, which is close to the opposite of the parked case's "work has
stopped," so "little worth diagnosing" is a judgement call sitting where a fact used to be, and
a reasonable person could argue the opposite — that a busy factory is exactly when a stall is
most expensive to miss.

That makes this the second time the ceiling's justification has been rewritten without anyone
deciding whether the ceiling itself should exist: once implicitly, when ADR-0015's first draft
assumed no change was needed and had to correct itself within the same document, and once
explicitly, in the replacement sentence above. `quota-gate.spec.ts` had **no assertion on the
ceiling's reason string at all** until ADR-0015 added one — which is how a false sentence about
yielding shared quota sat in logged output, untested, for as long as the ceiling existed before
that test was written. A control whose stated reason keeps being patched without the control
itself being reconsidered is the thing this ADR exists to stop happening a third time.

The field defaults to `null` — no ceiling — and always has. Nothing in a running deployment
fires on it today unless an operator has explicitly set `SUPERVISOR_LIVE_RUN_CEILING`. That is
exactly why this is the moment to decide: removing a control nothing depends on today costs
nothing; discovering years from now that an operator built an operational habit around a
`SUPERVISOR_LIVE_RUN_CEILING=4` that was never independently justified, and asking the question
then, costs a great deal more.

## Decision

**`liveRunCeiling` is removed from the quota gate.** `QuotaGateConfig` keeps exactly one field,
`standDownWhenBlocked`; `assessQuota` no longer accepts or checks a live-run count; the "little
worth diagnosing while that much is still in flight" branch and its reason string are deleted
along with it. The parked-run arm — same field, same default (`true`), same reasoning, same
tests — is untouched.

### The config key is removed, not silenced

`configuration.ts`'s `supervisor.liveRunCeiling` field is deleted, and `SUPERVISOR_LIVE_RUN_CEILING`
is removed from `.env.example`. An operator who has this variable set in a real `.env` — a small
population, since the default has been off since the key existed — must not have it silently do
nothing. The implementation must log a one-time warning at boot naming the variable, saying it
has no effect as of this ADR, and pointing at this file, the same standard
`hard-spend-ceiling.ts` already holds itself to for a malformed ceiling: "a safety limit nobody
can see the state of is one an operator will assume is working." An unset value — the default,
and the overwhelming majority of deployments — needs no message; there is nothing to warn about.

## Consequences

### The deciding argument: neither surviving rationale survives contact with what the code counts

Two rationales were live candidates for keeping some version of the ceiling — #260's option B (a
cost control on the supervisor's own metered spend) and option C (a freshness argument: a
diagnosis written mid-flight is stale by the time anyone acts on it). Both treat `runsRunning` —
the only count `assessQuota` is actually given, via `Pick<SnapshotTotals, 'runsBlocked' |
'runsRunning'>` — as a stand-in for something it does not measure.

**B does not hold as a cost control, because `runsRunning` has no established relationship to
what an invocation spends.** `SupervisorService.invoke()` (`supervisor.service.ts:133-150`) runs
every registered proposer exactly once per tick that is not stood down, regardless of how many
runs are `running`. The one proposer whose call count is itself capped —
`RunDiagnosisProposer.MAX_PER_INVOCATION`, three — caps against
`diagnosable(context.state.attentionRuns)`, which is runs that are stalled, blocked, or
quarantined: a different count from `runsRunning` entirely. A factory with fifty runs live and
nothing stuck spends exactly what a factory with two runs live and nothing stuck spends on that
tick — one call per proposer, and zero from `run-diagnosis` either way, because there is nothing
in `attentionRuns` to diagnose. Gating the whole invocation off on `runsRunning` does reduce
total spend over time in the trivial sense that a skipped tick spends nothing, but it does so by
suppressing ticks during precisely the condition — much of the factory healthy and running —
that has the least call volume to suppress in the first place. If dollars are the actual
concern, #260's own text already names the honest mechanism: a real spend ceiling, on dollars
over a rolling window, in the shape `hard-spend-ceiling.ts` already establishes — not a proxy on
a count the spend does not track.

**C fails for the same underlying reason, stated differently.** "A diagnosis written against a
factory mid-flight is stale by the time anyone acts on it" is an argument about `attentionRuns`
— the runs actually being diagnosed — going stale while the model call is in flight, not about
`runsRunning`. A diagnosis of a run that has been stalled for six hours does not go stale
because fifty _other_, healthy runs happen to be running at the same moment. If anything, the
busy-factory case is when a missed stall is most expensive, which is what #260 itself observes
and which C has no answer for.

Checked against `SnapshotTotals` rather than taken as plausible-sounding English, both
rationales reduce to the same mistake: `runsRunning` is a proxy for "the factory is busy," and
"the factory is busy" is not evidence about spend, staleness, or anything else the ceiling could
legitimately stand down for. The parked-run arm survives this scrutiny precisely because it does
not use `runsRunning` at all — `runsBlocked > 0` is a direct fact that work has stopped, not a
proxy for one.

### #261 does not change the conclusion — it only removes B's last argument

#260 ties the decision to #261, whether a real spend ceiling on the supervisor's own metered key
ever lands. It does not need to. Even if #261 never lands, `runsRunning` is still the wrong
quantity to gate on, because it does not correlate with what a tick costs — see above. If #261
does land, it removes the one thing B's restatement had to point at ("the supervisor now spends
real dollars") without ever closing the mismatch between what the ceiling counts and what it
would need to count to bound spend, and a genuine spend ceiling is a strictly better answer to
that concern than a run-count proxy raised for the same purpose, because it bounds the thing it
claims to bound. Either way the live-run ceiling loses; #261 changes _how_ it loses, not
_whether_.

This is the one place this ADR's author disagrees with the framing it was handed: the
instructions for this document read the choice as turning on whether #261 lands. It does not —
the run-count-as-cost-proxy argument is refutable today, from the code as it stands, independent
of any future ceiling. #261 remains worth building on its own merits (VISION §8's hard ceiling
covers dispatch spend, not the supervisor's), but its outcome is not load-bearing for this
decision.

### A control rewritten twice, closed here

The live-run-ceiling reason has been stated three times: the original ("yields the shared quota
to the workers"), ADR-0015's replacement ("little worth diagnosing... still in flight"), and —
this ADR — removed rather than restated a third time. The first was falsified by ADR-0015's own
decision. The second was never independently argued for; it appears in ADR-0015's Consequences
in the same paragraph that withdraws the first draft's claim that no change was needed, reading
like the sentence left standing once the false one was struck rather than one chosen on its own
merits. A third rewrite, absent this ADR, would repeat exactly that pattern: a plausible
sentence adopted because the previous one had to go, with no test asking whether the new one is
actually true.

### Test note

Removing `liveRunCeiling` removes every `quota-gate.spec.ts` test keyed to it: the default,
the "at the ceiling, not one past it" boundary case, "never stands down... when unset," the
"does not claim to yield anyone quota" reason-string assertion, and "reports the parked reason
first when both conditions hold" (which no longer has two conditions to choose between). What
replaces them is not a smaller version of the same suite — it is one assertion that
`QuotaGateConfig` and `DEFAULT_QUOTA_GATE` no longer expose the field at all, so a future PR
that reintroduces a `liveRunCeiling`-shaped knob has to do so as a new, argued decision rather
than a config field quietly restored because no test noticed it was gone. The parked-run tests
are untouched; they were never about the ceiling.

If a future ADR reintroduces a run-based or spend-based throttle, the lesson from this one is
concrete and should carry forward: whatever reason string it logs needs a test asserting the
_content_ of the claim, not merely that a non-empty reason is present — a non-empty-string
assertion already existed here (`'always states a reason when it stands down'`) and it was not
enough to catch the false sentence it sat beside for as long as it did.

### What would justify re-adding a throttle here

Removing a control is a real loss, not a cleanup, and re-adding one later should not happen on
the same unexamined footing it is being removed on now. What would justify it: observed evidence,
once the supervisor is running in Observe mode with a metered key (VISION §7's promotion ladder,
#99), that spend per tick or per day materially increases under some specific, identifiable
condition — not "the factory is busier" in the abstract, but a measured correlation between a
signal and dollars that a ceiling on that signal would actually bound. If the signal turns out
to be "many runs are live," the analysis above would need to be wrong about `runsRunning` not
driving spend, and that is only knowable from real invocation data, not from re-reading this
file. If the signal is dollars directly, the answer is #261's spend ceiling, not a resurrected
`liveRunCeiling`. "We do not currently know whether this was needed" is not evidence for
re-adding it; a specific, named cost or staleness incident that a `runsRunning`-based gate would
have caught, and that nothing else would have caught more directly, is.

### Sites that still carry the falsified claim, found while researching this ADR

Removing the field touches more than `quota-gate.ts`, `configuration.ts`, and `.env.example`.
Two further sites still state the pre-ADR-0015 "shared quota" claim, which ADR-0015 believed it
had already swept up and did not. Neither is new to this ADR, but the implementation of this ADR
is a reasonable place to finish that cleanup rather than leave a fourth site to be found later:

- `SupervisorService`'s class doc comment (`supervisor.service.ts:50-52`) still reads: "**Yields
  quota.** Before doing any work it asks `assessQuota` whether workers are already parked, and
  stands down if they are. That is VISION §7's 'a supervisor competing for the quota it is
  managing is a bad loop', made into a branch." That is the pre-ADR-0015 framing, unchanged, and
  it will read stranger once `liveRunCeiling` is gone and the gate has only ever had one thing
  to "yield" on — a fact, not a competition.
- VISION.MD §7 itself still reads, unchanged: "It runs on a small model, on a schedule — not
  per-event. It consumes the same quota as the workers, and a supervisor competing for the quota
  it is managing is a bad loop." (lines 360–361). The sentence ADR-0015 made false in the code
  was never corrected in the document the code cites as its source.
- `run-diagnosis.proposer.ts`'s `MAX_PER_INVOCATION` doc comment (line 43) still says an
  invocation "spends the quota VISION §7 says the workers should get first" — the same claim, in
  a third place.

`.env.example`'s `SUPERVISOR_LIVE_RUN_CEILING` comment (lines 561–562, "Set it when the
subscription is tight enough that a marginal supervisor call is what tips a worker into
parking") carries the same falsified claim, but is moot once the variable is removed rather than
a fourth site needing its own fix.

### The parked-run arm is untouched

To state plainly what does not change: `standDownWhenBlocked` keeps its field, its default
(`true`), its reason (a parked run is evidence work has stopped), and its tests, unmodified. This
ADR narrows the gate to the one signal that survived ADR-0015 on its own terms; it is not a
smaller gate for its own sake.

## Alternatives considered

**B — keep it, restated as a cost control on the supervisor's own metered spend.** The
restatement is not merely "a different control wearing the same name," as #260 itself
anticipated as the weak point — checked against what `assessQuota` actually receives,
`runsRunning` does not correlate with what a tick spends. See "The deciding argument" above. If
cost is the real concern, a spend ceiling is the honest mechanism, and it belongs to #261, not to
a repurposed run-count field.

**C — keep it, restated as a freshness argument.** The weakest of the live options, and where
#230 landed only because nothing else was left standing after the shared-quota claim fell. It is
unevidenced, and it argues for standing down at the exact moment — a busy factory — that #260
itself observes is when a missed stall is most expensive. See "The deciding argument" above; the
same `attentionRuns`-versus-`runsRunning` mismatch applies.

**D — leave it as ADR-0015 left it.** Leaves a gate with a justification nobody has
independently defended, in the one component whose entire purpose is producing reasoning a human
can check — and leaves `quota-gate.spec.ts`'s reason-string test asserting a sentence that is
honest about not claiming to yield quota but still asks a reader to accept "little worth
diagnosing" as a settled fact rather than the judgement call it is. Rejected because a third
rewrite without an argued decision is the exact failure this ADR exists to stop.
