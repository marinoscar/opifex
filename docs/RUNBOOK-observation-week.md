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

> **First:** this runbook assumes the fleet already reports a runner that is
> `available: true`. Getting there — the binaries, the credential, and the two
> enable flags in the right order — is
> [`RUNBOOK-enable-claude-code-local.md`](RUNBOOK-enable-claude-code-local.md).
> Start there if `/api/health/ready` shows an `unavailableReason`, or if you have
> not chosen which quota the agent spends.

You need:

|                                                  | Why                                                              |
| ------------------------------------------------ | ---------------------------------------------------------------- |
| A fine-grained GitHub token, read access         | The reconciler reads issues, labels, commits, PRs and check runs |
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

The settings that matter for this week. Two groups, and they are configured
differently since epic #332 — see
[`docs/operator-configuration.md`](operator-configuration.md) if the
distinction below is unfamiliar:

```bash
# Still .env — GITHUB_TOKEN is a registered secret key, but the Control
# Center screen that would let you set one from a form (Credentials, #349)
# has not shipped, so this one is still a plain .env edit for now.
GITHUB_TOKEN=ghp_...

# Also still .env — neither is a managed key at all.
VAPID_PUBLIC_KEY=...             # from the command above
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:you@example.com
OTEL_ENABLED=true                # optional, see the traces
```

**Leave `.env`'s reconciler and GitHub-writes variables at their defaults —
`RECONCILER_ENABLED=false` (unset), `RECONCILER_INTERVAL_MS=60000` (unset),
`RECONCILER_LOG_RETENTION_DAYS=14` (unset), `GITHUB_WRITES_ENABLED=false`
(unset).** All four are now operator-managed keys (`reconciler.enabled`,
`reconciler.intervalMs`, `reconciler.logRetentionDays`,
`github.writesEnabled`), editable live from `/admin/settings` →
Configuration once the container is up — §2 below turns the control loop on
that way instead of by baking it into `.env` before the first boot, which
doubles as proof that the live toggle actually works before you rely on it
for anything else this week.

**Retention is 14 days deliberately.** A one-week window pruned at seven days is
half-gone on the day you sit down to review it. It stays a code default here
because 14 already matches the registry's own default — nothing to set.

---

## 2. Start it

```bash
cd infra/compose
docker compose -f base.compose.yml -f dev.compose.yml up -d

# With traces and metrics (Uptrace at http://localhost:14318):
docker compose -f base.compose.yml -f dev.compose.yml -f otel.compose.yml up -d
```

Confirm the loop registered — this line is the whole point, and with
`RECONCILER_ENABLED` left unset it says so honestly:

```
LOG [ReconcilerTask] Reconciler tick registered every 60000ms; the reconciler is DISABLED, so every tick will skip until it is enabled
```

