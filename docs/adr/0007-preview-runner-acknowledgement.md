# 7. A single-runner fleet may be load-bearing only by explicit operator acknowledgement

- Status: Accepted
- Date: 2026-08-22
- Issue: #147
- Supersedes part of: #64's unconditional preview rule
- Epic: #18

## Context

Registering `claude-code-local` (#147) made a collision visible that neither
piece was wrong about on its own.

VISION §11:

> Every preview runner needs a GA fallback accepting identical work orders.

#64 implemented that literally, and correctly: a runner whose declared
`stabilityTier` is anything but `stable` is ineligible unless some _other_,
`stable` runner could take the same work order.

VISION §3.7:

> Claude Code first, vendor-neutral by construction. Build one runner well.
> Build the seam correctly from day one. **Do not build the second runner until
> it is needed.**

With exactly one runner, a GA fallback cannot exist. So the only runner is
permanently ineligible, and dispatch queues every work order forever. Observed
directly against a real database after registration landed:

```
outcome:     queued
queueReason: only-preview-runners-and-no-ga-fallback
candidates:  [{ runnerKey: claude-code-local, eligible: false,
                unmetNeeds: [], headroom: 2 }]
```

`unmetNeeds: []` and `headroom: 2` — it can do the work and has capacity. It is
refused purely on tier. Phase 4 cannot complete in this state, and neither
VISION section is the one to abandon.

## Decision

**Dispatch may select a preview runner with no GA fallback when, and only when,
the operator has explicitly acknowledged it** — `DISPATCH_ALLOW_PREVIEW_RUNNER`,
compared against the literal `'true'`, defaulting off.

When the acknowledgement is used, the dispatch decision says so in its recorded
reason. Not a log line: the `reason` field that #64 requires be sufficient to
reconstruct the decision without reading code.

The runner's own `stabilityTier` is **not** touched. It stays `experimental`
until something has actually run unattended.

## Consequences

**The invariant that matters survives; the one that cannot hold does not.**
Read as a whole, VISION §11's concern is a fleet becoming _quietly_ dependent on
something its own vendor calls a preview — §8's "never trustable" reasoning, one
level up. An operator who has set an environment variable named
`DISPATCH_ALLOW_PREVIEW_RUNNER` has not done it quietly. What is being kept is
"never _silently_ load-bearing"; what is being given up is "never load-bearing",
which is unreachable for a single-runner fleet by construction.

**Off by default, like every other outward-acting switch here.**
`GITHUB_WRITES_ENABLED`, `RECONCILER_ENABLED` and `CLAUDE_CODE_LOCAL_ENABLED`
all default off and all compare against `'true'`, so unset, misspelled and empty
mean off. A safety rule whose bypass defaults on is not a safety rule.

**The acknowledgement is per-deployment, not global.** The alternative of
softening `isPreview` — routing to preview runners with a warning — would remove
the protection for every future fleet, including one that genuinely has a GA
runner and should never quietly fall back to a preview. Making it a deployment
decision keeps the rule strict where it can be kept.

**It is recorded on the decision, not just in configuration.** A queue reason an
operator can read six weeks later is the difference between "why did this run on
the experimental runner" being answerable and not. VISION §5's point about
provenance applies to routing decisions as much as to commits.

**The tier does not get promoted to buy the same effect.** That was the tempting
shortcut and it is the wrong one: `stable` would be a claim about maturity that
nothing has demonstrated, and VISION §12 makes the observation week the gate for
exactly that judgement. A false tier would also silently re-arm the rule for a
future second runner — a preview runner would then find a "GA fallback" that was
never GA. Lying in the manifest to satisfy a policy that reads the manifest is
the failure mode #61 spent three PRs avoiding.

**This is expected to be temporary.** When a second, genuinely GA runner exists
(#23 territory), the acknowledgement stops being load-bearing and should be
turned back off. It is not a permanent widening of the rule, and the
configuration comment says so.

## Alternatives considered

**Promote `stabilityTier` to `stable` or `beta`.** One line, no new
configuration. Rejected above: it asserts maturity nothing has demonstrated and
corrupts the manifest that policy reads.

**Make the preview rule a warning rather than a refusal.** Simplest code, no
configuration. Rejected because it weakens the rule for every deployment
forever, including ones where it should bite — a fleet with a real GA runner
would quietly fall back to a preview under load, which is exactly the scenario
VISION §11 is about.

**Leave the runner refused until a second runner exists.** Correct by the letter
of §11. Rejected because §3.7 forbids building that second runner yet, so this
is a deadlock rather than a decision, and it leaves Phase 4 unable to complete
for a reason that is an artifact of two rules meeting rather than a real risk.
