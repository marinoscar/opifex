# 19. A fresh install ships ready, not running — five defaults flip on, the hard spend ceiling stays off

- Status: Accepted
- Date: 2026-08-28
- Issue: #439
- Supersedes part of: ADR-0007's "off by default, like every other outward-acting switch here"

## Context

Every outward-acting switch in the operator-settings registry defaulted off, on
one shared argument: VISION §8's "an unsupervised agent with no spend ceiling
is the failure mode that turns a productivity tool into a bill." Four
different flags each stood guard over a piece of that fear —
`runners.claudeCodeLocal.enabled` (the runner may spawn processes),
`dispatch.enabled` (the queue may act), `dispatch.allowPreviewRunner` (a
preview-tier runner may be load-bearing), `github.writesEnabled` (Opifex may
write to GitHub) — and VISION §12 built an entire roadmap phase, and a
runbook, around the state where all four are off: "Reconciler, read-only.
Observe and mirror labels. No dispatch. Run for a week."

#439 examined each of the four individually and found each one was not
actually doing the job it was standing in for.

**`dispatch.allowPreviewRunner` is unsatisfiable by construction, not a
safety rule an operator chooses to accept.** ADR-0007 already established
this: VISION §11 requires every preview-tier runner to have a GA fallback
accepting identical work orders, and Opifex ships exactly one runner,
`claude-code-local`, declared `experimental`. No deployment shipped today can
ever produce a second, GA runner to satisfy that rule — there is nothing to
configure that would make it pass. A rule no configuration can satisfy is not
protecting anything; it is an off switch wearing a safety rule's clothes,
and its cost is not hypothetical — every work order queues forever behind
it. ADR-0007 turned the bypass into a per-deployment acknowledgement
(`DISPATCH_ALLOW_PREVIEW_RUNNER`); leaving that acknowledgement itself off by
default reproduces the exact paralysis ADR-0007 was written to relieve, on
every fresh install, for a condition every fresh install is already in.

**The two-step enable is a one-time check, charged forever.** Flipping
`runners.claudeCodeLocal.enabled` before `dispatch.enabled` — in that order —
lets an operator watch the runner register honestly before anything is
routed to it. That is genuinely useful exactly once, the first time it is
done on a given deployment. Requiring both flags to start off, so that every
operator must perform the same two-step dance before the factory can do
anything at all, spends that verification's cost on every boot rather than
on the boot where it pays for itself.

**The observation-week default hid #432 rather than preventing it.** Writes
being off by default was meant to buy a safe window to notice mistakes
before they reached GitHub. In practice, a release path that never removed
`factory:hold` sat completely undetected for exactly as long as writes
stayed off — an observation week that observes nothing behaving exactly like
one that observed everything and found no problems. It was found by reading
the code, not by running it. A safety net that cannot be told apart from
silence is not doing the job its name promises.

**The specification itself was incomplete, and that is part of what this ADR
records.** #439 as filed named four flags: the runner, dispatch, the
preview-tier acknowledgement, and GitHub writes. `ReconcilerTask.runOnce`
gates the entire reconcile loop on a fifth, `reconciler.enabled` — its own
comment says plainly that "dispatch, spec feedback and the dispatch drain all
hang off this method." Flipping the other four while this one stayed off
would have shipped a fresh install exactly as inert as before, with the
reason relocated from four flags to one rather than removed. The discussion
on #439 was amended once this was noticed; the four originally named still
carry the arguments above, and the fifth carries its own, stated in the
Decision below.

None of this removes the hazard VISION §8 is guarding against — it relocates
which mechanism is trusted to guard it. `dispatch.hardSpendCeilingUsd`
(ADR-0018 §6) is a ceiling, not a proxy for one: `decideSpendAdmission`
refuses every dispatch while it is unset, not merely most of them, and no
trust grant, promoted action class or agent-reachable path can raise it —
only a signed-in admin, interactively, on the record. The four (five) flags
were never the thing standing between a fresh install and spending money;
the ceiling always was, and it was sitting unused behind proxies that each,
individually, cost more than they protected.

## Decision

**Five operator-setting defaults flip from `false` to `true`:**
`runners.claudeCodeLocal.enabled`, `dispatch.enabled`,
`dispatch.allowPreviewRunner`, `github.writesEnabled`, and
`reconciler.enabled` — declared in
`apps/api/src/settings/operator-settings/operator-settings.registry.ts`.
`dispatch.hardSpendCeilingUsd` keeps its existing default of unset, and stays
the only thing that refuses: `decideSpendAdmission`
(`apps/api/src/budget/spend-admission.ts`) and `HardSpendCeilingService`
(`apps/api/src/budget/hard-spend-ceiling.ts`) both treat an unset ceiling as
"no limit configured," which blocks every dispatch rather than permitting
unlimited spend.

**A fresh install is therefore ready, not running.** The reconciler observes
GitHub, the runner registers, the dispatch queue drains its decisions,
GitHub writes are permitted where a repository has opted in — and no run
starts, and no dollar is spent, until an operator states a figure. That
posture is asserted directly, as five literal expectations rather than
values derived from the table being checked, in
`apps/api/test/governing/fresh-install-cannot-spend.spec.ts`.

**The fifth flag is not a footnote.** #439 named four; `reconciler.enabled`
is the one whose absence would have made the other four's flip
inconsequential. This ADR is the decision for all five, and treats
undercounting them in the original issue as a finding worth recording, not
a detail to quietly correct in the implementation and leave the historical
issue looking complete.

## Consequences

