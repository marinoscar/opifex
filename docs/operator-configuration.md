# Operator Configuration

Epic #332 moved a specific, closed set of operational tunables — dispatch, the
`claude-code-local` runner, the reconciler, GitHub, the AI supervisor, the
promotion ladder and notifications — out of `.env`-and-restart and into a
database-backed layer an Admin can edit from the browser, live, at
`/admin/settings` → **Configuration**. This document is the map for that
layer: where a value actually comes from, what changing it actually does, and
the one failure mode it introduces that has no code-level recovery.

It exists because leaving `infra/compose/.env.example` and `CLAUDE.md`
presenting these variables as _the_ way to configure Opifex is precisely how
an operator edits `.env`, restarts, sees nothing change, and concludes the
application is broken — most of these keys now resolve from a database row
that outranks the environment, and a `.env` edit against a key that already
has a stored override does nothing at all until that override is cleared.
This is the single likeliest confusion epic #332 creates, and this document
is the fix for it.

## Table of contents

- [What actually moved, and what did not](#what-actually-moved-and-what-did-not)
- [The Control Center](#the-control-center)
- [Resolution order: `default → env → DB row`](#resolution-order-default--env--db-row)
- [Reload semantics: three values, and the third is the point](#reload-semantics-three-values-and-the-third-is-the-point)
- [Reading the API response](#reading-the-api-response)
- [Who can change what](#who-can-change-what)
- [Secrets at rest, and `OPIFEX_SETTINGS_ENCRYPTION_KEY`](#secrets-at-rest-and-opifex_settings_encryption_key)
- [Losing the encryption key: there is no recovery](#losing-the-encryption-key-there-is-no-recovery)
- [The hard spend ceilings](#the-hard-spend-ceilings)
- [Finding a specific key](#finding-a-specific-key)

---

## What actually moved, and what did not

The single declaration point for every operator-managed key is
`apps/api/src/settings/operator-settings/operator-settings.registry.ts`. If a
question about a specific key's default, its reload behaviour, its group, or
whether it is a secret has an answer, that file is where the answer is
authoritative — this document explains the _shape_ of the system the registry
describes, not a second copy of its 39 entries. `infra/compose/.env.example`
carries the same list, one section at a time, annotated at the point each
variable is now managed.

**Not everything in `.env.example` moved, on purpose.** The registry's own
header names what stayed out and why:

- `POSTGRES_*`, `JWT_*`, `COOKIE_SECRET`, `GOOGLE_*`, the S3/AWS variables,
  `OTEL_*`, ports, URLs, `LOG_LEVEL`, `DEVICE_*`, `STORAGE_*` and the VAPID
  key pair are set once, at deployment time, and epic #332 never targeted
  them.
- `ANTHROPIC_API_KEY` (the per-token billing alternative to
  `CLAUDE_CODE_OAUTH_TOKEN`) is not a managed key.
- The four hard spend ceilings ARE managed, as of #345 — but they are the one
  group whose editability was argued for on the record rather than assumed.
  See [The hard spend ceilings](#the-hard-spend-ceilings) below.

## The Control Center

`/admin/settings` (`apps/web/src/pages/ControlCenterPage.tsx`) is one screen
with several sections, selected by `?section=`, declared in
`apps/web/src/config/controlCenter.ts`:

| Section           | What it is                                                                                                                                                                                            | Status            |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| **Readiness**     | The chain from an installed binary to a repository the factory may work in, each step showing what was actually observed. Landing section.                                                            | live (#347)       |
| **Interface**     | Application-wide UI policy — `ui.allowUserThemeOverride` and friends — stored in `system_settings`, a different document from everything else on this page (see below).                               | live (#347)       |
| **Configuration** | Every operator-managed key from the registry, generated — not hand-listed — from `GET /api/operator-settings`. This is the screen this document is mostly about.                                      | live (#348)       |
| **Credentials**   | The Claude credential, the GitHub token and the spend ceilings, stored encrypted, shown masked, and tested rather than assumed. Also where a Claude subscription is connected without a shell (#386). | live (#349, #386) |
| **Repositories**  | The enablement ladder — register, observe, then dispatch.                                                                                                                                             | live (#350)       |
| **History**       | Who changed which setting, when, and what it was before.                                                                                                                                              | live (#351)       |

**Configuration and Credentials are not the same screen, and the split is
deliberate.** `GET /api/operator-settings` returns every managed key, secrets
included, and the Configuration section renders a row for each one — but a
secret row is read-only there: it shows `configured`, `source`, a masked
`hint` and `updatedAt`, never a value, and offers no field to type a new one
into (`apps/web/src/components/controlcenter/SettingRow.tsx`). Rotating a
credential is a different act from tuning a knob, and it lives on Credentials,
where it needs `operator_settings:write_secret` **and** an interactive session
on top of `system_settings:write`.

All three secrets — `github.token`, `runners.claudeCodeLocal.oauthToken` and
`supervisor.model.apiKey` — are set from Credentials now (#349). No `.env`
edit, no restart.

**The Claude subscription token additionally has a Connect flow, because it is
the one credential you cannot paste from memory (#386).** It comes out of
`claude setup-token`, which needs a TTY, which used to mean getting a shell
into the API container — the exact `.env`-editing loop this epic exists to end,
and the step operators were most likely to give up on, because it is the first
one and the least like anything else in the product. Credentials now runs that
CLI for you:

| Endpoint                                                   | What it does                                                                               |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `POST /api/operator-settings/claude-auth/start`            | Starts `claude setup-token` on a pseudo-terminal and returns the OAuth `url` it prints.    |
| `GET /api/operator-settings/claude-auth/{sessionId}`       | Polls it. `awaiting_code` → `exchanging` → `completed`, or `failed`/`cancelled`/`expired`. |
| `POST /api/operator-settings/claude-auth/{sessionId}/code` | Writes the pasted code to the CLI's stdin and finishes the exchange.                       |
| `DELETE /api/operator-settings/claude-auth/{sessionId}`    | Cancels, and kills the CLI's process group.                                                |

You open the URL, sign in to the Claude account whose subscription should pay
for automated runs, authorise, and paste the code back. **The token is never
returned to the browser.** It goes from the CLI's stdout straight into
`runners.claudeCodeLocal.oauthToken` through the same sealed write a manual
entry uses, so History records it as `set` and the Readiness step flips; the
response says `configured: true` and nothing more.

Three things worth knowing before clicking it:

- **One sign-in at a time.** A second `start` while one is live answers `409`
  and names the session to cancel. Two concurrent flows would each mint a real
  token against your account and one would be thrown away.
- **A session expires after ten minutes and accepts exactly one code.** The
  authorization code the browser hands you is itself only good for a few
  minutes, so keep the two tabs side by side. A rejected code ends the session
  — start a new one rather than retrying, because the challenge is spent.
- **A personal access token cannot do this**, no matter what permissions it
  carries. The route requires an interactive session (#346), and finishing the
  flow needs a human in a browser regardless.

The failures are told apart rather than collapsed into "authentication
failed": a wrong or expired code, an account that cannot issue a subscription
token (no plan, on hold, or an organisation that has turned off Claude Code
access), a missing CLI, a missing pseudo-terminal, and a session nobody
answered in time each get their own message and their own remedy.

`ANTHROPIC_API_KEY` — the per-token billing alternative — is deliberately NOT
part of this. It is a different credential with a different cost model, is not
a managed key, and stays env-only.

Everything else — every non-secret key across GitHub, the runner, dispatch,
the reconciler, the supervisor, promotion and notifications — is editable from
Configuration.

**Interface is a different document from Configuration, and collapsing them
would be wrong.** Interface reads and writes `system_settings`, the JSONB
document behind `GET/PATCH /api/system-settings` that reaches every user
through `/auth/me` — the same table the old three-tab System Settings page
used. Configuration reads and writes `operator_settings`, the table this
document is about. They have different storage, different permission
stories, and different reload rules, and `controlCenter.ts`'s own header
explains why they are kept apart rather than merged into one settings blob.

## Resolution order: `default → env → DB row`

Every managed key resolves through exactly three layers, checked in this
order, in `OperatorSettingsService.resolve()`
(`apps/api/src/settings/operator-settings/operator-settings.service.ts`):

1. **The registry's own hardcoded `default`.**
2. **The environment variable**, if it is set to something non-empty. `.env`
   files are full of `FOO=` meaning "unset", and `environmentValue()` treats a
   blank or whitespace-only variable as absent for exactly that reason —
   otherwise every string setting would resolve to `''` instead of falling
   through.
3. **A row in the `operator_settings` table**, if one exists for that key.

**Absence at any layer falls through to the next layer; it is never read as
a value.** This is not a minor implementation detail — it is the rule
`common/schemas/user-settings-namespaces.schema.ts` already fought for the
user-settings side of the codebase, applied one layer further out (ADR-0018
§2). Concretely: `reconciler.enabled` defaults to `false`. If neither
`RECONCILER_ENABLED` nor a database row exists, the key resolves to `false`
because the _default_ says so — never because "absent" was coerced to
`false` by a careless `?? false` somewhere on the read path. That distinction
is not academic for `supervisor.standDownWhenBlocked`, which is the one
switch in the whole registry that defaults **on**: an absent-coerces-to-false
bug on that specific key would silently invert it.

**A stored row always outranks the environment**, which is the part that
actually produces the "I edited `.env` and nothing happened" confusion this
document exists to head off. If an Admin has ever changed `dispatch.enabled`
from the Control Center, the resulting database row wins over
`DISPATCH_ENABLED` in `.env` on every subsequent read, for as long as that
row exists — a later `.env` edit to the same variable is invisible until the
row is cleared.

**Clearing a row reverts to the environment, not to the hardcoded default.**
`PATCH /api/operator-settings` treats a key set to JSON `null` in the request
body as "delete the stored row for this key" (`OperatorSettingsController.patch`,
`OperatorSettingsService.clear()`) — and reverting lands on whatever the
environment currently says, falling all the way back to the code default only
if the environment says nothing either. Concretely: an operator who set
`DISPATCH_RETRY_CEILING=5` in `.env`, then overrode it to `10` from the
Control Center, then reverted it from the Control Center, gets back **5**,
not the registry's own default of `3`. The environment layer is a real,
deliberate choice an operator already made outside the running system, and a
revert must not erase it.

## Reload semantics: three values, and the third is the point

Every key in the registry declares a `reload` value, and the Control Center
shows it as a chip next to the control (`SettingRow.tsx`). There are three,
and each is a real, checkable claim about what the code that reads the key
actually does — not a guess about how "live" a setting sounds:

**`live`** — nothing anywhere holds a copy of the value. The next read
decides, and no work already in flight contradicts the new value.

> **Worked example: `dispatch.enabled`.** `run-executor.service.ts` and
> `fleet-state.service.ts` both read this key at the moment of the dispatch
> decision, with nothing cached. Flip it off from the Control Center and the
> very next tick of the executor stops starting new runs — there is no
> restart, no propagation delay beyond the current tick, and no interval to
> wait out. `reconciler.enabled` has the identical shape: `ReconcilerTask`
> now registers its `setInterval` **unconditionally** at boot (ADR-0018 §5)
> and re-reads `reconciler.enabled` inside the callback on every firing, so
> turning it on from the Control Center is honoured by the very next
> scheduled tick — up to `reconciler.intervalMs` away, never a restart.
> There is one asymmetry worth knowing before you go looking for
> confirmation: the boot log line
> `Reconciler tick registered every 60000ms; the reconciler is ENABLED` (or
> `DISABLED`) prints once, at startup, from whatever the key resolved to at
> that instant — flipping the key afterward does **not** print a second
> confirmation line. The disabled skip logs at `debug` specifically so a
> deployment that leaves the reconciler off does not fill its logs with a
> no-op every interval. To see that a live toggle actually took effect,
> read the tick log (`GET /api/reconciler/ticks`), not the boot line.

**`next-unit`** — the next read decides for work not yet started, but work
already in flight carries a copy of the old value, because that copy is
sitting in an armed timer, a spawned process's argv, a workspace's git
config, or a running agent's own occupancy of a concurrency slot that a
lowered ceiling cannot retroactively shrink.

> **Worked example: `runners.claudeCodeLocal.maxConcurrency`
> (`CLAUDE_CODE_MAX_CONCURRENCY`).** `claude-code-local.runner.ts` reads this
> as the ceiling on _accepting a new submission_. Lowering it from 4 to 1 from
> the Control Center does not kill three agents that are already running — it
> stops the fourth from starting. The three keep occupying slots the runner
> is still honestly reporting as occupied until they finish on their own.
> `dispatch.maxConcurrent` (the fleet-wide ceiling, distinct from this
> per-runner one) behaves the same way for the identical reason.

**`restart`** — there is no read path that would see a change while the
process is running, either because the value was used to _construct_
something once (a cache, a client) rather than to answer a query, or because
changing it mid-process would corrupt state already built under the old
value.

> **Worked example: `runners.claudeCodeLocal.workspaceRoot`
> (`RUNNER_WORKSPACE_ROOT`).** `RunWorkspaceService` re-reads this value on
> every call, which — the registry's own comment is explicit about this — is
> precisely the trap: it would _appear_ live, because nothing throws when you
> change it. But every workspace already on disk for a run still in flight
> sits under the _old_ root, and the reaper that cleans up finished
> workspaces looks under the _new_ one. Changing this while runs are live
> doesn't relocate them — it orphans them where nothing can find or clean
> them up. `github.etagCacheMaxEntries` is the cleaner version of the same
> class: the conditional-request cache is _constructed_ at that size by a
> module factory at boot, and resizing a live cache is not the same operation
> as building a new one at a different size.

**A `restart` key is not editable from the Control Center for the read path
to matter, but it is still writable** — the write lands in the database and
is honoured on the _next_ boot. The chip is what tells you not to expect
anything until then.

## Reading the API response

`GET /api/operator-settings` returns one document
(`apps/api/src/settings/operator-settings/dto/operator-settings-response.dto.ts`):

```jsonc
{
  "revision": 42, // null until the overlay has loaded once
  "status": "loaded", // or "unavailable" — the DB overlay couldn't be read
  "overlay": {
    "loadedAt": "2026-08-20T12:00:00.000Z",
    "attemptedAt": "2026-08-20T12:00:15.000Z",
    "overriddenKeys": 4, // how many keys currently have a stored row
    "stale": false, // true = "loaded before, unavailable now" (env values NOT what's in force)
  },
  "secretStorage": { "configured": true },
  "settings": [
    {
      "key": "dispatch.enabled",
      "group": "dispatch",
      "label": "Dispatch enabled",
      "help": "...",
      "type": "boolean",
      "reload": "live",
      "dangerous": true,
      "source": "database", // "default" | "env" | "database"
      "envVar": "DISPATCH_ENABLED",
      "secret": false,
      "value": true,
      "default": false,
    },
    // ...39 entries, secret ones shaped { secret: true, configured, hint, updatedAt } — never "value"
  ],
}
```

Two fields are worth understanding before you build anything against this
endpoint or debug a deployment through it:

- **`source` tells you which layer answered**, not what the value is worth.
  `env` and `database` are equally "real" — only `default` means nobody has
  configured anything.
- **`overlay.status: "unavailable"`** means the database could not be read at
  the time of the last refresh (every 15 seconds — see
  `OPERATOR_SETTINGS_REFRESH_INTERVAL_MS`), and every key on the page is
  currently resolving from environment/default only. `overlay.stale: true`
  distinguishes "a real overlay was loaded once and might now be out of
  date" from "no overlay has ever loaded, and env really is what's running"
  — both report as `unavailable`, and only the `stale` flag tells you which
  one you're looking at.

`PATCH /api/operator-settings` takes an `If-Match` header carrying the
`revision` from a prior `GET`. A stale revision answers `409` rather than
silently overwriting somebody else's change; `*` skips the check.

## Who can change what

Three permissions, and the third is not the real barrier:

- **`system_settings:read`** — required for `GET`. Unrestricted beyond that:
  automation observing configuration is exactly the thing this system wants
  more of.
- **`system_settings:write`** — required for any `PATCH`.
- **`operator_settings:write_secret`** — required _in addition_ to the above
  for a `PATCH` that touches a secret key (`github.token`,
  `runners.claudeCodeLocal.oauthToken`, `supervisor.model.apiKey`).

**The permission check is defence in depth, not the actual guarantee, and
saying so plainly matters more than the check itself.** What actually keeps
an autonomous agent away from these settings is two other pieces of the
epic, both preconditions the write path depends on:

- **#334** — the agent subprocess's environment is an allowlist
  (`apps/api/src/runners/process/child-environment.ts`), not an inherited
  copy of the API process's environment. An agent never holds a credential it
  could authenticate this endpoint with in the first place.
- **#346** — `PATCH /api/operator-settings` additionally requires an
  **interactive** session (`@Auth({ interactive: true })`, enforced by
  `InteractiveSessionGuard`). A personal access token or a device-flow token
  is refused with `403` no matter what permissions it carries — see
  [`personal-access-tokens.md`](personal-access-tokens.md) — and the attempt
  is written to `audit_events`. `GET` is unrestricted, so a script or a
  dashboard can still read configuration; only the write is gated on a human
  being present.

ADR-0018 §6 is explicit that both preconditions are required together,
"either one missing is sufficient to invalidate this decision, not merely
weaken it" — see [The hard spend ceilings](#the-hard-spend-ceilings) for why
that sentence matters beyond this section.

## Secrets at rest, and `OPIFEX_SETTINGS_ENCRYPTION_KEY`

A secret written through the settings API — from Credentials, or by a direct
API call — is never stored in the clear. It is sealed
with AES-256-GCM (`apps/api/src/common/crypto/secret-box.ts`), with the
setting key itself bound in as additional authenticated data — so a
ciphertext copied from one slot to another (`github.token`'s row pasted into
`supervisor.model.apiKey`, say, by a stray `UPDATE` or a restored backup)
fails to decrypt rather than silently taking effect somewhere it was never
authorised for.

Generate the data key once per deployment, and never reuse another
deployment's:

```bash
openssl rand -base64 32
```

Set it as `OPIFEX_SETTINGS_ENCRYPTION_KEY`. It must decode to exactly 32
bytes — anything else is rejected outright.

**Leaving it unset does not stop the API from booting**, deliberately, the
same way a missing `GITHUB_TOKEN` or missing Google OAuth credentials do not
(see `apps/api/src/config/env.validation.ts` for the reasoning behind which
variables _are_ hard boot failures — `JWT_SECRET` is, this is not). Without
it:

- Everything unrelated to secrets works exactly as normal.
- Every read of a secret key falls back to whatever the environment says
  (`GITHUB_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `SUPERVISOR_MODEL_API_KEY`).
- Any attempt to **store** a secret through the API answers `503`, naming the
  variable.

## Losing the encryption key: there is no recovery

Say this plainly, because softening it is how someone finds out the hard
way: **if `OPIFEX_SETTINGS_ENCRYPTION_KEY` is lost — a wiped host, an
unbacked-up `.env`, a container recreated without it, a secret manager entry
deleted — every credential stored through the operator-settings API becomes
permanently unreadable. There is no rotation tool, no re-derivation, no
recovery path.** The key is not a password that can be reset; it is not
derived from anything else stored anywhere in this system, and no copy of
the plaintext it protects exists outside the ciphertext it encrypted.

What actually happens when the key is gone or has changed: every stored
secret row fails to open. `OperatorSettingsService.resolve()` treats a failed
decrypt as `error`, never as `absent` — this is the one resolution rule in
the whole service with no fallthrough, on purpose. A row that fails to open
does **not** fall back to the environment variable, because that would
silently resurrect a credential you had already rotated _away_ from, and
every call would keep working, which is exactly why nobody would notice.
Instead the key resolves to "not configured" and the Control Center's
Configuration section shows the row with an `error` — `key_unavailable` if
the environment variable itself is gone, `decrypt_failed` if a key is present
but wrong.

**The only way forward is to stop trying to recover the old ciphertext and
issue new credentials instead:**

1. Set (or restore) a working `OPIFEX_SETTINGS_ENCRYPTION_KEY` — a new one is
   fine; there is nothing left to be compatible with.
2. Delete the stored rows for every secret key that fails to open — the Clear
   action on Credentials, or a `PATCH /api/operator-settings` with the key set
   to `null` (which is `OperatorSettingsService.clear()` — see
   [Resolution order](#resolution-order-default--env--db-row)). Clearing the
   row reverts that key to whatever `.env` currently holds, or to "not
   configured" if `.env` holds nothing either.
3. **Issue new credentials at the provider** and store them again from
   Credentials: a new fine-grained GitHub token, a new Anthropic API key, and,
   for the Claude subscription, the Connect flow above rather than a hand-run
   `claude setup-token`.
   The old ones cannot be recovered from the encrypted rows, and rotating the
   provider-side credential is the only way to be certain the one that is now
   unreadable cannot be used by anyone who does have a copy of the ciphertext
   and later guesses or obtains the old key.

## The hard spend ceilings

`OPIFEX_HARD_SPEND_CEILING_USD`, `OPIFEX_HARD_SPEND_CEILING_WINDOW_DAYS`,
`SUPERVISOR_HARD_SPEND_CEILING_USD` and `SUPERVISOR_HARD_SPEND_CEILING_WINDOW_DAYS`
are the one deliberate exception to "everything above is now a registry key" —
and the sharpest one, because whether they should be editable at all is a
decision this epic had to argue for, on the record, rather than assume.
ADR-0018 §6 (`docs/adr/0018-operator-settings-resolution-and-ceilings.md`)
is that argument in full; this section states the outcome and — as of this
writing — exactly how much of it has shipped.

**Until this epic, the guarantee that no runtime path exists to a higher
ceiling was structural.** `apps/api/src/budget/hard-spend-ceiling.ts` and
`apps/api/src/supervisor/invocation/supervisor-spend-ceiling.ts` both read
`process.env` exactly once, in the constructor, into `readonly` fields with
no setter anywhere in either class. There was no code path from any
endpoint, any trust grant, or any agent to this number — not a restricted
one, _no_ one — because nothing in the running process could reach it even
if it were compromised.

**ADR-0018 §6 decides to give that up, on purpose, and names the trade
rather than hiding it.** The ceilings become ordinary managed keys, writable
through `OperatorSettingsService`'s admin-gated `PATCH`, exactly like
`dispatch.retryCeiling` or `reconciler.intervalMs`. The guarantee moves from
**structural** ("no code path exists, for anyone") to **access-controlled**
("a code path exists, and an agent provably cannot reach it") — and the ADR
is explicit that access control is the strictly weaker of the two claims,
with a failure mode structural guarantees do not have: something other than
a deliberate human admin action reaching the write path.

The ADR conditions the migration on the same two preconditions described in
[Who can change what](#who-can-change-what) above, and is explicit that
either one missing invalidates the decision rather than merely weakening it:
**#334** (the agent subprocess's allowlisted environment) and **#346** (the
interactive-only write guard). Both are landed in this codebase as of this
writing — `child-environment.ts` is an allowlist, and
`operator-settings.controller.ts`'s `PATCH` carries
`@Auth({ interactive: true })`, enforced by `InteractiveSessionGuard`.

**That migration has now landed (#345).** All four are registry keys, all
four are flagged `dangerous`, and both services resolve them through
`OperatorSettingsService` — so a ceiling changed in the Control Center is in
force for the next admission decision without a restart.

Two details of that implementation are worth knowing before you touch one.
The two **dollar figures are declared as string settings, not numbers**, and
deliberately so: `parseHardCeiling` distinguishes three states — a figure,
unset, and _malformed_ — and a numeric schema would reject a typo like `50O`
at the registry, resolve the key to its default, and report it identically to
"nobody set one", collapsing malformed into unset at exactly the layer built
to keep them apart. And the services' **setter takes no argument**: `refresh()`
can only take what came through the resolver, which is to say through an
audited, interactive, RBAC-gated write. A public `set(usd)` would hand any
holder of the instance the ability to raise the limit with nothing recording
it, which is the hazard these two files were originally written against.

`operator-settings.registry.spec.ts` used to assert the four keys were
**absent**, as a guard against adding them before the two preconditions were
real. That test was inverted rather than deleted: it now asserts they are
present, `dangerous`, non-secret, that the USD keys are strings, and that they
still round-trip a malformed `'50O'`.

VISION.MD §8's never-trustable list was amended in the same change. The clause
that read "modifying CI workflows, the policy table, or budget configuration"
is now split: CI workflows and the policy table stay unconditionally
never-trustable, while budget configuration is qualified to mean _outside an
interactive, RBAC-gated admin action_. Nothing an agent can reach changed.
"A limit an agent can raise is not a limit" still holds exactly as written —
what is admitted is that the operator is not an agent.

## Finding a specific key

For "what does this key actually do, and when does a change take effect":

1. `apps/api/src/settings/operator-settings/operator-settings.registry.ts` —
   authoritative. `label`, `help`, `default`, `reload`, `group`, `secret` and
   `dangerous` for every key, plus the reasoning behind each `reload` value
   in an inline comment.
2. `infra/compose/.env.example` — the same 39 keys, one per environment
   variable, each annotated at the point it is defined with whether it moved
   and what "moved" means for that key specifically.
3. `GET /api/operator-settings`, or the Configuration section of the Control
   Center, for what a _running deployment_ currently resolves to and where
   that value came from — the registry describes the code; this describes
   the instance.
