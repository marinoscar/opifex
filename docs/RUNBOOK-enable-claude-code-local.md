# Runbook: enabling `claude-code-local` in a container

Getting from "the API is deployed" to "the fleet reports a runner that could
actually do work". Four steps, each with **an observable that proves it** — not a
list of variables to set and hope about.

This runbook stops one step short of running anything. The last step hands off to
[`RUNBOOK-observation-week.md`](RUNBOOK-observation-week.md), which is where
dispatch is turned on and watched.

> **Why this exists at all.** ADR-0008 makes `claude-code-local` a **child process
> of the API process**, so "where Opifex runs" and "where Claude Code runs" are
> the same container by construction. Everything below is a consequence of that
> one decision. Epic #324 is the work that made this container capable; this is
> the procedure for using it.

---

## The order matters — as a check now, not a gate

Both enable flags ship **on** by default (ADR-0019, #439): a freshly booted
container already has `runners.claudeCodeLocal.enabled` and
`dispatch.enabled` set to `true`, and nothing here forces you to flip either
one before the other. Flipping them one at a time used to be the only way
to avoid queuing every work order behind a runner nobody had checked yet;
it no longer is, because dispatch stays refused on its own —
`dispatch.hardSpendCeilingUsd` has no default, and
`docs/adr/0019-fresh-install-ships-ready-not-running.md` records why that
one refusal is now what a fresh install relies on instead of these two.

The reason to still do it in order has not gone away, though — it has just
stopped being mandatory, and is now advice for an operator who wants to
**verify** the runner registers honestly before trusting it with anything:

| Flag                        | What it governs                            |
| --------------------------- | ------------------------------------------ |
| `CLAUDE_CODE_LOCAL_ENABLED` | Whether this runner is _dispatchable_      |
| `DISPATCH_ENABLED`          | Whether the queue drains to **any** runner |

To run the check anyway: turn `runners.claudeCodeLocal.enabled` off from the
Control Center, confirm the fleet reports `dispatchable: 0`, then turn it
back on and watch the number move — the same observation step 3 below
walks through, starting from off instead of from the shipped default.

> **Both are flipped from the Control Center, not `.env`.** Since epic
> #332, `CLAUDE_CODE_LOCAL_ENABLED` (`runners.claudeCodeLocal.enabled`) and
> `DISPATCH_ENABLED` (`dispatch.enabled`) are operator-managed keys with
> `live` reload — an Admin toggles them at `/admin/settings` → Configuration
> and the next dispatch decision honours it, no restart. The `.env` values
> below still exist and still matter as the floor a fresh container boots on,
> but they are no longer the recommended way to make this specific change.
> See [`docs/operator-configuration.md`](operator-configuration.md).

Availability is a third, separate thing, and it is **observed rather than
configured**: the runner probes `claude --version` and reports what it found.
That is why step 3 below is worth reading even though dispatch no longer
needs to be off for it to be safe — the fleet tells you whether the
container is capable, independent of either enable flag.

---

## Step 1 — the binaries

Two are required, and only one of them is obvious.

```bash
docker exec opifex-api-1 sh -lc 'git --version; claude --version'
```

**Observed** on the reference deployment:

```
git version 2.54.0
2.1.246 (Claude Code)
```

`git` is the blocker that fires **first**. `RunWorkspaceService` shells out to it
for clone, checkout, `git config` and commit, so a run dies at workspace
provisioning before the CLI is ever invoked. An image with `claude` and no `git`
has moved the failure, not fixed it.

Both are installed in the Dockerfile's `base` stage, so the `development` and
`production` targets cannot drift to different CLI versions. To pin:

```bash
docker compose build --build-arg CLAUDE_CODE_VERSION=2.1.246 api
```

Unpinned is the default, and that is defensible only because the version is
observed — see step 3, where it shows up as a fact in the fleet.

> **Pinning this version is also what keeps the tier → model mapping
> honest.** Since #420, a work order labelled `tier:small` / `tier:standard`
> / `tier:large` pins a model on this runner via `--model`, through three
> registry keys — `runners.claudeCodeLocal.model.small` / `.standard` /
> `.large` (`CLAUDE_CODE_MODEL_SMALL` / `_STANDARD` / `_LARGE`). Their
> defaults (`claude-haiku-4-5`, `claude-sonnet-5`, `claude-opus-5`) were
> checked against the model table compiled into `claude` 2.1.243 — an
> unpinned CLI that has drifted past that build is drifting past the version
> those defaults were verified against, not only the version this step
> observes. See [`docs/operator-configuration.md`](operator-configuration.md)
> for the full four-case behaviour (a mapped tier, no tier at all, a tier
> deliberately mapped to nothing, and a tier this build cannot map) and its
> `next-unit` reload semantics.

---

## Step 2 — the credential

**No shell, and no `.env` edit.** This step used to be the one place this
runbook told you to get a terminal inside a container, because
`claude setup-token` refuses to run without a TTY. Since #386 the API runs that
CLI for you, on a pseudo-terminal it allocates itself, and seals the result
straight into `runners.claudeCodeLocal.oauthToken`.

First decide which pool you are spending from, because the two answers are
different credentials with different failure modes:

| Credential                                                 | Spends                   | The cost                                                                                                                                                            |
| ---------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude subscription (`runners.claudeCodeLocal.oauthToken`) | Your Claude subscription | Automated runs compete with **your own interactive use** for one quota — VISION §11. `CLAUDE_CODE_MAX_CONCURRENCY` is what leaves you room.                         |
| `ANTHROPIC_API_KEY`                                        | Per-token API billing    | No quota contention; lands on the hard spend ceiling (#65) instead, which can only be applied to the **next** attempt because the CLI reports cost once at the end. |

`ANTHROPIC_API_KEY` is not a managed key and stays an `.env` edit,
permanently — it is a different credential with a different cost model, and
#386 deliberately left it alone. If that is the one you want, set it in `.env`,
recreate the container, and skip to the verification below.

For the subscription token:

1. Open `/admin/settings` → **Credentials** and press **Connect Claude
   account**. You need an interactive sign-in and
   `operator_settings:write_secret`; a personal access token is refused, and
   would not be able to finish the flow anyway.
2. The page shows an OAuth URL. Open it — in the same browser or another one —
   and sign in to the Claude account whose subscription should pay for
   automated runs.
3. Authorise, copy the code the page hands back, and paste it into the field.

Keep the two tabs side by side: the code expires within a few minutes, the
sign-in session expires after ten, and it accepts exactly one code. A rejected
code ends the session — start a new one rather than retrying, because the
authorization challenge is spent.

**Observable:** the row for the Claude credential reads `configured` with a
masked hint and a `database` source, and History records an
`operator_settings:set` for `runners.claudeCodeLocal.oauthToken`. The token
itself is never shown, in that response or any other — it goes from the CLI's
standard output into the encrypted column and nowhere else.

If it fails, the message says which of five things went wrong rather than
"authentication failed":

| Message says                     | What to do                                                                                                      |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| The code was rejected            | Start again and paste the whole code straight away. If it was definitely fresh, check the account's plan next.  |
| The account cannot issue a token | The Claude account has no active plan, is on hold, or belongs to an org that has disabled Claude Code access.   |
| The CLI could not be run         | `runners.claudeCodeLocal.binary` is wrong, or step 1 above was skipped. **Test CLI** on the same page confirms. |
| No pseudo-terminal               | The image is missing `script(1)` from `util-linux`. Rebuild the API image.                                      |
| The sign-in expired              | Nothing was changed. Start again with the browser tab already open.                                             |

**Then verify the credential for real, and do not skip this.** "Configured" and
"works" are different claims, and this is the step that closes the gap — press
**Test credential** on the Credentials page, which makes one real, billed
`claude --print` invocation. Or, equivalently, from a shell:

```bash
docker exec opifex-api-1 sh -lc 'cd /tmp && claude -p --output-format=text "reply with the single word: ok"'
```

Anything other than a normal completion here — an auth prompt, a 401, a hang —
means the credential is not usable, and **step 3 will not tell you that**: the
runner probes `claude --version`, which succeeds with no credential at all. See
the failure table.

> **Not exercised on the reference deployment.** Everything else in this runbook
> was run and its output pasted verbatim; this step was not, because it needs a
> real Claude account and authorising one is the operator's call. The flow's
> URL capture, code submission, sealing, failure branches and teardown are
> covered by tests against a fake CLI on a real pseudo-terminal
> (`apps/api/src/settings/operator-settings/claude-auth/`); a completed
> exchange against the vendor is the one part only a live run proves.

---

## Step 3 — confirm the runner, and optionally verify it registers honestly

`runners.claudeCodeLocal.enabled` ships **on** (ADR-0019, #439), so a
container that has completed steps 1 and 2 is already dispatchable — no flag
to flip, just the container as it already booted:

```bash
curl -s https://<your-host>/api/health/ready | jq .data.info.fleet
```

You should see `enabled: 1` and `dispatchable: 1` already, with `available`
reflecting whatever step 1 found.

**If you want the honest-registration check described above**, turn
`runners.claudeCodeLocal.enabled` off first — from the Control Center,
`/admin/settings` → Configuration → the **Runner** group — and re-run the
same command. That is what produced the transcript below, captured on the
reference deployment before this flag defaulted on; it is what you will see
again if you deliberately flip it off to run this check yourself:

```json
{
  "status": "up",
  "registered": 1,
  "routable": 1,
  "enabled": 0,
  "dispatchable": 0,
  "runners": [
    {
      "key": "claude-code-local",
      "version": "2.1.246",
      "enabled": false,
      "available": true,
      "maxConcurrency": 2
    }
  ],
  "message": "All 1 registered runner(s) are disabled. Nothing will be dispatched until one is switched on — this is a configuration choice, not a failure."
}
```

Read that carefully, because it is the point of doing this step separately:
**`available: true` with `enabled: false`.** Availability is what the container can
do; enablement is what you have permitted. They move independently, and the
version string is not configuration — it is what `claude --version` actually
printed, carried through `probeVersion()` into the manifest.

Confirm it landed in the database, which is what dispatch actually routes on:

```sql
select r.key, c.manifest->>'version' as observed_version, c.invocation_model
from runner_capabilities c join runners r on r.id = c.runner_id;
```

**Observed:**

```
claude-code-local | 2.1.246 | process
```

Three places now agree — the installed binary, the health payload and the
persisted manifest. If they disagree, registration has not re-run; it converges on
a 60-second tick (#276), so wait one before investigating.

Now flip the runner back on — only needed if you turned it off to run the
check above; a container you have not touched already has it on. From the
Control Center: `/admin/settings` → **Configuration** → the **Runner** group
→ _Local Claude Code runner enabled_ → switch it on → Save. Or, scripted,
with an access token minted by an interactive login — this endpoint refuses
a personal access token or a device-flow token outright, see
[`personal-access-tokens.md`](personal-access-tokens.md):

```bash
curl -X PATCH https://<your-host>/api/operator-settings \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"runners.claudeCodeLocal.enabled": true}'
```

`runners.claudeCodeLocal.enabled` has `live` reload — nothing here needs a
restart or even a wait for the next poll tick; re-run the health check
immediately:

```bash
curl -s https://<your-host>/api/health/ready | jq .data.info.fleet
```

`enabled` and `dispatchable` should both now read `1`, with `available`
unchanged from step 1 — enablement and availability are still two different
facts, only one of which you just changed (or confirmed was already set).

---

## Step 4 — hand off

`dispatch.enabled` ships on too, so there is usually nothing left to flip
here — go straight to
[`RUNBOOK-observation-week.md`](RUNBOOK-observation-week.md), which now
opens by turning `github.writesEnabled` **off** if you want a read-only
week, rather than by turning dispatch on. If you turned `dispatch.enabled`
off as part of the check in step 3, flip it back the same way, from
Configuration or via `PATCH /api/operator-settings`, before moving on. That
runbook owns what to watch once work is actually moving; this one is
finished when the fleet says the container is capable.

---

## Failure table

The rows are ordered by how easy they are to diagnose. The last one is the
dangerous one.

| Symptom                                                          | Cause                              | Where it shows up                                                                                                     |
| ---------------------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `available: false`, `unavailableReason` names `claude --version` | CLI not installed or not on `PATH` | `/api/health/ready`, immediately. Nothing is dispatched; work orders queue.                                           |
| Runs fail at workspace provisioning, before any agent output     | `git` missing                      | Run events, not the health payload. The version probe passes, so the fleet looks fine.                                |
| `registered: 0`                                                  | Registration never converged       | `/api/health/ready`. Usually the database was unreachable at boot; it retries every 60s and says so every ten (#162). |
| **`available: true`, and every run fails at auth**               | **Credential missing or wrong**    | **Nowhere useful.** See below.                                                                                        |

### Why the last row is the one to worry about

`claude --version` **succeeds without credentials.** That is the probe the runner
uses to decide it is available — so an unauthenticated CLI registers as a _healthy_
runner, dispatch routes real work to it, and every run fails after the work order
has already been authorized and its execution record posted.

A missing binary is the honest failure: it is visible in the health payload the
moment it happens, and nothing is dispatched. A present-but-unauthenticated one is
the deceptive failure, and it is why step 2 has its own verification command
instead of trusting step 3 to catch it.

This is #61's warning about the capability manifest, arriving from an unexpected
direction: the manifest is not overstated by any code here, it is overstated by the
_environment_ the code is honestly reporting on.

---

## What persistence does and does not buy

`RUNNER_WORKSPACE_ROOT` and the CLI's state directory are named volumes (#327), so
they survive a container being replaced. **Verified** with a control, so the result
means something:

```
$ docker exec opifex-api-1 sh -lc 'echo marker > /var/tmp/opifex/workspaces/.probe; echo layer > /tmp/layer-probe'
$ docker compose -f base.compose.yml -f prod.compose.yml up -d --force-recreate api
$ docker exec opifex-api-1 sh -lc 'cat /var/tmp/opifex/workspaces/.probe; cat /tmp/layer-probe'
marker
cat: can't open '/tmp/layer-probe': No such file or directory
```

The volume file survived; the writable-layer control did not.

**A live run still does not survive a restart.** ADR-0008 makes the agents children
of the API process, so restarting this container kills every run in flight. The
volume preserves the checkout, not the work — which is exactly what makes a
re-submitted work order a reuse rather than a fresh clone (#18), and nothing more.

This is the standing cost of running the agent inside the API container. Moving
execution to a machine reached over SSH would remove it, and would cost the
cancellation guarantee ADR-0008 rests on: `kill(-pgid, …)` is verifiable locally
and is not, unmodified, across a network hop. That is a decision for an ADR, not a
configuration change.
