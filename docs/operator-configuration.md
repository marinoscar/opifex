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
- [The supervisor's model: provider, base URL and price](#the-supervisors-model-provider-base-url-and-price)
- [The chat's model: a second consumer, called but not yet spending](#the-chats-model-a-second-consumer-called-but-not-yet-spending-425)
- [Resolution order: `default → env → DB row`](#resolution-order-default--env--db-row)
- [A value that cannot be read: where it lands, and the three keys that are special](#a-value-that-cannot-be-read-where-it-lands-and-the-three-keys-that-are-special-441)
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
describes, not a second copy of its entries. `infra/compose/.env.example`
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
| **Repositories**  | A signpost, not a screen. The enablement ladder that used to live here moved to `/projects` (#406) — see below.                                                                                       | signpost (#406)   |
| **History**       | Who changed which setting, when, and what it was before.                                                                                                                                              | live (#351)       |

**Repositories is a signpost rather than a screen, and that is a change from
how this table used to read.** The operator's own objection is recorded in
`ProjectsPage.tsx`'s header comment: _"repository selection should not be a
configuration, should be a main feature like projects, make sure is part of
the main menu."_ Until #406, the enablement ladder — register, observe, then
dispatch — lived on this Control Center section, reached only by an Admin who
also held `system_settings:read`. It now lives on `/projects`
(`apps/web/src/pages/ProjectsPage.tsx`), gated on `projects:read` /
`projects:write` — the pair `RepositoriesController` and `ProjectsController`
already enforced — so an account that manages repositories but is not a
Control Center Admin can reach it directly instead of being handed a
permission it does not need. The Repositories section here now renders no
repository list at all: it says where the ladder went and links there, the
same treatment the supervisor model panel got when it moved to Credentials
(#394). If a runbook or an older screenshot still says "Control Center →
Repositories → Add repository", that instruction is stale — the destination
is `/projects` now, and `docs/RUNBOOK-observation-week.md` §4 has been
corrected to match.

**Configuration and Credentials are not the same screen, and the split is
deliberate.** `GET /api/operator-settings` returns every managed key, secrets
included, and the Configuration section renders a row for each one — but a
secret row is read-only there: it shows `configured`, `source`, a masked
`hint` and `updatedAt`, never a value, and offers no field to type a new one
into (`apps/web/src/components/controlcenter/SettingRow.tsx`). Rotating a
credential is a different act from tuning a knob, and it lives on Credentials,
where it needs `operator_settings:write_secret` **and** an interactive session
on top of `system_settings:write`.

All secrets are set from Credentials now (#349), no `.env` edit and no
restart: `github.token`, `runners.claudeCodeLocal.oauthToken`, and — since
#422 split the single shared model credential into one slot per provider —
one API key per supervisor model provider (`models.anthropic.apiKey`,
`models.openai.apiKey`, generated one per entry in
`SUPERVISOR_MODEL_PROVIDERS` rather than hand-listed, so a third adapter
gets its own card with no edit here).

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

## The supervisor's model: provider, base URL and price

The AI supervisor (VISION §7) has spoken to exactly one vendor since
ADR-0015 and now speaks to two, Anthropic and OpenAI (epic #391). Two
settings, under the `supervisor` group in the registry, describe _which_
vendor and _which_ model — `supervisor.model.provider` and
`supervisor.model.name`. The credential and its endpoint are a separate
question, and since #422 they are not one shared pair of keys but one pair
**per provider**, under a new `models` group: `models.anthropic.apiKey` /
`models.anthropic.baseUrl` and `models.openai.apiKey` /
`models.openai.baseUrl`, generated from `SUPERVISOR_MODEL_PROVIDERS`
(`supervisor-model.config.ts`) rather than declared by hand, so a third
adapter gets its own slot with no registry edit. What follows is the
operator-facing shape of that decision; the code-facing shape is
`apps/api/src/supervisor/invocation/supervisor-model.config.ts`.

**Since #423 the supervisor is no longer the only thing asking these
questions.** The chat has its own `chat.model.provider` / `chat.model.name`
pair, under a separate `chat` group, resolved through the identical function
with `'chat'` in place of `'supervisor'` — see
[The chat's model](#the-chats-model-a-second-consumer-called-but-not-yet-spending-425) below.
Everything in the rest of this section — the provider selection, the base
URL rule, the per-provider credential slots, the model picker and the
pricing table — is written from the supervisor's side because the supervisor
is the consumer that predates #423 and the one the pricing/spend-ceiling
machinery still exists for exclusively; the provider and credential
machinery itself is shared by both consumers identically, and none of it is
a "the supervisor's model" fact anymore, only a "this consumer's model" one.

**Why the credential is a property of the provider and not of the
supervisor.** Before #422 there was one `supervisor.model.apiKey`, so an
operator holding both an Anthropic key and an OpenAI key could store only
one at a time, and switching `supervisor.model.provider` destroyed whichever
key was not selected. A credential belongs to the vendor that issued it, not
to whichever consumer is currently asking; the same argument applies to the
base URL, because the key is sent to whatever host is named — "which host"
and "which key" are one fact, and a shared override across two providers
would post one vendor's credential to another vendor's proxy. Splitting the
slot by provider means switching `supervisor.model.provider` now selects the
other stored key instead of finding the same one and posting it to a host
that will reject it, and neither entering a key nor losing one is tied to
which provider happens to be selected today.

**`supervisor.model.provider` (`SUPERVISOR_MODEL_PROVIDER`, `anthropic |
openai`) selects two things at once: which adapter answers, and which
provider's credential slot is read.** Nothing else in the registry, or in
this document, names a vendor's endpoint — `supervisor-model.port.ts`'s own
rule is that nothing outside `apps/api/src/supervisor/invocation/` may name
a model provider, and the operator-facing settings inherit that discipline:
change the provider and the model name, the key and the base URL that answer
for it all follow, without being retyped.

**The base URL rule is subtle enough to state precisely, because getting it
wrong here is exactly how a credential ends up posted to the wrong vendor.**
`models.<provider>.baseUrl` (`MODEL_<PROVIDER>_BASE_URL` — e.g.
`MODEL_ANTHROPIC_BASE_URL`) resolves in three cases, checked in this order
(`effectiveBaseUrl` in `supervisor-model.config.ts`):

1. **Empty** (the default) → the selected provider's own published host —
   `https://api.anthropic.com` or `https://api.openai.com`.
2. **A value equal to _any_ provider's published host** — not only the
   currently selected one — → also the selected provider's host. This
   clause is the migration path, and it exists for a concrete reason: before
   #392, `infra/compose/.env.example` shipped
   `SUPERVISOR_MODEL_BASE_URL=https://api.anthropic.com` uncommented, so
   almost every existing deployment has this variable set explicitly rather
   than left blank. Without this clause, changing `supervisor.model.provider`
   to `openai` on one of those deployments would keep the base URL pinned to
   Anthropic's host and post an OpenAI key there — a credential sent to a
   host that will simply reject it, silently from the operator's point of
   view until the decision log is read.
3. **Anything else** — a proxy, a gateway, a test double — → used verbatim,
   on whichever provider is selected. This is the real override the setting
   exists for.

**The model itself is chosen from a dropdown of what the configured key can
actually reach, not typed as free text, and it lives on the Credentials
screen rather than on Configuration (#394).** Before epic #391 an operator
typed a literal catalogue string into `supervisor.model.name` and found out
about a typo once an hour in the decision log, with nobody watching.
`GET /api/operator-settings/supervisor-models`
(`SupervisorModelCatalogService`,
`apps/api/src/supervisor/invocation/model-catalog.service.ts`) asks the
configured provider what its configured key can see, and the Credentials
screen renders the answer as a picker. Since #423 the route also takes a
`consumer` query parameter (`supervisor`, the default, or `chat`) so it can
answer the same question for either consumer's own provider selection — see
[The chat's model](#the-chats-model-a-second-consumer-called-but-not-yet-spending-425) below
for what that parameter is for and what the response echoes back. Provider, key and model are now one
screen, one decision, for the reason the Configuration section states to an
operator who goes looking for `supervisor.model.name` there anyway: choosing
a model means asking the provider what the key can reach, so the provider,
the model name, and the selected provider's key and base URL are one control
on Credentials rather than a free-text box on Configuration. Configuration
still lists the model-related keys — as chips, read-only, under "Configured
on the Credentials tab" — with a button that jumps to Credentials, precisely
so a setting is never simply missing from the screen an operator expects it
on. (As of this writing the frontend composite control (`config/supervisorModel.ts`)
still names the pre-#422 singular `supervisor.model.apiKey` /
`supervisor.model.baseUrl` keys; verify against that file and
`CredentialsSection.tsx` for whether the per-provider keys have been wired
in yet.)

**The version filter's rule is worth stating exactly, including its one
counter-intuitive case: an id the filter cannot read is _shown_, not
hidden.** Every model the catalogue call returns is classified into one of
three states (`classifyModelId`,
`apps/api/src/supervisor/invocation/model-version.ts`): `admitted` (parses,
and at or above the floor), `below_threshold` (parses, and older), or
`version_unrecognised` (does not parse at all). Only the first two states
are ever hidden-vs-shown questions; the third is never hidden. The floor
itself is per provider — Anthropic at 4.6, OpenAI at 5.4 — and it is
**inclusive**: "above 5.4" is implemented as "5.4 and newer", so `gpt-5.4`
and `claude-opus-4-6` — the flagship ids the floor was written from — clear
it rather than falling just short of their own rule.

Failing open on an unrecognised id is deliberate, not an oversight: model
ids follow no stable scheme, either across vendors or across time for the
same vendor — Anthropic moved its own scheme once already, from a
mid-string version to a trailing one, which is why `claude-3-5-sonnet-20241022`
does not parse under today's rule even though it is a real, if superseded,
model id. The day a vendor changes its naming scheme again, the id that
stops parsing is exactly as likely to be the newest, most desirable model as
an old one — and hiding it would leave an operator staring at a dropdown
with no way to select the model they came to select, with no explanation
for why it is missing. So an unrecognised id is offered, marked "version not
recognised" rather than worded as a defect, and sorted directly below the
admitted models rather than buried beneath the ones below the floor — see
`sortForSelection` in `model-catalog.service.ts`.

**Listing models spends no tokens, and doing so is deliberate rather than
incidental — it doubles as a credential check.** `GET /v1/models` bills
nothing on either vendor's API, so the catalogue call can be pressed as
often as an operator likes while iterating on a key, and a successful list
is itself evidence the key authenticates: `SupervisorModelCatalogService`
reports `spendsTokens: false` on every answer, as a field rather than a
sentence baked into the UI, so a client never has to hard-code which of the
API's routes are free. This is deliberately not the same action as the
**Test** button elsewhere on Credentials, which makes one real, billed call
to confirm the model actually answers — the two exist side by side
precisely because "the key authenticates" and "the model answers and costs
what the table expects" are different findings, and collapsing them into one
button would hide which one failed.

### Migrating off the single shared key (#422)

Until #422 there was one `supervisor.model.apiKey` and one
`supervisor.model.baseUrl`, shared by whichever provider
`supervisor.model.provider` named. Three things carry a deployment that
already had one configured across the split without it re-entering anything:

**A stored key moves itself, once, at boot.** If a `supervisor.model.apiKey`
row still exists in `operator_settings` when the API starts,
`LegacyModelSettingsMigration` decrypts it and re-seals it under
`models.<provider>.apiKey`, where `<provider>` is whatever
`supervisor.model.provider` is set to _right now_ — the slot for the vendor
the key already meant, not the default vendor. It is a decrypt-and-reseal
rather than a `key = 'new.key'` update because `secret-box.ts` binds every
ciphertext to its setting key as AES-GCM additional authenticated data,
deliberately, so a ciphertext copied between slots fails to open rather than
silently decrypting into a use its owner never authorised — the same
property [described below](#secrets-at-rest-and-opifex_settings_encryption_key)
for the settings table generally. The new row is written **before** the old
one is deleted, on purpose: a crash between the two steps leaves the
credential in both slots, which the next boot reports as `occupied` — an
operator resolves that by deleting one row — rather than in neither, which
would not be recoverable. The migration refuses, leaving the legacy row
untouched, in exactly three named cases: `occupied` (the destination already
holds a value), `unreadable` (the stored ciphertext will not decrypt — see
below), and `rejected` (it decrypted, and the new key's schema does not
accept the value). None of the three aborts the boot.

**`SUPERVISOR_MODEL_API_KEY` and `SUPERVISOR_MODEL_BASE_URL` still work**,
through a declarative `legacyEnvVar` on the default provider's registry
entry, read only when the current name (`MODEL_ANTHROPIC_API_KEY` /
`MODEL_ANTHROPIC_BASE_URL`, since Anthropic is
`DEFAULT_SUPERVISOR_MODEL_PROVIDER`) is unset — with a warning at boot
naming the replacement. They attach to the **default provider's slot only**:
one ambiguous variable cannot honestly name a credential for two vendors, and
mapping it onto both slots would put an `sk-ant-` key in the OpenAI slot too,
ready to be posted there the next time `supervisor.model.provider` is
switched. A deployment that still sets the old variable _and_ has selected a
non-default provider is told so by name, as an error, at boot — that
combination is the one case the compatibility shim does not cover, because
covering it would recreate the exact cross-vendor leak the split exists to
prevent.

**An unreadable secret is now reported at boot, not at the next model
call.** `UnreadableSecretsBootCheck` resolves every registry key marked
`secret` once at startup and logs an error, naming the key and the remedy,
for any that fail to decrypt — where previously the first read of a model
credential was the first scheduled supervisor tick, up to an hour later,
buried inside an unrelated failure. It logs at `error` and does **not** abort
startup: unlike `JWT_SECRET`, an unreadable model credential voids no
authorization decision — every other request is still answered correctly,
and the adapter that needs the credential refuses per call and records the
refusal, which is a state an operator can be told about and act on rather
than one that takes the process down to report.

**Why the new variables are named `MODEL_*` and not `ANTHROPIC_API_KEY`.**
`ANTHROPIC_API_KEY` is already spoken for — it is one of the two credentials
`claude-code-local` itself authenticates with
(`apps/api/src/runners/process/child-environment.ts`), and it sits on that
file's inherited-environment allowlist so agent subprocesses can read it.
Reusing the name for the supervisor's separately metered credential (ADR-0015)
would have carried that credential into every agent subprocess, silently,
through a line that already existed — the sharpest hazard in this change, and
the reason it is written down here as well as in the allowlist's own
comments.

### The pricing table: a hand-maintained snapshot that says when it doesn't know

Neither vendor's API reports what a call is billed at — only how many
tokens it used — so converting a supervisor invocation's token counts into a
dollar figure requires a rate table this repository owns, maintains by
hand, and states as much:
`apps/api/src/supervisor/invocation/model-pricing.ts`'s header carries a
**"last checked"** date against each vendor's published pricing page and
argues, at length, for what the table does. Two vendors' rates live in it
side by side as of epic #391.

**A model this table has no rate for is priced at `null`, and the
supervisor's spend ceiling reports that rather than pretending the call was
free.** `assessSupervisorSpend`
(`apps/api/src/supervisor/invocation/supervisor-spend-gate.ts`) tracks an
`unpricedCalls` count alongside the dollar total it enforces against, and
when that count is non-zero the ceiling's own reason string says so in
words, not just a number an operator has to already know how to read:

> spent \$X across N invocation(s), plus an unknown amount across M model
> call(s) the price table has no rate for — so this figure is a floor, not
> a total

That sentence lands in a `skipped_budget` decision-log row's reason the
moment the ceiling is reached with unpriced calls in the window, and it
means the same thing every time: the spend ceiling is comparing against a
**floor**, not a total, and the true spend on unpriced calls could be higher
than what is shown. The gate deliberately does not refuse to run on an
unpriced model — doing so
would turn an ordinary, expected event (a model the table has not caught up
with yet) into an indefinite outage of the whole supervisor, which
`supervisor-spend-gate.ts`'s own header calls a worse failure than an
under-bounded floor. The under-count is bounded and it is always said; it is
never silent.

Three things the pricing table deliberately does not model, because the
supervisor's request shape does not reach them (see the file's header for
the full argument): the **long-context surcharge** both vendors charge past
a token threshold, which the supervisor's bounded, truncated snapshot never
crosses; **prompt-cache read and write rates**, because nothing in either
adapter caches a prompt; and the **discounted service tiers** — batch, flex,
and OpenAI's fast mode — because neither adapter requests one, so standard
pricing is what is actually billed.

**`daybreak-blue-latest` and `daybreak-red-latest` are deliberately absent
from the table, and that omission is not an oversight either.** Both are
aliases that OpenAI documents as pointing at whichever model is current —
and documents that the _pricing_ moves with the target. A fixed
rate keyed on either alias would be silently wrong the day it is
repointed, which is precisely the failure this table's whole design exists
to avoid: a wrong rate makes the spend ceiling confidently incorrect, where
a missing rate merely reports itself as unpriced. Anthropic's dateless
aliases (`claude-sonnet-4-0`, `claude-3-5-haiku-latest`, and similar) are a
different case and are priced: they resolve within one minor version, at
one price, so the alias cannot go stale in the same way.

## The chat's model: a second consumer, called but not yet spending (#425)

Until #423 (epic #419), the AI supervisor was the only thing in the API process that
asked a model a question, so "the supervisor's model" and "the model" were
the same sentence. They no longer are. `chat.model.provider`,
`chat.model.name`, `chat.model.timeoutMs` and `chat.model.defaultMaxTokens`
— a new `chat` group in the registry — describe a **second, independent
model consumer**, resolved by the same `resolveModelConfig(settings,
consumer)` in
`apps/api/src/supervisor/invocation/supervisor-model.config.ts` that the
supervisor has used since #392, called this time with `'chat'` instead of
`'supervisor'`.

**#425 shipped the caller. #426 — the chat surface a human would type
into — has not, and there is still no chat UI to describe here.**
`POST /api/steering/proposals` (`SteeringService.describeInterpretation`)
reads `chat.model.provider` / `chat.model.name`, through the same
`resolveModelConfig` / `modelReadiness` this section describes, whenever
`parseSteeringInstruction` cannot read an instruction confidently — so
configuring these four keys is no longer inert: it changes what
`interpretation.model` reports back on that response. **It still spends
nothing.** `chat-spend-gate.ts` refuses to admit a model call
unconditionally today, for a reason unrelated to whether a model is
configured (`apps/api/src/steering/chat-spend-gate.ts` — no durable spend
ledger exists for the chat to enforce a cumulative ceiling against, and
running a metered consumer with no bound is the failure #261 exists to
prevent) — so `interpretation.modelInvoked` is `false` on every response
regardless of how well-formed `chat.model.*` is. Configuring these keys
today changes an `available` flag in a JSON response; it still changes no
bill. See [`docs/API.md`](API.md) for `POST /api/steering/proposals`'s full
`interpretation` shape.

**No credential keys, and that absence is deliberate, not an oversight.**
There is no `chat.model.apiKey` or `chat.model.baseUrl`, mirroring the
supervisor's own shape since #422: a credential belongs to the _provider_,
not to whichever consumer is asking, and `chat.model.provider` **selects**
one of the existing `models.<provider>.apiKey` / `models.<provider>.baseUrl`
slots described in
[The supervisor's model](#the-supervisors-model-provider-base-url-and-price)
above rather than pairing with a slot of its own. The practical consequence:
store an Anthropic key once, on the Credentials screen, and both the
supervisor and the chat can be pointed at it — switching either consumer's
provider selects the matching slot, never asks for the key twice, and never
risks one consumer's request carrying the other's credential.

**Timeout and max-tokens are per consumer, not shared, and that split is a
decision, not a missed opportunity to reuse a field.** A shared timeout
would mean raising the supervisor's for a slower reasoning model makes the
chat hang for the same duration on every turn, and `defaultMaxTokens` bounds
two answer shapes that cannot share one ceiling: a supervisory judgement is
a paragraph (`supervisor.model.defaultMaxTokens` defaults to 1,024), where a
chat answer can run to a list as long as whatever it is enumerating
(`chat.model.defaultMaxTokens` defaults to 2,048 — double, not equal). A
truncated list of operations reads exactly like a complete one, which is the
failure a shared, lower ceiling would produce silently.

**`chat.model.timeoutMs` defaults to 30,000ms and caps at 55,000ms — not the
supervisor's 600,000ms ceiling — and the cap is not a round number.**
`infra/nginx/nginx.conf`'s `/api` location block sets `proxy_read_timeout
60s`. A chat turn allowed to run past that is not reported by the model
adapter at all: nginx answers the browser with its own 504 first, and that
response says nothing about which model was asked or why it did not answer.
Capping the setting at 55,000ms keeps the API's own `AbortSignal.timeout` —
and the refusal `unavailableReason`/`isAbort` compose from it — the thing
that actually fires, so an operator reads "no answer within 30000ms" instead
of a gateway timeout with no cause attached. The supervisor keeps its much
larger ceiling (60,000ms default, 600,000ms max) because no HTTP request is
waiting on it — a scheduled invocation nobody is watching can afford to run
for minutes.

**There is no `chat.enabled`, and an empty `chat.model.name` is the off
switch — deliberately, and deliberately the default.** The supervisor has
`supervisor.enabled` as a real switch, so naming its model spends nothing on
its own. The chat has no equivalent flag: naming a model in
`chat.model.name` **is** turning it on, because `modelReadiness` reports a
consumer with no model name as unconfigured and `noModelNamedError` refuses
the call. Shipping `CHAT_MODEL_NAME` with a default naming a real model
would make an ordinary upgrade start spending against a second metered
consumer in every deployment that already holds a provider key, silently —
precisely what `supervisor.enabled` defaulting to `false` exists to prevent
on the supervisor's side. A second flag here would not add safety; it would
add a second place to look for why a configured deployment is not
answering.

**`reload: 'live'` is declared for all four `chat.model.*` keys, and the
declaration is a contract for #425 to honour rather than an observation
about running code — because there is no running code yet to observe.**
`resolveModelConfig` is called fresh, per call, and caches nothing, which is
exactly what `live` means by this document's own definition — see
[Reload semantics](#reload-semantics-three-values-and-the-third-is-the-point)
above: nothing anywhere holds a copy of the value, so the next read decides.
That much is true today, mechanically, because the function has behaved this
way since #344 regardless of which consumer calls it. `chat.model.timeoutMs`
carries the one wrinkle every other `live` timeout in the registry already
has — `github.requestTimeoutMs`'s `help` text is worded almost identically:
a value change "applies to the next request; a request already in flight
keeps its own signal." A chat turn already waiting on
`AbortSignal.timeout(oldValue)` does not have that signal rewound by a
setting changed mid-turn; only the next turn honours the new number.

**The contract held: #425 reads `chat.model.provider` / `chat.model.name`
fresh on every call, and `reload: 'live'` remains true.**
`SteeringService.propose()` calls `resolveModelConfig(this.settings, 'chat')`
directly inside `describeInterpretation`, once per `POST
/api/steering/proposals` request, and caches nothing between calls — there
is no conversation for a resolved value to be cached across, because #425 is
a stateless propose/apply pair with no session of its own, and #426 (the
chat surface that would hold a conversation open across turns) is still
unbuilt. Whoever builds #426 inherits the same obligation this paragraph
originally stated as a forward contract: if that surface resolves its model
configuration once per conversation and reuses it across turns — a caching
shape `resolveModelConfig` does not itself prevent, since nothing about the
function forces a caller to call it again — a provider or model changed
mid-conversation would not take effect until the next conversation starts,
which is `next-unit`, not `live`, by the same definition this document uses
everywhere else, and the registry entries must be updated in the same change
that makes them stop being read per turn — a registry entry claiming `live`
for a value a caller actually caches is exactly the kind of drift this
document exists to catch.

**`GET /api/operator-settings/supervisor-models` gained a `consumer` query
parameter (#423), and the response echoes it back.** The route predates the
second consumer and its name still reflects that, but the model catalogue
behind it (`SupervisorModelCatalogService.list`) was always a function of
"which provider is the named consumer currently pointed at", never
hard-wired to the supervisor specifically. `?consumer=supervisor` (the
default, so the caller that already existed before #423 keeps working
unchanged) or `?consumer=chat` selects which of `supervisor.model.provider`
/ `chat.model.provider` to read, and the response's own `consumer` field
(`supervisorModelCatalogSchema`) reports which one answered — so a client
holding two lists at once, one per consumer, cannot render one consumer's
models under the other's control by mistake.

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
§2). Concretely: `reconciler.enabled` defaults to `true` (ADR-0019, #439). If
neither `RECONCILER_ENABLED` nor a database row exists, the key resolves to
`true` because the _default_ says so — never because "absent" was coerced to
some other value by a careless `?? false` (or `?? true`) somewhere on the
read path. That distinction is not academic: `reconciler.enabled`,
`runners.claudeCodeLocal.enabled`, `dispatch.enabled`,
`dispatch.allowPreviewRunner`, `dispatch.autoResumeParked`,
`github.writesEnabled` and `supervisor.standDownWhenBlocked` are the switches
in the registry that default **on** — an absent-coerces-to-false bug on any
one of them would silently invert it, which is precisely the failure mode
#439's own fix to `booleanSetting` (see the ADR) was written against for the
boolean parser one layer further down.

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

## A value that cannot be read: where it lands, and the three keys that are special (#441)

Layer 2 and layer 3 above both supply a _raw_ value that still has to parse.
When it does not — `DISPATCH_MAX_CONCURRENT=200`, `RECONCILER_INTERVAL_MS=soon`
— the key resolves to a fallback and the rejection is logged at `error` naming
the variable, the value that could not be read, and the value actually in
force. `resolve()` also reports it as `invalid` so the Control Center shows a
rejected value rather than presenting it as if it had taken effect.

**For most keys the fallback is the registry's declared `default`, and that is
right.** A mistyped timeout lands on a different number with no safety
direction, and taking the API down over it would be worse than the typo.

**For four keys it was wrong**, because the declared default was _more
permissive than any value the operator could have written_ — so a typo widened
a boundary it was written to narrow. Those four now behave differently, and
this is the full list:

| key                                        | a rejected value resolves to           | why not the default                                                                                                                                                                                                                                              |
| ------------------------------------------ | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dispatch.maxConcurrent`                   | **128**, the maximum                   | The default is `null` — _no fleet ceiling at all_. `DISPATCH_MAX_CONCURRENT=200` is out of range and a plausible thing to type when reaching for a **high** ceiling, not for none.                                                                               |
| `runners.claudeCodeLocal.permissionMode`   | **`plan`**, the narrowest mode         | The default `acceptEdits` lets the agent edit files. `ask`, `readonly` and `plan-only` are all plausible spellings of _stricter_, and all three used to land on a mode broader than what was asked for.                                                          |
| `github.apiBaseUrl`                        | **nothing — the API refuses to start** | The default names a host a credential is sent to. `GITHUB_API_BASE_URL=github.corp.example` (no scheme) would put a GitHub Enterprise deployment's fine-grained token on public GitHub, and every substitute is a guess about where somebody's secret should go. |
| `runners.claudeCodeLocal.gitRemoteBaseUrl` | **nothing — the API refuses to start** | The same hazard on the write path, and #441's own table missed it. Its help says the quiet part: _"The GitHub token is sent to whatever host is named here."_ A rejected `GIT_REMOTE_BASE_URL` would push an Enterprise deployment's token to public github.com. |

Three properties hold across all of them:

- **An ABSENT value still resolves to the declared `default`.** Absence is a
  state the operator chose; a rejected value is not. Nothing about a correct —
  or an empty — configuration changes.
- **A legal value is still honoured exactly as written**, including a broad
  one. `CLAUDE_CODE_PERMISSION_MODE=bypassPermissions` resolves to
  `bypassPermissions`. This rule is about values the registry _refused_.
- **The fallback is itself a legal value** for its key. The registry spec
  parses every declared fallback back through that key's own schema, so a
  fallback nobody could legally have typed cannot be declared.

**Two of the four cost something, and it is deliberate.** A rejected
`maxConcurrent` caps the fleet at 128 rather than leaving it uncapped, and a
rejected `permissionMode` produces runs that **propose and change nothing**.
Doing less than was asked, loudly, is the intended direction; doing more than
was asked, silently, is the bug. Neither is silent — both are `error` lines
naming the variable — and the two base-URL cases do not fall back at
all, because for a key that decides where a credential goes there is no
"less".

Where "no ceiling" is a legitimate thing to want, it is now something an
operator **states** rather than something a typo lands on:
`DISPATCH_MAX_CONCURRENT=unlimited` (or `null`, or leaving it unset) is the
only route there.

### Why the default-**on** switches are not in that list

`github.writesEnabled`, `dispatch.enabled`, `dispatch.allowPreviewRunner` and
`runners.claudeCodeLocal.enabled` all default `true` since ADR-0019, so an
unreadable value there does land on the permissive posture — which looks like
the same hazard and is deliberately handled somewhere else.

It is fixed **at the parser** rather than by a fallback (#439).
`booleanSetting` reads `true/false`, `1/0`, `yes/no` and `on/off`,
case-insensitively and trimmed, so an operator writing
`GITHUB_WRITES_ENABLED=no` gets what they asked for instead of having it
discarded. Only genuinely ambiguous input — `enabled`, `2`, a bare `y` — falls
back, and that is logged at `error` with the clause _"which is the opposite of
what was probably meant"_.

Declaring `invalidFallback: false` on those four instead would let a single
typo return a deployment to the inert posture ADR-0019 exists to end, which
inverts a decision rather than protecting one. The four keys above have no
such tension: nobody chooses an uncapped fleet, a file-editing agent, or a
credential's destination by leaving a value unreadable.

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

> **Worked example: `dispatch.autoResumeParked`
> (`DISPATCH_AUTO_RESUME_PARKED`, #477).** `RunExecutorService.resumeParkedRun`
> reads this key at the moment of each resume — once per parked run, per
> reconciler tick — and nothing anywhere holds a copy of it. Turning it off
> therefore binds the very next tick, including for a run whose planned
> resume instant has already passed: `Run.resumesAt` is this control plane's
> own plan for when to re-invoke the runner, jitter included, not the
> vendor's raw reset (`apps/api/src/watchdog/blocked-parking.ts`'s module
> comment is the record of that decision, #477) — and a plan already in the
> past does not exempt the run from the check. Off, the tick reports what it
> WOULD have resumed and the run stays parked for a human to look at.
>
> **Turning it off is not free, and the cost is worth stating plainly.** A
> run's runner concurrency slot is deliberately never freed while the run is
> parked, so a parked run left un-resumed keeps occupying that slot for as
> long as it stays parked — an operator who disables auto-resume to watch a
> resume by hand is also, for that whole interval, holding one slot of fleet
> capacity hostage to their own attention. This is a genuine trade against
> VISION §1's "four hours dead" origin story, which is why the key defaults
> **on**: turning it off is for an operator who wants to be the one who
> decides when a specific parked run goes back to work, not a setting to
> leave off by habit.

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

> **Worked example: `runners.claudeCodeLocal.model.small` / `.standard` /
> `.large` (`CLAUDE_CODE_MODEL_SMALL` / `_STANDARD` / `_LARGE`, #420).**
> `claude-code-local.runner.ts`'s `submit()` calls `resolveModel` once per
> work order and writes the result into the spawned process's argv
> (`claude-code-invocation.ts`'s `buildInvocationArgs`) at the same point
> `permissionMode` is written in — so the same shape applies: an agent
> already running keeps whichever model (or absence of a `--model` flag) it
> was launched with, and a change here answers only the next dispatch of
> that tier.
>
> Four outcomes come out of `resolveModel`, not the two a "model or nothing"
> story would suggest:
>
> 1. **A work order labelled `tier:small` (or `standard`/`large`), with this
>    setting non-empty**, pins that model with `--model <name>`.
> 2. **A work order with no tier at all** carries **no `--model` flag at
>    all** — the CLI applies its own default. This is deliberately not the
>    same case as `tier:standard`, even though the default for
>    `runners.claudeCodeLocal.model.standard` (`claude-sonnet-5`) happens to
>    be the CLI's own current default too: `claude-code-invocation.ts`'s own
>    comment is explicit that this is a coincidence of this release, not a
>    rule, and must not be simplified away.
> 3. **The setting cleared to an empty string** — the escape hatch a
>    string-typed field needs because it cannot hold `null` — behaves like
>    case 2 for that one tier: no `--model` flag, the CLI's own default
>    applies. This is how an operator expresses "I do not want a model
>    pinned for this tier" without a `null` this field structurally cannot
>    hold.
> 4. **A tier this build has no key for** — a future schema minor adding a
>    fourth tier before this runner maps it — logs a warning and runs on the
>    CLI's own default. It is never a failed run: #297 already settled that a
>    routing declaration the factory cannot act on is reported, not refused.
>
> Whichever of the four applied is recorded as prose in the `run.started`
> summary (`run_events`, NOT NULL), so a claim about which model a run used
> is checkable after the fact without a schema change.
>
> The defaults — `claude-haiku-4-5`, `claude-sonnet-5`, `claude-opus-5` —
> are pinned full model names rather than aliases (`haiku`/`sonnet`/`opus`),
> on purpose: the CLI accepts either, but an alias silently repoints as
> Anthropic ships new models, and these three keys exist specifically to
> bound spend — a value that changes what it means without changing what it
> says is exactly what defeats a cost control. Checked 2026-08-28 against the
> model table compiled into `claude` 2.1.243 (the CLI version
> [`RUNBOOK-enable-claude-code-local.md`](RUNBOOK-enable-claude-code-local.md)
> pins as of this writing is 2.1.246), where these three are each family's
> current member and price on a strictly increasing ladder in
> `supervisor/invocation/model-pricing.ts`. Treat that date as the last time
> the defaults were verified against the CLI's own catalogue, not as a
> permanent fact — `operator-settings.registry.ts`'s own header is the
> record of truth if a model has since been retired or superseded.

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
      "value": false,
      "default": true,
    },
    // ...one object per registry entry; secret ones shaped { secret: true, configured, hint, updatedAt } — never "value"
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
  `runners.claudeCodeLocal.oauthToken`, `models.anthropic.apiKey`,
  `models.openai.apiKey`).

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
`models.anthropic.apiKey`, say, by a stray `UPDATE` or a restored backup)
fails to decrypt rather than silently taking effect somewhere it was never
authorised for. This is the same property `LegacyModelSettingsMigration`
works around deliberately by decrypting and re-sealing rather than renaming a
row — see [Migrating off the single shared key](#migrating-off-the-single-shared-key-422)
above.

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
  (`GITHUB_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `MODEL_ANTHROPIC_API_KEY`,
  `MODEL_OPENAI_API_KEY` — plus the superseded `SUPERVISOR_MODEL_API_KEY` for
  the default provider's slot, #422).
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
2. `infra/compose/.env.example` — the same keys, one per environment
   variable, each annotated at the point it is defined with whether it moved
   and what "moved" means for that key specifically.
3. `GET /api/operator-settings`, or the Configuration section of the Control
   Center, for what a _running deployment_ currently resolves to and where
   that value came from — the registry describes the code; this describes
   the instance.
