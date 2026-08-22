# Runbook: turning Opifex on, and the observation week

VISION §12 requires the reconciler to run **read-only for a week**, recording what
it *would* have done, before it is allowed to do anything. This is how you start
that week, and what to read while it runs.

It also closes the exit criteria on epics **#16** and **#17** that no amount of
code can close: *"detection latency is measured, graphed, and in seconds"* and
*"a notification reaches a phone."* Those are observations, not features.

> **Nothing here writes to GitHub.** `GITHUB_WRITES_ENABLED` defaults to `false`
> and every write adapter returns `performed: false` without issuing a request.
> The one thing that *does* leave the building is a push notification to your own
> phone.

---

## Before you start

You need:

| | Why |
|---|---|
| A GitHub token with `repo` read scope | The reconciler reads issues, labels, commits, PRs and check runs |
| A PostgreSQL 16 database | Migrations are applied on deploy |
| A phone that can open the cockpit over **HTTPS** | Web Push refuses to subscribe on a plain-HTTP origin |
| Google OAuth credentials | See the papercut below — you need them even if nobody logs in |

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

## 3. Register a repository

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

## 4. Subscribe your phone

1. Open the cockpit **over HTTPS** on the phone. On iOS, add it to the home
   screen first — Safari only allows push from an installed web app.
2. Settings → **Phone notifications** → *Notify this device*.
3. The card tells you what is wrong if it cannot: insecure origin, no Push API,
   no server keys, or a denied permission. Those are four unrelated fixes, which
   is why it names which one applies.

Confirm the server agrees:

```bash
curl http://localhost:3535/api/notifications/subscriptions \
  -H "Authorization: Bearer $ACCESS_TOKEN"
```

---

## 5. What to read, and when

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
*plausible but wrong* — the reason sounds right and the evidence does not support
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

| Field | What it tells you |
|---|---|
| `notified` | **The metric.** Stop → a human informed. VISION §10's target is *seconds*. |
| `detected` | Stop → Opifex noticing. The flattering number. |
| `awaitingNotification` | Raised, never delivered. Unbounded latency — **read this before believing `notified`.** |
| `unmeasurable` | No stop time at all, e.g. a `system` escalation. |
| `bySource.runner` vs `bySource.git` | Git-derived detection is structurally slower. A blended figure describes neither. |
| `truncated` | The window held more than one summary reads. |

A beautiful `notified` next to a large `awaitingNotification` means the transport
is broken and the percentile is describing a handful of lucky escalations.

The same measurements are on OTLP as `opifex.detection.latency` and
`opifex.detection.detect_latency`, with `opifex.escalations.raised` and
`opifex.escalations.notified` — the **gap between those two counters is how many
stalls nobody was told about**. See
[ADR 0003](adr/0003-observability-backend.md) for why this endpoint does not
depend on the OTEL stack running.

---

## 6. Ending the week

Do it in stages, and let each one sit before the next:

1. **Mirror labels on, one repository.**
   `PATCH /api/repositories/{id}` with `{"mirrorLabelsEnabled": true}`, and set
   `GITHUB_WRITES_ENABLED=true`. Both must be on for a label to be written. This
   is the first time Opifex touches GitHub — proving the write path before
   dispatch exists is the entire reason labels come first.
2. **Watch the labels.** `factory/dispatched`, `factory/blocked`,
   `factory/review`, `factory/quarantine` should appear and disappear in step
   with what the tick log said. Your own `factory:ready`, `factory:hold` and
   `factory:clear-quarantine` are inputs and are never touched.
3. **Dispatch** — not yet. Nothing executes a run until Phase 4 (#18) lands.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `Reconciler is DISABLED` | `RECONCILER_ENABLED` is not the literal `true` |
| `OAuth2Strategy requires a clientID option` | #138 — set the Google variables |
| Ticks recorded, `repositoriesObserved: 0` | No repository has `observeEnabled` |
| `skipped-locked` in the tick log | Another instance holds the advisory lease. Expected if two are running; the design, not a race |
| Escalations raised, none delivered | Check `failureReason` — it names which of three problems: no VAPID keys, no devices, or every device rejecting |
| Notification shows but the escalation stays `dispatched` | The device's receipt did not reach the server. It flips to `failed` after `NOTIFY_RECEIPT_TIMEOUT_MS` |
| Rate limit exhausted | `GITHUB_RATE_LIMIT_RESERVE` holds requests back for interactive use; raise it if you also hit the API from a shell |

## What this week cannot tell you

Being explicit, so the gaps do not get quietly assumed away:

- **Nothing is executed.** Every `kill-and-re-run`, `kill-and-re-plan`, `park`
  and `dispatch` is computed and discarded. The executor is Phase 4.
- **Detection latency here is a control-plane measurement.** Real runs from a
  real runner will move it.
- **A quiet week proves less than it looks.** If no run ever stalls, the watchdog
  was never tested. Consider deliberately stalling one.
