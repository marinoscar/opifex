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

## The order matters

The two enable flags are independent, and flipping both at once throws away the
only cheap chance to check that the runner registers **honestly** before anything
is routed to it:

| Flag                        | What it governs                            |
| --------------------------- | ------------------------------------------ |
| `CLAUDE_CODE_LOCAL_ENABLED` | Whether this runner is _dispatchable_      |
| `DISPATCH_ENABLED`          | Whether the queue drains to **any** runner |

> **Both are now flipped from the Control Center, not `.env`.** Since epic
> #332, `CLAUDE_CODE_LOCAL_ENABLED` (`runners.claudeCodeLocal.enabled`) and
> `DISPATCH_ENABLED` (`dispatch.enabled`) are operator-managed keys with
> `live` reload — an Admin toggles them at `/admin/settings` → Configuration
> and the next dispatch decision honours it, no restart. The `.env` values
> below still exist and still matter as the floor a fresh container boots on,
> but they are no longer the recommended way to make this specific change.
> See [`docs/operator-configuration.md`](operator-configuration.md).

Availability is a third, separate thing, and it is **observed rather than
configured**: the runner probes `claude --version` and reports what it found.
That is why step 3 below is worth doing while dispatch is still off — the fleet
tells you whether the container is capable before you give it anything to do.

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

---

## Step 2 — the credential

**Still a `.env` edit, not a Control Center one.** `CLAUDE_CODE_OAUTH_TOKEN`
is a registered secret key (`runners.claudeCodeLocal.oauthToken`), but the
Control Center screen that would let you paste a credential into a form —
Credentials — is issue #349 and has not shipped; it shows as "planned" at
`/admin/settings` today. `ANTHROPIC_API_KEY` is not a managed key at all and
is env-only, permanently. So both rows below are still `.env`, the same as
before this epic.

**A container cannot complete an interactive `claude auth login`.** The credential
has to arrive through the environment, and it needs no wiring beyond `.env`:
`base.compose.yml` loads the whole file with `env_file`, and both variable names
below are on the agent subprocess's inheritance allowlist
(`apps/api/src/runners/process/child-environment.ts`). Nothing else in `.env`
reaches the agent — since #334 the child gets that allowlist rather than the
API's whole environment, so `JWT_SECRET`, `POSTGRES_PASSWORD` and `GITHUB_TOKEN`
are absent from it.

Pick exactly one, and understand which pool you are spending from:

| Variable                  | Spends                   | The cost                                                                                                                                                            |
| ------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLAUDE_CODE_OAUTH_TOKEN` | Your Claude subscription | Automated runs compete with **your own interactive use** for one quota — VISION §11. `CLAUDE_CODE_MAX_CONCURRENCY` is what leaves you room.                         |
| `ANTHROPIC_API_KEY`       | Per-token API billing    | No quota contention; lands on the hard spend ceiling (#65) instead, which can only be applied to the **next** attempt because the CLI reports cost once at the end. |

A subscription token comes from `claude setup-token` on a machine where you are
already logged in. Neither variable is defaulted in `.env.example`, deliberately:
which quota an autonomous agent spends is an operator's decision, not something to
inherit from an example file.

Verify it **directly**, inside the container, and do not skip this:

```bash
docker exec opifex-api-1 sh -lc 'cd /tmp && claude -p --output-format=text "reply with the single word: ok"'
```

Anything other than a normal completion here — an auth prompt, a 401, a hang —
means the credential did not arrive, and **step 3 will not tell you that**. See
the failure table.

> **Not exercised on the reference deployment.** Everything else in this runbook
> was run and its output pasted verbatim; this step was not, because it needs a
> real credential and putting one on a host is the operator's call. The command
> above is the check to run, not a transcript of one.

---

## Step 3 — enable the runner, with dispatch still off

First, confirm the fleet with nothing flipped yet — no `.env` edit, no restart,
just the container as it already booted:

```bash
curl -s https://<your-host>/api/health/ready | jq .data.info.fleet
```

**Observed** on the reference deployment, immediately after the epic #324 rebuild
and _before_ any flag was flipped:

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

Now flip the runner on. From the Control Center: `/admin/settings` →
**Configuration** → the **Runner** group → _Local Claude Code runner
enabled_ → switch it on → Save. Or, scripted, with an access token minted by
an interactive login — this endpoint refuses a personal access token or a
device-flow token outright, see
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
facts, only one of which you just changed.

---

## Step 4 — hand off

Only now flip `dispatch.enabled` — the same way, from Configuration or via
`PATCH /api/operator-settings` — and go to
[`RUNBOOK-observation-week.md`](RUNBOOK-observation-week.md). That runbook owns
what to watch once work is actually moving; this one is finished when the fleet
says the container is capable.

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