**GitHub writes are permitted the moment a repository opts in, and each
repository still opts in on its own.** `github.writesEnabled` on means the
global kill switch no longer holds every write back — but
`Repository.mirrorLabelsEnabled`, `.specFeedbackEnabled` and
`.dispatchEnabled` are unrelated, per-repository flags that each still
default `false` (`apps/api/prisma/schema.prisma`), and nothing is written to
a given repository until that repository is individually turned on. The
observation week's protection has moved, not vanished: it used to be one
global flag every deployment shared, and it is now a flag an operator sets
per repository — which is exactly the flag an operator is already reaching
for the moment they are keen enough about a specific repository to opt it
in.

**VISION §12's observation week is now opt-in, and that is a real reduction
in safety-by-default — stated as one, not reframed as equivalent.**
Previously, an operator got a read-only week for free, by doing nothing.
Now, an operator who wants that week must turn `github.writesEnabled` off
deliberately; doing nothing gets real writes to whatever repository has been
opted in. This is a strictly weaker default than the one VISION §12
describes, and the roadmap section is amended in `VISION.MD` to say so
rather than to quietly redefine what "the default" means.

**The hard spend ceiling protects money. It does not gate GitHub's outward
effects at all.** `decideSpendAdmission` is reached only from dispatch — a
repository with `mirrorLabelsEnabled` on will have Opifex write mirror
labels to it on the very first tick after registration, with no ceiling in
force and none required, because writing a label spends nothing that a
dollar figure bounds. Anyone reading this ADR for reassurance about what the
ceiling covers should read this paragraph twice: it is a budget control, not
a general-purpose kill switch, and presenting it as the latter would be
exactly the "appearance of guardrails and none of the substance" VISION §8
warns against.

**ADR-0007's preview-runner rule is unchanged; its bypass now ships
enabled.** The rule itself — no preview-tier runner may be load-bearing
without a GA fallback, or without the acknowledgement — still lives in
`dispatch.service.ts` exactly as ADR-0007 left it, and regains its bite the
moment a second, GA-tier runner exists: at that point `isPreview` again has
a real fallback to check against, and an operator who wants the strict rule
back turns `dispatch.allowPreviewRunner` off. What changed is only which
side of the switch a fresh install starts on. `docs/adr/0007-preview-runner-acknowledgement.md`
carries its own supersession note pointing here.

### The boolean fallback direction reversed, and that is the transferable lesson

`booleanSetting`'s parser used to accept exactly `'true'` and `'false'`,
case-sensitively, and fall back to the declared default for anything else.
While every one of these flags defaulted off, that was fail-safe by
accident: a typo, an unrecognised word, an empty string all fell back to
`false`. The moment these five defaults flip to `true`, the same fallback
rule becomes fail-_dangerous_ — `GITHUB_WRITES_ENABLED=no`, written by
someone stating a clear and correct intention to keep writes off, would have
been discarded as unreadable and resolved to the new default, `true`, while
the operator read their own `.env` file and believed the opposite of what
was actually running.

This branch closes that specific hole by widening what `booleanSetting`
accepts — `1`/`0`, `yes`/`no`, `on`/`off`, case-insensitively, trimmed — so
that every spelling a person is likely to type unambiguously is honoured
rather than discarded, and logs a genuinely unreadable value (`'enabled'`,
`'2'`, `'maybe'`) at `error` rather than `warn`, naming both the value that
was rejected and the value now in force. See the `BOOLEAN_WORDS` map and its
doc comment in `operator-settings.registry.ts`.

The lesson is worth keeping past this one fix: **flipping a default can
invert a safety property that lives somewhere that looks unrelated to the
flip itself.** Nobody changed the boolean parser as part of deciding these
five defaults should be `true`; the parser was already there, already
shipped, and had always resolved an unreadable value to "the default,"
which had always meant "off" until the moment it didn't. #441 tracks the
same hazard in the three places this branch did **not** fix —
`dispatch.maxConcurrent`, `runners.claudeCodeLocal.permissionMode` and
`github.apiBaseUrl` all still resolve a malformed value to a default whose
safety was never audited against the possibility of that default itself
being on the dangerous side. It is filed and unfixed; this ADR does not
close it.

## Alternatives considered

**Leave all five defaults off (the status quo).** Rejected on the arguments
in Context: it keeps `dispatch.allowPreviewRunner` an unsatisfiable rule
rather than an honest bypass, keeps charging every operator the two-step
enable's cost forever instead of once, and the observation week it produces
had already been shown, by #432, not to catch what it was supposed to catch.

**Flip the readiness flags (`runners.claudeCodeLocal.enabled`,
`dispatch.enabled`, `reconciler.enabled`) but leave `github.writesEnabled`
and `dispatch.allowPreviewRunner` off.** This would leave the preview-runner
deadlock exactly where it stood: with a single runner and no acknowledgement,
`dispatch.enabled` being on changes nothing, because every work order still
queues forever behind `only-preview-runners-and-no-ga-fallback`. A "ready"
posture that cannot actually dispatch anything is not the state this
decision is trying to reach.

**Flip the five defaults and also ship a default dollar figure for
`dispatch.hardSpendCeilingUsd`.** Considered and rejected on the record: a
default ceiling is a guess about somebody else's budget, and no figure
Opifex could pick is more defensible than refusing to guess.
`apps/api/test/governing/fresh-install-cannot-spend.spec.ts` asserts the
ceiling's default is the empty string precisely so this alternative cannot
silently return — an install that is ready to act everywhere except where
money is at stake is the entire point, not a compromise it settles for.

**Promote `claude-code-local`'s `stabilityTier` to `stable` instead of
defaulting the acknowledgement on.** Already rejected in ADR-0007 for the
same reason it would be wrong here: it asserts a maturity the runner has not
demonstrated, corrupts a manifest that policy reads, and would silently
re-arm the preview rule for a future second runner that finds a "GA
fallback" that was never actually GA.
