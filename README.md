# Opifex

**AI Software Factory**

Opifex is a control plane that turns GitHub issues into work orders,
dispatches them to coding-agent runners, watches those runs continuously,
recovers from what is recoverable, escalates what is not, and writes the
complete record of what happened back into GitHub. It is built on, and ships
with, a production-grade web application foundation — OAuth authentication,
RBAC, and a Postgres/Prisma data layer — that the factory's cockpit and every
control-plane module run inside.

A fresh install ships ready, not running (ADR-0019, #439). The reconciler
observes, the runner registers, and GitHub writes are permitted where a
repository has opted in — but no run starts and no dollar is spent until an
operator sets a hard spend ceiling and turns dispatch on for one specific
repository. What to watch in the meantime is
[`docs/RUNBOOK-observation-week.md`](docs/RUNBOOK-observation-week.md).

## Repository shape

```
apps/
  api/       NestJS + Fastify backend — the control plane and the foundation API
  web/       React + MUI frontend, including the cockpit
docs/        Architecture, security, testing, deployment, and the ADR log
infra/       Docker Compose stacks, nginx, observability config
schemas/     JSON Schemas for work orders, runner capabilities, run events
.github/     Issue templates, CI, the provenance check, label taxonomy
```

## Running it

```bash
cp infra/compose/.env.example infra/compose/.env
cd infra/compose
docker compose -f base.compose.yml -f dev.compose.yml up
```

The application is served at http://localhost:3535, the API reference at
http://localhost:3535/api/docs. That port is the default; it's set by
`NGINX_PORT` in `infra/compose/.env` (see `docs/ssl-nginx-setup.md`), so a
given deployment may publish elsewhere.

## Getting started

"Running it" gets you a container that answers requests. This section
covers the next distance: turning an idle Opifex into one that has opened
a real branch against a real GitHub issue. Each step names what to do and,
more usefully, an **Observable:** — proof it worked, so you're never left
guessing whether the last click did anything. The worked example
throughout is a small public repository built for exactly this
walkthrough: [`marinoscar/opifex-demo-project`](https://github.com/marinoscar/opifex-demo-project),
a five-letter word-guessing game with a backlog already written to conform
to what Opifex parses.

If you haven't logged in yet, start with
[`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md)'s Development Setup section —
prerequisites, `npm install`, seeding the database, first login. It stops
there; this section picks up from an authenticated session.

### 1. Give Opifex a GitHub credential

Create a fine-grained personal access token, not a classic one — ADR-0001
rejects classic tokens because their scopes are account-wide, where a
fine-grained token limits Opifex to exactly the repositories you grant it.
Give it **Issues: Read and write** (labels, comments), **Contents: write**
(the factory branch and its execution-record commit, ADR-0005), **Pull
requests: read**, **Checks/Actions: read**, and **Metadata: read**.
Read-only issue access is enough to observe; write access is what dispatch
needs later.

Set it as `GITHUB_TOKEN` in `infra/compose/.env` before you start the
stack, or, once you're logged in as an Admin, from Control Center →
Credentials, which rotates it from a form with no `.env` edit and no
restart.

**Observable:** `/projects` → **Unassigned** → **Add repository** opens a
picker listing whatever your token can reach, instead of an empty list or
an authentication error.

### 2. Register the demo repository

Pick `marinoscar/opifex-demo-project` from that picker and press
**Register**. There's no free-text owner/name box on purpose: a field for
a value the system can already enumerate would turn a typo into a
confusing failure several seconds later instead of an impossible input
now.

**Observable:** the repository's card appears in **Unassigned** at rung
one of the ladder, with `observeEnabled` on and `dispatchEnabled` off.
That split is deliberate — registering a repository is not the same act as
authorizing money to be spent on it, so the absence of a choice means off.

### 3. Confirm the label taxonomy landed

Registration also provisions fifteen labels on the GitHub repository —
three input labels (`factory:ready`, `factory:hold`,
`factory:clear-quarantine`), five mirror labels, and seven routing labels
— so the eligibility signal the next steps rely on is something Opifex
owns, not something the watched repo has to remember to create. This
can't fail registration; it returns a report instead. If that report
isn't `ok` — usually a token missing **Issues: Read and write** — fix the
permission and press **Create missing labels** on the repository card
(`POST /api/repositories/{id}/labels`).

**Observable:** the demo repo's label list on GitHub shows `factory:ready`
and its siblings.

### 4. Climb the ladder to dispatch

Three more things have to be true before the factory spends anything, and
they bite in this order:

- **The hard spend ceiling.** Unset by default, and while unset every
  dispatch is refused with `no-hard-spend-ceiling-configured` — ADR-0019
  (#439): "a fresh install ships ready, not running." Set
  `dispatch.hardSpendCeilingUsd` from `/admin/settings` → Configuration →
  Dispatch, or `OPIFEX_HARD_SPEND_CEILING_USD` in the environment. This is
  the one thing a fresh install must decide before it can spend money at
  all.
- **A Claude Code credential.** Set `CLAUDE_CODE_OAUTH_TOKEN` from Control
  Center → Credentials → **Connect Claude account**. Without it every
  dispatch fails at spawn — the runner still reports capable, because
  `claude --version` succeeds with no credential at all. If you haven't
  done this yet, that's the whole subject of
  [`docs/RUNBOOK-enable-claude-code-local.md`](docs/RUNBOOK-enable-claude-code-local.md).
- **The repository's own `dispatchEnabled` switch.** Walk the ladder on
  the demo repo's card at `/projects` — observe, mirror labels, spec
  feedback, dispatch — one rung at a time rather than one global flag,
  because this is where money is spent.

**Observable:** the repository's card shows all four rungs lit, and
`GET /api/repositories` reports `dispatchEnabled: true` for it.

### 5. Mark a real issue ready

The demo repo ships four feature issues, `#1`–`#4`, grouped under an epic,
`#5`, already written with the markdown headings Opifex parses —
`Proposed solution` and `Acceptance criteria`, matched case-insensitively.
No issue template is required in the watched repo at all: Opifex validates
against its own constants, not the repo's templates. Open
[issue #2](https://github.com/marinoscar/opifex-demo-project/issues/2)
(`--help`/`--version`) and add the `factory:ready` label. That label is
the entire eligibility signal, and it's deliberately opt-in — nothing
before it is applied reads as a request for the factory to act.

The four issues are also linked to `#5` through GitHub's native sub-issues
relationship, not only the markdown checklist in the epic's body. Opifex
prefers the native relationship and falls back to parsing the body, and this
repository has none of its own — so the demo repo is the only place that
path gets exercised.

**Observable:** the issue's label list on GitHub now includes
`factory:ready` — and because dispatch is already enabled from the
previous step, that's the last manual action before the reconciler picks
it up.

### 6. Wait for the next tick

The reconciler runs on a fixed sixty-second cadence
(`reconciler.intervalMs`) — it isn't listening for the label, it's
polling: reading open issues, projecting a work order, and draining the
dispatch queue in strict FIFO order by `queuedAt`. There's nothing to
trigger by hand.

**Observable:** within a minute, issue #2 gets an authorization comment
from Opifex, a `factory/2-<sha7>-a1` branch appears carrying an execution
record at `.opifex/work-order.json` (ADR-0005), and the cockpit's run view
moves the work order from queued to running.

> **The run commits to that branch, and stops there.** There is no
> `POST .../pulls` call anywhere in `apps/api/src`, and no `git push`
> either — the agent's own instructions say only "commit your work to
> that branch." Its process environment carries a work-order id and a run
> id, not a git credential, so even an attempted push would fail
> authentication. This is a confirmed gap, filed as `#472`: expect commits
> sitting on a branch, waiting for a human — or a future fix — to push
> them forward, not a pull request appearing on their own.

One more honest edge, worth knowing before you point this at a repository
of your own: if the watched repository has no CI checks at all, its work
orders park at `awaiting-checks` forever, because an empty check list
reads as "still pending," never as "nothing to wait for." The demo repo's
own CI — typecheck, test, build, then play a game to prove the CLI still
finishes — exists partly so this walkthrough doesn't hit that trap; a
repository you register for real should run CI on its pull requests for
the same reason.

### What to try next

- **Steer a run instead of waiting on the next issue.** The `/steering`
  screen takes an instruction in prose ("only work on #2, hold everything
  else"), shows you the proposed diff before anything is written, and asks
  you to confirm it as a separate, deliberate act. See
  [`docs/API.md`](docs/API.md)'s `POST /api/steering/proposals` /
  `.../apply` for the request and response shapes, and
  [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §3.7 for how the screen
  sits beside the queue.
- **Run a full observation week** before trusting dispatch on a repository
  that matters —
  [`docs/RUNBOOK-observation-week.md`](docs/RUNBOOK-observation-week.md)
  covers the label taxonomy in depth, registering repositories from the
  API as well as the UI, and what to read each day.
- **If the runner ever reports incapable**,
  [`docs/RUNBOOK-enable-claude-code-local.md`](docs/RUNBOOK-enable-claude-code-local.md)
  is the runbook that walks the binaries, the credential, and the checks
  that get it back to capable.

## Where to go next

| Question                                       | Document                                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------------------- |
| Why does Opifex exist, and what is it not?     | [`VISION.MD`](VISION.MD)                                                              |
| What is the structure, and where does it live? | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)                                        |
| Why was a specific design chosen?              | [`docs/adr/`](docs/adr/)                                                              |
| How do I turn the factory on and operate it?   | [`docs/RUNBOOK-observation-week.md`](docs/RUNBOOK-observation-week.md)                |
| What does this look like end to end?           | [`marinoscar/opifex-demo-project`](https://github.com/marinoscar/opifex-demo-project) |
| How do commits and PRs stay traceable?         | [`docs/PROVENANCE.md`](docs/PROVENANCE.md)                                            |
| How does an AI agent work in this codebase?    | [`CLAUDE.md`](CLAUDE.md)                                                              |
| What changed recently?                         | [`CHANGELOG.md`](CHANGELOG.md)                                                        |
