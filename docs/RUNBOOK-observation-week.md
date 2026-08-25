# Runbook: turning Opifex on, and the observation week

VISION §12 requires the reconciler to run **read-only for a week**, recording what
it _would_ have done, before it is allowed to do anything. This is how you start
that week, and what to read while it runs.

It also closes the exit criteria on epics **#16** and **#17** that no amount of
code can close: _"detection latency is measured, graphed, and in seconds"_ and
_"a notification reaches a phone."_ Those are observations, not features.

> **Nothing here writes to GitHub.** `GITHUB_WRITES_ENABLED` defaults to `false`
> and every write adapter returns `performed: false` without issuing a request.
> The one thing that _does_ leave the building is a push notification to your own
> phone.

---

## Before you start

You need:

|                                                  | Why                                                              |
| ------------------------------------------------ | ---------------------------------------------------------------- |
| A GitHub token with `repo` read scope            | The reconciler reads issues, labels, commits, PRs and check runs |
| A PostgreSQL 16 database                         | Migrations are applied on deploy                                 |
| A phone that can open the cockpit over **HTTPS** | Web Push refuses to subscribe on a plain-HTTP origin             |
| Google OAuth credentials                         | See the papercut below — you need them even if nobody logs in    |

### Papercut: Google credentials are required to boot (#138)

The API will not start without `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`,
even for a headless control plane that nobody logs into:

```
ERROR [ExceptionHandler] TypeError: OAuth2Strategy requires a clientID option
```

Until #138 is fixed, set them. Real values if you want to log in; any non-empty
string if you do not.

---

## 1. Configure

Copy the template and fill it in:

```bash
cp infra/compose/.env.example infra/compose/.env
```

Generate the Web Push key pair — no account, no third party, one command:

```bash
npx web-push generate-vapid-keys
```

The settings that matter for this week:

```bash
# Read GitHub. Write nothing.
GITHUB_TOKEN=ghp_...
GITHUB_WRITES_ENABLED=false      # leave it false for the whole week

# The control loop. This is the switch you are here to flip.
RECONCILER_ENABLED=true
RECONCILER_INTERVAL_MS=60000
RECONCILER_LOG_RETENTION_DAYS=14 # longer than the week, on purpose

# Reach your phone.
VAPID_PUBLIC_KEY=...             # from the command above
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:you@example.com

# See the traces. Optional.
OTEL_ENABLED=true
```

**Retention is 14 days deliberately.** A one-week window pruned at seven days is
half-gone on the day you sit down to review it.

---

## 2. Start it

```bash
cd infra/compose
docker compose -f base.compose.yml -f dev.compose.yml up -d

# With traces and metrics (Uptrace at http://localhost:14318):
docker compose -f base.compose.yml -f dev.compose.yml -f otel.compose.yml up -d
```

Confirm the loop registered — this line is the whole point:

```
LOG [ReconcilerTask] Reconciler tick registered every 60000ms
```

If instead you see `Reconciler is DISABLED`, `RECONCILER_ENABLED` is not the
literal string `true`. The comparison is deliberately strict, so an unset,
misspelled or empty value all mean off.

You should also see, if you have not set the VAPID keys:

```
WARN [WebPushTransport] Web Push transport is NOT configured (...). Escalations
will be recorded and will NOT reach a phone.
```

That warning is the design working. An unconfigured install announces itself
rather than going quiet.

---

## 3. Create the label taxonomy

