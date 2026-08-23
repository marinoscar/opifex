# Worked examples — `run-event.schema.json`

Every file here validates against `../../run-event.schema.json`, enforced by
`apps/api/test/schemas/run-event.schema.spec.ts`. They are examples in the
strict sense: if the schema changes so that one of these stops validating,
that is a breaking change and the test says so.

## `streaming-*` — `claude-code-local`

A full-fidelity runner. It reports its own start, heartbeats, per-tool
progress with a signature, structured blocks with a reset time, and cost on
individual events.

Read `streaming-run-progress-with-tool.json` first: the `tool.signature` field
is what loop detection (#55) compares, and it is a **digest** rather than the
raw arguments — arguments can be enormous and can contain secrets, and loop
detection only ever tests them for equality.

## `nonstreaming-*` — `claude-code-cloud`

The contrast, and the reason both sets exist. VISION §6 states plainly that
**equal observability across vendors is not achievable**; a common floor that
some runners exceed is. These files are what the floor looks like from
underneath.

Note what is **absent**, not just what is present:

- no `run.heartbeat` at all — nothing is streaming
- no `tool` on progress, so #55's loop detection is _unavailable_ for this
  runner and must say so rather than appearing to pass
- no per-event `cost` — and absent means **not reported**, which is not the
  same as zero (VISION §6 makes cost reporting a declared capability)
- progress and completion are `source: git-derived`, inferred by the watcher
  in #52 from a commit landing and a pull request opening

A runner like this is still supervisable. It is supervised more coarsely, and
the `source` field is what makes that visible instead of silent.

## `synthesized-run-failed.json`

The third `source`. Opifex concluded this, no runner said it, and the event
says so in the one field a watchdog must never have to guess at.

VISION §9: _a synthesized event must never masquerade as a report._ Its
`summary` and `failure.reason` name the threshold and the observed age, so the
conclusion can be checked rather than taken on trust — the same rule the
reconciler's action reasons follow.