The interval is registered either way now (#343) — a disabled reconciler
still wakes every `intervalMs` to confirm it has nothing to do, logged at
`debug` so it costs no attention. What differs with enablement is entirely
inside that one line.

Now turn it on, live, from the Control Center: `/admin/settings` →
**Configuration** → the **Reconciler** group → _Reconciler enabled_ →
switch it on → Save. `reconciler.enabled` has `live` reload, so this takes
effect on the very next scheduled tick — up to a minute away, never a
restart, and **no second log line confirms it**; the boot line above only
prints once, at startup. Confirm the toggle actually took instead by reading
the tick log itself once a tick has had time to run:

```bash
curl 'http://localhost:3535/api/reconciler/ticks?pageSize=1' \
  -H "Authorization: Bearer $ACCESS_TOKEN"
```

While disabled, `runOnce()` returns before `ReconcilerService.tick()` is ever
called, so **no row is written at all** — an empty response here while
`reconciler.enabled` reads `false` is expected, not a bug. The proof the flip
landed is a **new row appearing** after the next scheduled tick — its
`repositoriesObserved` will read `0` until §4 registers one, and that is
still the tick running, not a failure.

You should also see, if you have not set the VAPID keys:

```
WARN [WebPushTransport] Web Push transport is NOT configured (...). Escalations
will be recorded and will NOT reach a phone.
```

That warning is the design working. An unconfigured install announces itself
rather than going quiet.

---

## 3. Create the label taxonomy

`.github/labels.yml` is the declaration, and `label-taxonomy.ts` is its twin
in code (#415) — CI asserts the two agree. Until the taxonomy is applied to a
repository, **the fifteen control-loop `factory:*` / `factory/*` / `needs:*` /
`tier:*` labels do not exist on it** — and a label that does not exist cannot
be put on an issue, so nothing can ever carry `factory:ready`, and the
reconciler correctly computes zero actions on every tick, forever. That is
how the first attempt at this week produced 302 empty ticks (#195). Which of
the two routes below applies to you depends on when the repository was
registered.

### If you are registering the repository now (§4): nothing to do here

**Registration provisions the fifteen control-loop labels automatically.**
`POST /api/repositories` — the request §4's picker sends — creates the three
`factory:*` input labels, the five `factory/*` mirror labels, and the seven
`needs:*` / `tier:*` routing labels on the repository as part of registering
it. Read §4 first if you have not registered anything yet; there is nothing
to run from this section before you do.

**A registration still succeeds if provisioning is refused**, and that is a
normal outcome rather than a broken registration: ADR-0001's fine-grained
GitHub token grants access one repository and one permission at a time, and
whether it can write labels to a given repository is unknowable until it is
tried — reading a repository never implies being able to label it. The
response's `labelProvisioning` field says what happened, and the repository's
card on `/projects` shows the same thing under **Check labels**. If it is not
`ok`, the fix is almost always the token's **Issues: Read and write**
permission on that repository; grant it, then press **Create missing
labels** on the card (or `POST /api/repositories/{id}/labels`) to repair it
without re-registering anything.

### If the repository was registered before this change: run the CLI

A repository already in the table when #415 shipped got nothing from
registration — provisioning did not exist yet. Repair it the same way the
card would: `POST /api/repositories/{id}/labels`, or the CLI below with
`--apply`, either of which creates the same fifteen control-loop labels on an
already-registered repository. Nothing about being pre-#415 changes the
target set.

### For the 25 organisational labels: the CLI is the only route, always

`bug`, `phase:*`, the component labels — this repository's own conventions,
which nothing in the control loop reads — are declared in
`.github/labels.yml` alongside the fifteen but are **not** part of what
either registration or the repair endpoint provisions (`label-taxonomy.ts`'s
own header explains why: writing somebody else's issue tracker a `phase:4`
label because they let Opifex watch their repository is presumptuous). The
CLI applies the full 40-label file — the fifteen above plus these 25 — and is
the only way to get the 25 onto any repository, new or old:

```bash
node scripts/sync-labels.mjs                  # what is missing or drifted
node scripts/sync-labels.mjs --apply          # create and update
node scripts/sync-labels.mjs --repo owner/name --apply
```

Checking is the default; writing needs `--apply`. It **never deletes** a label
it does not recognise — removing one strips it from every issue that carries it,
and the file cannot restore that.

Both routes are operator setup, not factory behaviour, so both are
deliberately outside `GITHUB_WRITES_ENABLED` / `github.writesEnabled`.
Gating either on that switch would mean the observation week could not be
set up without first turning on the writes it exists to withhold.

### `needs:*` and `tier:*`: routing labels, a third kind next to `factory:`

Two more label families change what happens once a work order exists:
`needs:*` (#64) and `tier:*` (#273). `factory:` is a **closed vocabulary of
three human intents** deciding **whether** a work order is created or held
at all; `needs:*` and `tier:*` are a third kind that describes **what** the
work requires and changes only **where** it routes — which runner, which
model class — never whether the work happens. That is why #273 declined the
spelling `factory:tier-…`: folding a routing judgement into the same closed
vocabulary as "stop" would blur exactly that line.

Since #303, both families are declared in `.github/labels.yml`'s own
**Routing labels** section, so the same `sync-labels.mjs --apply` used in §3
creates all seven, and the drift report lists a missing or drifted one under
its own **Routing labels** heading — separate from **Input labels** and
**Mirror labels**, because the news is different: a missing routing label
still leaves the repository steerable and work still runs, just only ever on
the defaults. They are still read independently of the `factory:`
input-label machinery: a `needs:` or `tier:` label never appears in an
issue's `inputLabels`, and a misspelled one never appears in
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

### Pick it from the Projects screen; do not type it

`/projects` → **Unassigned** (the default pane, and where this repository
lands unless you also file it into a project you have already created) →
**Add repository**.

Not the Control Center. Registering used to live at `/admin/settings` →
Repositories, which meant it needed an Admin's `system_settings:read` on top
of the permission that actually gates it; #406 moved it to `/projects`, which
needs only `projects:read` / `projects:write` — the pair `RepositoriesController`
has enforced all along. The Control Center's Repositories section is now a
signpost pointing here, not a second copy of the ladder (see
[`operator-configuration.md`](operator-configuration.md) if you land on it
looking for this dialog).

The dialog lists the repositories the **configured GitHub credential can
actually reach**, and you choose one. There is no `owner/name` box, on purpose:
a free-text field for a value the system can enumerate turns a typo into a
confusing failure several seconds later instead of an impossible input now.

The button is there when nothing is registered yet, which is when you need it.

**What you should see:** a list, with the addable repositories first, then the
ones Opifex already watches, then the archived ones. Every row is present and
the unaddable ones are **marked**, never hidden — a repository you can see on
GitHub is a repository you can find here, with the reason it cannot be added
attached to it.

**This list is your token's scope, not your account's inventory.** ADR-0001
chose a _fine-grained_ personal access token precisely so that the reachable
set is a list somebody chose — a classic token's account-wide `repo` scope
would reach repositories Opifex was never meant to touch. So a short list is
the scope showing, and it is the honest picture of what Opifex could reach.

Choose a row and press **Register `owner/name`**. Only `owner` and `name` are
sent, plus the project you opened the dialog from if any: every policy
default lives in the database schema, so what lands is observed and never
dispatched.

**Observable:** the repository appears in the panel behind the dialog straight
away, with its ladder at rung 1 — no page reload, no manual refresh. The
dialog stays open, the row you just added flips to _already registered_, and
you can add a second. Adding a second was the thing that was impossible
before (#401).

**Select several at once, but they register one at a time.** Tick the rows
you want — the picker bounds **Select all** to the addable rows of the page
you are looking at, so it can never quietly include something you cannot see
— and one `POST /api/repositories` goes out per repository, awaited before
the next. Never several at once, because the reachability check behind each
one (`verifyReachable`) is a real GitHub call spent against the same
rate-limit budget `github.rateLimitReserve` reserves for your own interactive
use. You get a progress line per repository rather than a blank spinner. Nothing rolls back across repositories either: if the third one you add
is refused (rate-limited, or the token's access narrowed mid-session), the
first two stay registered. That partial success is the intended outcome, not
a failure to clean up after — the report names every repository and what
happened to it, successes drop out of the selection, and refusals stay
selected so a retry re-sends only what has not already worked.

Two things the dialog says that are worth reading rather than skipping:

- **An empty list can be a success.** "The credential works and reaches no
  repository" means the token is valid and its scope covers nothing. Widen the
  token's **Repository access** on GitHub; do not reissue it.
- **A truncated list says so.** If GitHub's listing hit its page cap, a
  separate warning appears and the count shown is a lower bound. Search for the
  repository by name rather than scrolling.

### The same list from the API

The picker is a view over one endpoint, and the endpoint is worth knowing when
you are debugging what the credential can see:

```bash
curl 'http://localhost:3535/api/repositories/available' \
  -H "Authorization: Bearer $ACCESS_TOKEN"
```

Every row carries an `admission`, and none is ever hidden:

| `admission`  | What it means                                                                                               | In the picker                                                     |
| ------------ | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `available`  | Registrable right now.                                                                                      | Selectable, no mark.                                              |
| `registered` | Already in the table. `repositoryId` names the existing row — this is the 409 the list exists to spare you. | Marked, not selectable, with **Show it in the list** to reach it. |
| `archived`   | GitHub archived it. Registration refuses it, so it is marked rather than offered as if it would work.       | Marked, not selectable, and says to unarchive it on GitHub.       |

The answer as a whole carries a `status`, and **a failure comes back as a 200
carrying that status rather than as an error code** — "the request failed" and
"the request found a failure" are two different things, and one HTTP status
cannot say which. Each value has its own remedy, and the picker gives each one
its own heading with the API's own sentence quoted underneath:

| `status`             | What is actually wrong                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `ok`                 | GitHub answered. **`reachable: 0` is still `ok`** — the token works and its scope covers nothing. Grant it a repository, do not reissue it. |
| `no_credential`      | No `github.token` is set. Control Center → **Configuration** → the **GitHub** group.                                                        |
| `invalid_credential` | GitHub rejected it (401). A fine-grained token expires on a fixed date and then fails exactly like this.                                    |
| `refused`            | It authenticated and was refused (403). Widen the token's permissions; do not replace the token.                                            |
| `rate_limited`       | The hourly budget is spent; `detail` says until when. ADR-0001 notes this budget is shared with your own use of GitHub.                     |
| `unreachable`        | Nothing answered. This says **nothing** about the token — check the network, the proxy and `github.apiBaseUrl`.                             |
| `failed`             | Anything else, with GitHub's own words in `detail`.                                                                                         |

A long list is paginated: `?search=billing`, `?page=2`, `?pageSize=50`. The
picker's search box and its Previous/Next send exactly these — the search spans
everything the token reaches, not the page on screen. `total` counts the search
matches and `reachable` counts what the token sees before searching, so an
empty search is distinguishable from an empty scope. If `truncated` is `true`,
the page cap was hit and the list is **not** complete.

### Registering from the API

The picker posts to this endpoint; nothing about it is a second path. It is
here because a scripted setup has no dialog to click.

Registration **verifies the repository is reachable** with your token before
accepting it — an entry Opifex cannot read would turn every subsequent tick into
a 404.

```bash
curl -X POST http://localhost:3535/api/repositories \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"owner":"marinoscar","name":"opifex","observeEnabled":true}'
```

A success answers `201` with the row, including the `defaultBranch` read from
GitHub rather than guessed. A repository you took from the list above should
never answer `409` (already registered) or `400` (archived, or unreachable) —
if it does, the list was read against a different token than the one in force
now, which is possible because `github.token` is resolved per request. The
picker renders those three refusals, and the 503 for a missing credential, as
themselves rather than as one failure, for exactly that reason.

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
   `PATCH /api/repositories/{id}` with `{"mirrorLabelsEnabled": true}`, and
   turn on `github.writesEnabled` — `/admin/settings` → Configuration → the
   **GitHub** group → _GitHub writes enabled_ → Save. (It is `live` reload,
   same as everything flipped earlier in this runbook; no restart, no
   `.env` edit.) Both must be on for a label to be written. This
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

| Symptom                                                  | Cause                                                                                                                                                                          |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Boot line says `the reconciler is DISABLED`              | `reconciler.enabled` resolves to `false` — check `/admin/settings` → Configuration (or `GET /api/operator-settings`) for its `source`; a stored `database` row outranks `.env` |
| `OAuth2Strategy requires a clientID option`              | #138 — set the Google variables                                                                                                                                                |
| Ticks recorded, `repositoriesObserved: 0`                | No repository has `observeEnabled`                                                                                                                                             |
| `skipped-locked` in the tick log                         | Another instance holds the advisory lease. Expected if two are running; the design, not a race                                                                                 |
| Escalations raised, none delivered                       | Check `failureReason` — it names which of three problems: no VAPID keys, no devices, or every device rejecting                                                                 |
| Notification shows but the escalation stays `dispatched` | The device's receipt did not reach the server. It flips to `failed` after `NOTIFY_RECEIPT_TIMEOUT_MS`                                                                          |
| Rate limit exhausted                                     | `GITHUB_RATE_LIMIT_RESERVE` holds requests back for interactive use; raise it if you also hit the API from a shell                                                             |

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