`.github/labels.yml` is the declaration; nothing applies it on its own. Until it
is applied, **the eight `factory:*` / `factory/*` labels do not exist on the
repository** — and a label that does not exist cannot be put on an issue, so
nothing can ever carry `factory:ready`, and the reconciler correctly computes
zero actions on every tick, forever. That is how the first attempt at this week
produced 302 empty ticks (#195).

```bash
node scripts/sync-labels.mjs                  # what is missing or drifted
node scripts/sync-labels.mjs --apply          # create and update
node scripts/sync-labels.mjs --repo owner/name --apply
```

Checking is the default; writing needs `--apply`. It **never deletes** a label
it does not recognise — removing one strips it from every issue that carries it,
and the file cannot restore that.

This is operator setup, not factory behaviour, so it is deliberately outside
`GITHUB_WRITES_ENABLED`. Gating it on that switch would mean the observation
week could not be set up without turning on the writes it exists to withhold.

### `needs:*` and `tier:*`: routing labels, not part of this taxonomy

Two more label families change what happens once a work order exists:
`needs:*` (#64) and `tier:*` (#273). Unlike `factory:*` / `factory/*` above,
**neither is declared in `.github/labels.yml`**, so `sync-labels.mjs` will not
create them — an operator has to add them to the repository by hand before
applying one to an issue. They are also read independently of the
`factory:` input-label machinery: a `needs:` or `tier:` label never appears in
an issue's `inputLabels`, and a misspelled one never appears in
`unknownInputLabels` either, because that list only tracks the `factory:`
prefix. The reasoning below is transcribed from the `readNeeds` and
`readModelTier` doc comments in
`apps/api/src/work-orders/issue-projection.ts`.

**`needs:*` — what the work requires of a runner, matched against advertised
capabilities (#64):**

- `needs:full-streaming` — the run must be observable per tool call; loop
  detection (#55) needs it.
- `needs:cost-reporting` — the runner must report cost, or budget enforcement
  is meaningless.
- `needs:structured-rate-limits` — the runner must report rate limits
  structurally, so a parked run can carry a dated resume.
- `needs:own-infrastructure` — the work must not leave the operator's own
  infrastructure.

An issue may carry any combination of these four; each one is additive and
narrows the set of eligible runners to those advertising it. None is implied
by another.

**`tier:*` — the class of model the work order asks for, a size rather than a
vendor name (#273):**

- `tier:small` — mechanical acceptance criteria, no real reasoning needed.
- `tier:standard` — the default weight of reasoning.
- `tier:large` — the work needs real reasoning.

A label was chosen over a template field, a spec-quality judgement, or a
per-repository setting because it is legible where the operator already is,
set deliberately, and read as a set-membership test — the same reasoning
`needs:` already established, and putting a judgement about model size in the
hot path is exactly what VISION §3.6 warns against.

How `readModelTier` resolves the label set on an issue:

- **No recognised `tier:` label** — the work order carries no tier and the
  runner supplies its own default. That is what every issue gets today, since
  no repository yet applies these labels.
- **Exactly one recognised `tier:` label** — that tier is used.
- **Two or more recognised `tier:` labels on the same issue** (e.g.
  `tier:small` and `tier:large` together) — treated as **no tier at all**, the
  same outcome as none being present. Not largest-wins, not smallest-wins:
  - picking the largest spends more than anyone asked for, and VISION §3.5
    gates on cost;
  - picking the smallest silently downgrades work that may have needed the
    reasoning, or — if the fleet has no matching runner — parks the work order
    behind a constraint nobody chose;
  - rejecting the issue was the tempting third option, because the
    spec-feedback path would tell the author, but that path dedupes on the
    issue body's digest, and a label conflict never changes the body — so a
    second mistaken label pair would be met with silence, same as the first.
  - Falling back to the default is the only rule that cannot stall work or
    spend money on a guess.

**An unrecognised value in any of the three families is surfaced, not silent
(#297, #305).** A typo (`needs:telemetry`, `tier:huge`, or an unrecognised
`factory:` value) is classified by `classifyIgnoredLabels`
(`apps/api/src/github/labels/ignored-labels.ts`) and folded into that issue's
`reason` on every tick — visible in the tick log (§6) whether or not any write
flag is on, the same as every other computed finding during the observation
week. It still does **not** count toward `unknownInputLabels` (that field
stays `factory:`-only, per its own name); the classifier's output is a
separate field, `ignoredLabels`. Once mirror labels are enabled for the
repository (§7 stage 1), the same finding is also written to GitHub as the
`factory/label-ignored` mirror label — one label covering all three families,
because the offending label is sitting two labels away on the same issue, and
the precise family, kind, and offending names are in the `reason` and the
action evidence instead of the label itself.

**Do not confuse either family with `factory:*` or `factory/*`:**

- `factory:*` (`factory:ready`, `factory:hold`, `factory:clear-quarantine`) is
  a **closed vocabulary of three human intents** the reconciler obeys. It
  decides whether a work order is created or held at all — nothing about what
  the work needs once it exists.
- `needs:*` and `tier:*` are **routing input** read while a work order is
  generated. They decide which runner and which model class handle the work,
  never whether it happens.
- `factory/*` **mirror** labels (`factory/dispatched`, `factory/blocked`,
  `factory/review`, `factory/quarantine`, `factory/label-ignored`) are written
  **by** Opifex for visibility only — `.github/labels.yml`'s own description
  text says so for each one — and must never be hand-edited. Treating a mirror
  label as something to set, the way `needs:`/`tier:`/`factory:` are set, is
  the specific mix-up this section exists to head off.

---

## 4. Register a repository

Registration **verifies the repository is reachable** with your token before
accepting it — an entry Opifex cannot read would turn every subsequent tick into
a 404.

```bash
curl -X POST http://localhost:3535/api/repositories \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"owner":"marinoscar","name":"opifex","observeEnabled":true}'
```

`dispatchEnabled` and `mirrorLabelsEnabled` both default to **false**, and leave
them there. The three switches are separate precisely so the week can end in
stages: observe → write mirror labels → dispatch. A single `enabled` flag would
make the first write and the first run happen on one flip.

---

## 5. Subscribe your phone

1. Open the cockpit **over HTTPS** on the phone. On iOS, add it to the home
   screen first — Safari only allows push from an installed web app.
2. Settings → **Phone notifications** → _Notify this device_.
3. The card tells you what is wrong if it cannot: insecure origin, no Push API,
   no server keys, or a denied permission. Those are four unrelated fixes, which
   is why it names which one applies.

Confirm the server agrees:

```bash
curl http://localhost:3535/api/notifications/subscriptions \
  -H "Authorization: Bearer $ACCESS_TOKEN"
```

---

## 6. What to read, and when

### Every day: what did it decide?

```bash
# Skip the quiet ticks — they are the great majority.
curl 'http://localhost:3535/api/reconciler/ticks?actionsOnly=true&pageSize=25' \
  -H "Authorization: Bearer $ACCESS_TOKEN"

# One tick in full, with its projection and every action it computed.
curl http://localhost:3535/api/reconciler/ticks/<id> \
  -H "Authorization: Bearer $ACCESS_TOKEN"
```

**`actionsExecuted` must be `0` on every tick, all week.** If it is not,
something is enabled that should not be — stop and find out what.

This log is the deliverable of the week. Every action carries a `reason` naming
the observed inputs and an `evidence` block with the raw values, so a decision
can be checked without reading code. You are looking for actions that are
_plausible but wrong_ — the reason sounds right and the evidence does not support
it. That is the failure mode the week exists to catch.

### Every day: was anything missed?

```bash
curl 'http://localhost:3535/api/escalations?unresolvedOnly=true' \
  -H "Authorization: Bearer $ACCESS_TOKEN"
```

### At the end: the number that defines the problem

```bash
curl 'http://localhost:3535/api/escalations/latency?since=2026-08-22T00:00:00Z' \
  -H "Authorization: Bearer $ACCESS_TOKEN"
```

Read it in this order:

| Field                               | What it tells you                                                                       |
| ----------------------------------- | --------------------------------------------------------------------------------------- |
| `notified`                          | **The metric.** Stop → a human informed. VISION §10's target is _seconds_.              |
| `detected`                          | Stop → Opifex noticing. The flattering number.                                          |
| `awaitingNotification`              | Raised, never delivered. Unbounded latency — **read this before believing `notified`.** |
| `unmeasurable`                      | No stop time at all, e.g. a `system` escalation.                                        |
| `bySource.runner` vs `bySource.git` | Git-derived detection is structurally slower. A blended figure describes neither.       |
| `truncated`                         | The window held more than one summary reads.                                            |

A beautiful `notified` next to a large `awaitingNotification` means the transport
is broken and the percentile is describing a handful of lucky escalations.

The same measurements are on OTLP as `opifex.detection.latency` and
`opifex.detection.detect_latency`, with `opifex.escalations.raised` and
`opifex.escalations.notified` — the **gap between those two counters is how many
stalls nobody was told about**. See
[ADR 0003](adr/0003-observability-backend.md) for why this endpoint does not
depend on the OTEL stack running.

---

## 7. Ending the week

Do it in stages, and let each one sit before the next:

1. **Mirror labels on, one repository.**
   `PATCH /api/repositories/{id}` with `{"mirrorLabelsEnabled": true}`, and set
   `GITHUB_WRITES_ENABLED=true`. Both must be on for a label to be written. This
   is the first time Opifex touches GitHub — proving the write path before
   dispatch is switched on is the entire reason labels come first.
2. **Watch the labels.** `factory/dispatched`, `factory/blocked`,
   `factory/review`, `factory/quarantine` should appear and disappear in step
   with what the tick log said. Your own `factory:ready`, `factory:hold` and
   `factory:clear-quarantine` are inputs and are never touched.
3. **Dispatch** — not part of this runbook. The executor
   (`apps/api/src/dispatch/run-executor.service.ts`) and the `claude-code-local`
   runner it calls both exist and are wired into the app, but three switches
   keep them off: `DISPATCH_ENABLED` (global), `CLAUDE_CODE_LOCAL_ENABLED` (the
   runner itself), and each repository's own `dispatchEnabled` (§4). All three
   default `false`, and deliberately stay that way for the whole observation
   week — turning them on is the step after this runbook, not part of it. See
   `docs/ARCHITECTURE.md` §3.9 for what each flag gates.

---

## Troubleshooting

| Symptom                                                  | Cause                                                                                                              |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `Reconciler is DISABLED`                                 | `RECONCILER_ENABLED` is not the literal `true`                                                                     |
| `OAuth2Strategy requires a clientID option`              | #138 — set the Google variables                                                                                    |
| Ticks recorded, `repositoriesObserved: 0`                | No repository has `observeEnabled`                                                                                 |
| `skipped-locked` in the tick log                         | Another instance holds the advisory lease. Expected if two are running; the design, not a race                     |
| Escalations raised, none delivered                       | Check `failureReason` — it names which of three problems: no VAPID keys, no devices, or every device rejecting     |
| Notification shows but the escalation stays `dispatched` | The device's receipt did not reach the server. It flips to `failed` after `NOTIFY_RECEIPT_TIMEOUT_MS`              |
| Rate limit exhausted                                     | `GITHUB_RATE_LIMIT_RESERVE` holds requests back for interactive use; raise it if you also hit the API from a shell |

## What this week cannot tell you

Being explicit, so the gaps do not get quietly assumed away:

- **`dispatch` is computed and not acted on, because the switches that would
  act on it are off.** `run-executor.service.ts` runs the whole decision for
  every queued work order and logs what it _would_ have dispatched — the same
  code path that will actually submit once `DISPATCH_ENABLED`,
  `CLAUDE_CODE_LOCAL_ENABLED`, and the repository's own `dispatchEnabled` are
  all `true`. Nothing about this observation week turns them on.
- **`kill-and-re-run`, `kill-and-re-plan`, and `park` are computed and
  discarded, and no flag changes that.** These are the watchdog's own
  recovery actions for a run already in flight — abandon-and-restart a silent
  run, kill-and-replan a looping one, park a rate-limited one until its reset.
  Unlike `dispatch`, no executor exists for any of the three yet: the mirror-
  label executor only ever touches `add-mirror-label` /
  `remove-mirror-label`, and nothing else in the reconciler's write path
  handles them. A stalled run is escalated to you; it is not yet killed and
  restarted by the system itself.
- **Detection latency here is a control-plane measurement.** Real runs from a
  real runner will move it.
- **A quiet week proves less than it looks.** If no run ever stalls, the watchdog
  was never tested. Consider deliberately stalling one.
