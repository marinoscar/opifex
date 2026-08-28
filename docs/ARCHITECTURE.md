# System Architecture

**OPIFEX**
**Version:** 1.1
**Last Updated:** August 2026

This document provides a comprehensive architectural overview of OPIFEX, designed for AI-assisted development with specialized coding agents. It covers both the AI software factory (control plane, §3) and the web application foundation it is built on (§4 onward). For why the factory is built the way it is, start with [`VISION.MD`](../VISION.MD).

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [System Overview](#2-system-overview)
3. [Control Plane Architecture](#3-control-plane-architecture)
4. [Architecture Principles](#4-architecture-principles)
5. [Technology Stack](#5-technology-stack)
6. [Component Architecture](#6-component-architecture)
7. [Data Architecture](#7-data-architecture)
8. [Security Architecture](#8-security-architecture)
9. [API Architecture](#9-api-architecture)
10. [Frontend Architecture](#10-frontend-architecture)
11. [Infrastructure Architecture](#11-infrastructure-architecture)
12. [Observability Architecture](#12-observability-architecture)
13. [Testing Architecture](#13-testing-architecture)
14. [Agent-Based Development Model](#14-agent-based-development-model)
15. [Development Workflows](#15-development-workflows)
16. [Appendices](#16-appendices)

---

## 1. Executive Summary

### Purpose

OPIFEX is an **AI software factory** — a control plane that turns GitHub issues
into work orders, dispatches them to coding-agent runners, watches those runs
continuously, recovers from what is recoverable, escalates what is not, and
writes the complete record of what happened back into GitHub.
[`VISION.MD`](../VISION.MD) is the source of truth for _why_ it is built this
way; this document describes _what exists and where it lives_. Where the two
would otherwise repeat each other, this document links to VISION rather than
restating it.

The factory is built on, and depends on, a production-grade web application
foundation — OAuth authentication, RBAC authorization, a Postgres/Prisma data
layer, and OpenTelemetry observability. That foundation is not legacy
scaffolding left over from an earlier product: the cockpit (§3.7) is a real
application on top of it, and the same auth/RBAC/audit machinery gates every
factory action a human takes. §4 onward documents that foundation in the depth
it has always had. §3 documents the control plane that the rest of this
document does not cover.

**Read this document knowing that most of the control plane defaults to off.**
The reconciler, dispatch, GitHub writes, the supervisor, and the promotion
ladder are each gated behind an environment variable that defaults to `false`
or unset (`RECONCILER_ENABLED`, `DISPATCH_ENABLED`, `GITHUB_WRITES_ENABLED`,
`SUPERVISOR_ENABLED`, `PROMOTION_LADDER_ENABLED` — see
`infra/compose/.env.example`). The code described in §3 exists and is tested;
whether it is _running_ on a given deployment is a separate, operational
question answered by that file and by
[`docs/RUNBOOK-observation-week.md`](RUNBOOK-observation-week.md).

### Key Characteristics

| Aspect                            | Description                                                                                                                           |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **System Type**                   | AI software factory: a deterministic control plane orchestrating non-deterministic coding-agent runners (VISION §3.1)                 |
| **Control Loop**                  | A reconciler (§3.1) — observes GitHub and its own state, computes desired state, diffs, acts — not a job queue                        |
| **Runner Fleet**                  | One runner today, `claude-code-local` (§3.4); the seam is vendor-neutral by design but a second runner is not yet built (VISION §3.7) |
| **Foundation Architecture Style** | Monorepo with API-first design                                                                                                        |
| **Foundation Hosting Model**      | Same-origin (UI and API share base URL)                                                                                               |
| **Foundation Auth Strategy**      | OAuth 2.0 + JWT with refresh token rotation                                                                                           |
| **Foundation Access Control**     | Email allowlist + RBAC (Admin/Contributor/Viewer)                                                                                     |
| **Foundation Data Storage**       | PostgreSQL with Prisma ORM                                                                                                            |

### Target Audience

- **AI Coding Agents**: Primary consumers for automated development tasks — and, via the runner seam (§3.4), the workers the factory itself dispatches
- **Backend Developers**: NestJS/Node.js engineers
- **Frontend Developers**: React/TypeScript engineers
- **DevOps Engineers**: Infrastructure and deployment specialists
- **Security Teams**: Security review and compliance

---

## 2. System Overview

This section diagrams the **web application foundation** — nginx, the React
frontend, the NestJS API, Postgres, and the observability stack — the same
process and the same request path that every factory module in §3 runs
inside. There is no separate "factory server": the reconciler, dispatch,
runners, watchdog, escalations, supervisor and cockpit modules are NestJS
modules registered in the same `AppModule` (`apps/api/src/app.module.ts`)
as `AuthModule` and `SettingsModule`, scheduled with the same
`@nestjs/schedule`, and reachable through the same nginx `/api/*` route.
The Controllers/Services lists below are illustrative of the pattern, not
exhaustive — see §6.1 for the full module inventory and §3 for what the
factory-specific modules do.

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              NGINX REVERSE PROXY                             │
│                           (Security Headers, Routing)                        │
│                              http://localhost:3535                           │
├────────────────────────────────────┬────────────────────────────────────────┤
│         /* → Frontend (Web)        │           /api/* → Backend (API)       │
├────────────────────────────────────┼────────────────────────────────────────┤
│                                    │                                        │
│  ┌──────────────────────────────┐  │  ┌──────────────────────────────────┐  │
│  │       REACT FRONTEND         │  │  │       NESTJS + FASTIFY           │  │
│  │                              │  │  │                                  │  │
│  │  ┌────────────────────────┐  │  │  │  ┌────────────────────────────┐  │  │
│  │  │      Pages/Routes      │  │  │  │  │    Controllers/Guards      │  │  │
│  │  │  • Login               │  │  │  │  │  • AuthController          │  │  │
│  │  │  • Home                │  │  │  │  │  • UsersController         │  │  │
│  │  │  • User Settings       │  │  │  │  │  • SettingsController      │  │  │
│  │  │  • System Settings     │  │  │  │  │  • HealthController        │  │  │
│  │  │  • Device Activation   │  │  │  │  └────────────────────────────┘  │  │
│  │  └────────────────────────┘  │  │  │                                  │  │
│  │                              │  │  │  ┌────────────────────────────┐  │  │
│  │  ┌────────────────────────┐  │  │  │  │    Services/Business       │  │  │
│  │  │  Contexts/State        │  │  │  │  │    Logic Layer             │  │  │
│  │  │  • AuthContext         │  │  │  │  │  • AuthService             │  │  │
│  │  │  • ThemeContext        │  │  │  │  │  • UsersService            │  │  │
│  │  │  • SettingsContext     │  │  │  │  │  • SettingsService         │  │  │
│  │  └────────────────────────┘  │  │  │  │  • AllowlistService        │  │  │
│  │                              │  │  │  └────────────────────────────┘  │  │
│  │  ┌────────────────────────┐  │  │  │                                  │  │
│  │  │  Material UI (MUI)     │  │  │  │  ┌────────────────────────────┐  │  │
│  │  │  • Components          │  │  │  │  │    Prisma ORM              │  │  │
│  │  │  • Theming             │  │  │  │  │  • Database Access         │  │  │
│  │  │  • Responsive Design   │  │  │  │  │  • Query Building          │  │  │
│  │  └────────────────────────┘  │  │  │  │  • Migrations              │  │  │
│  │                              │  │  │  └────────────────────────────┘  │  │
│  └──────────────────────────────┘  │  └──────────────────────────────────┘  │
│                                    │                │                       │
│              Port 5173             │                │      Port 3000        │
└────────────────────────────────────┴────────────────┼───────────────────────┘
                                                      │
                                                      ▼
                                     ┌────────────────────────────────┐
                                     │        POSTGRESQL              │
                                     │                                │
                                     │  Tables:                       │
                                     │  • users, user_identities      │
                                     │  • roles, permissions          │
                                     │  • user_roles, role_permissions│
                                     │  • user_settings               │
                                     │  • system_settings             │
                                     │  • refresh_tokens              │
                                     │  • device_codes                │
                                     │  • allowed_emails              │
                                     │  • audit_events                │
                                     │                                │
                                     │           Port 5432            │
                                     └────────────────────────────────┘
                                                      │
                                                      ▼
                                     ┌────────────────────────────────┐
                                     │    OBSERVABILITY STACK         │
                                     │                                │
                                     │  • OTEL Collector              │
                                     │  • Uptrace (Traces/Metrics)    │
                                     │  • ClickHouse (Storage)        │
                                     │                                │
                                     │        Port 14318 (UI)         │
                                     └────────────────────────────────┘
```

### Request Flow

```
┌──────┐    ┌───────┐    ┌─────────────┐    ┌──────────────┐    ┌────────────┐
│Client│───▶│ Nginx │───▶│ JwtAuthGuard│───▶│ RolesGuard   │───▶│ Controller │
└──────┘    └───────┘    └─────────────┘    └──────────────┘    └────────────┘
                              │                    │                   │
                              ▼                    ▼                   ▼
                         Validate JWT       Check Roles/        Business Logic
                         Load User          Permissions         Response
```

---

## 3. Control Plane Architecture

This section is the one this document was missing: the AI software factory
itself. It describes **structure and where the code lives** — module paths,
data flow, seams. For _why_ each piece is shaped this way, follow the VISION
references rather than expecting the reasoning restated here.

Every module below lives under `apps/api/src/` and is registered in
`AppModule` (`apps/api/src/app.module.ts`) alongside the foundation modules
from §6 — there is no separate factory process or deployment. Nearly every
capability described here is real, tested code that is **off by default**;
§3.9 is the map from feature to the environment variable that turns it on.

### 3.1 The reconciler loop

`apps/api/src/reconciler/` — `ReconcilerService` (observes GitHub, projects
desired state, diffs; writes only to its own database, never to GitHub) and
`ReconcilerTask` (`reconciler.task.ts`, the scheduler that drives it and the
one place that also calls the write-side executors).

VISION §4: the orchestrator is a **reconciler, not a job queue**. Each tick
(`RECONCILER_INTERVAL_MS`, default 60s):

1. **Observe** — read every repository with `observeEnabled` (open issues,
   commits, PR checks) via `GitHubReadService`. Sequential per repository, not
   parallel, to protect the shared GitHub rate-limit budget
   (`GITHUB_RATE_LIMIT_RESERVE`).
2. **Project desired state** — `reconciler/projection/desired-state.ts` turns
   the observed issues, existing work orders, and check verdicts
   (`projection/check-verdict.ts`) into what _should_ be true.
3. **Diff** — `reconciler/diff/diff-engine.ts` compares observed and desired
   state and produces a list of `ReconcileAction`s (`diff/actions.types.ts`):
   mirror-label writes, escalations, dispatch signals. Nothing here executes
   anything — the diff engine only computes.
4. **Execute** — two separate executors, gated independently:
   - `execute/mirror-label.executor.ts` writes the `factory/*` mirror labels,
     gated by a repository's `mirrorLabelsEnabled` flag **and**
     `GITHUB_WRITES_ENABLED`.
   - `execute/spec-feedback.executor.ts` comments on an issue when its work
     order was rejected for a spec-quality reason.
5. **Record** — every tick, quiet or not, is persisted by
   `log/reconcile-log.service.ts` and readable at `GET /api/reconciler/ticks`
   (`reconciler.controller.ts`), retained for `RECONCILER_LOG_RETENTION_DAYS`.

`ReconcilerService` cannot write to GitHub: it depends only on
`GitHubReadService`. `ReconcilerTask.runOnce()` is the one place that both
computes (via the reconciler and the watchdog, §3.5) and calls the write-side
executors — see the extensive comments in `reconciler.task.ts` for exactly
why that separation is load-bearing for the observation-week posture VISION
§12 requires.

Human intent is read back through **input labels**
(`github/labels/factory-labels.ts`: `factory:ready`, `factory:hold`,
`factory:clear-quarantine`) — the only steering surface, per VISION §3.3.

### 3.2 Work orders

`apps/api/src/work-orders/`:

- `issue-projection.ts` — reads an issue's labels and body into a
  `IssueProjection` (task spec, acceptance criteria, path constraints,
  `needs:*` runner requirements, `tier:*` model size — see
  `docs/RUNBOOK-observation-week.md` §3 for the full label vocabulary).
- `work-order-generator.ts` — a pure function from `IssueProjection` +
  pinned base commit to a `GeneratedWorkOrder`. VISION §4: a work order is a
  **projection** of an issue, never an independent source of truth, and the
  base commit is pinned at generation and never re-resolved (issue #62).
- `work-order-identity.ts` — the deterministic identity scheme:
  `wo_<repo>_<issue>_<baseCommit7>_a<attempt>` and its branch
  `factory/<issue>-<baseCommit7>-a<attempt>`, which is what makes a re-run
  idempotent.
- `acceptance-criteria.ts` — assesses whether an issue's criteria are testable
  enough to generate a work order at all; a rejection produces spec feedback
  (§3.1 step 4) rather than a work order.
- `work-order-document.ts` / `work-order-rehydrate.ts` — the fenced-JSON
  authorization record posted to the issue, and reading it back.
- `work-order-records.service.ts` — persistence (`WorkOrder` / `Run` Prisma
  models).

Schema: `schemas/work-order.schema.json`, versioned per ADR-0010.

### 3.3 Dispatch and the runner seam

`apps/api/src/dispatch/` and `apps/api/src/runners/runner.types.ts`.

The seam is **four functions, and adding a fifth requires an ADR**
(`RUNNER_SEAM_METHODS` in `runner.types.ts`, asserted by
`runners/runner.seam.spec.ts`):

```
submit(WorkOrderSpec) -> RunHandle
poll(handle)          -> RunPollResult (status + normalized events)
cancel(handle)        -> void
capabilities()        -> RunnerCapabilities
```

A `WorkOrderSpec` never names a runner — it declares `needs` (`RunnerNeed`:
`full-streaming`, `cost-reporting`, `structured-rate-limits`,
`own-infrastructure`) and an optional `modelTier`. Routing is
`dispatch/dispatch-policy.ts`, a **pure function** (`decideDispatch`) run
against real fleet state loaded by `dispatch/dispatch.service.ts`: registered
runners' capability manifests, live-run counts against `maxConcurrency` and
`DISPATCH_MAX_CONCURRENT`, and each runner's quota position (resolved from
two independent signals — blocked runs and the runner's own rate-limit meter,
`quota/quota-window.ts` — reconciled in `dispatch.service.ts`'s
`resolveQuotaPosition`). `dispatch/dispatch-queue.service.ts` is what the
reconciler task drains every tick (`drainDispatchQueue()`); a work order that
cannot be placed **queues** rather than fails. `dispatch/run-executor.service.ts`
is the actual `submit()` call site, gated by `DISPATCH_ENABLED`
(§3.9) and `DISPATCH_RETRY_CEILING` (issue #66 quarantine policy).

### 3.4 The claude-code-local runner

`apps/api/src/runners/claude-code-local/` — the only implemented runner.
Invoked as a **child process** (`process/child-process-supervisor.ts`,
`process/run-command.ts`), not through the Agent SDK; see
[ADR-0008](adr/0008-claude-code-local-invocation.md) for why. Streams the
CLI's `stream-json` output through `stream-json-mapper.ts` into the six
normalized run-event types (§3.5). `run-workspace.service.ts` manages one
git checkout per work-order identity under `RUNNER_WORKSPACE_ROOT`, pinned to
the work order's base commit.

**There is no second runner.** VISION §6 names `claude-code-cloud` as a
planned addition; it is vendor-blocked (issues #23, #102, #103) and does not
exist in this codebase. Every reference to "the fleet" or "runners" in this
document and in the code means a fleet of size one, routed through a seam
built to hold more without implying more exist yet.

`runners/runner-registration.service.ts` and `.task.ts` register a runner's
capability manifest (schema: `schemas/runner-capability.schema.json`) into
`fleet-state.service.ts`, which dispatch reads. `run-poller.service.ts` /
`.task.ts` poll live runs (the runner-reported liveness source, §3.5).
Enabled by `CLAUDE_CODE_LOCAL_ENABLED` (default `false`).

### 3.5 Run events, liveness, and the watchdog

`apps/api/src/run-events/` — the six normalized event types (VISION §9:
`run.started`, `run.heartbeat`, `run.progress`, `run.blocked`,
`run.completed`, `run.failed`), validated at ingestion
(`run-event-validator.ts`) and exposed at `POST /api/runs/:id/events`
(`run-events.controller.ts`). Every event carries a `source` distinguishing
runner-reported from git-derived from control-plane-synthesized.

Two **independent** liveness sources, per VISION §9:

- **Runner-reported** — `runners/run-poller.service.ts`, from `poll()`.
- **Git-derived** — `apps/api/src/liveness/` (`GitLivenessService`), watching
  commits and PR/check-run activity on a run's branch. Built and run even
  though the v1 runner does not strictly need it, specifically so the
  abstraction is exercised by two independent sources rather than one.

`apps/api/src/watchdog/` (`watchdog.service.ts`) judges every live and
blocked run each tick, called from `ReconcilerTask.sweepWatchdog()` — **before**
the reconciler's own tick, so verdicts are computed against the freshest
observed state:

- `silent-detection.ts` — no events at all → `kill-and-re-run`.
- `loop-detection.ts` — tool-call signature repeating → `kill-and-re-plan`.
  Reported `unavailable` (not "no loop found") for a runner whose
  `streamingFidelity` cannot support it — see `check-coverage.ts`.
- `blocked-parking.ts` — a dated rate-limit block → park with jitter,
  auto-resume (issue #56).

None of the watchdog's kill/re-run/re-plan actions execute yet; they are
computed and, like the reconciler's own actions, recorded. `dead-time.service.ts`
(`apps/api/src/dead-time/`) keeps the ledger behind VISION §10 metric 2
("dead time per day") from the same sweep.

### 3.6 Escalations and notifications

`apps/api/src/escalations/` — VISION §9: **escalation is an action, not
telemetry**. `EscalationsService.raiseFrom()` turns `escalate` actions from
the reconciler and watchdog into persisted, deduplicated records (one per
`(run, kind)`, never one per tick) — `escalations.controller.ts` exposes them
at `GET /api/escalations`, including `GET /api/escalations/latency`, the
endpoint behind VISION §1's detection-latency metric
(`detection-latency.ts`).

`apps/api/src/notifications/` delivers them: Web Push (RFC 8030) with VAPID,
plus an independent fallback webhook path
(`NOTIFY_FALLBACK_WEBHOOK_URL`) — see
[ADR-0004](adr/0004-notification-transport.md). `EscalationDispatcher`
(`escalation-dispatcher.service.ts`) is invoked every tick regardless of
whether that tick raised anything new, because the queue is everything still
outstanding, not just this pass's output.

### 3.7 The cockpit read models

`apps/api/src/cockpit/` — read-only, one controller/service pair per
concern, all under `/api`:

| Concern         | Controller                  | Route                                                                                         |
| --------------- | --------------------------- | --------------------------------------------------------------------------------------------- |
| Runs            | `runs.controller.ts`        | `GET /api/runs`, `GET /api/runs/:id`, `GET /api/runs/:id/events`                              |
| Work orders     | `work-orders.controller.ts` | `GET /api/work-orders`, `GET /api/work-orders/:idOrIdentity`                                  |
| Dispatch queue  | `queue.controller.ts`       | `GET /api/queue`, `POST /api/queue/:workOrderId/hold`, `POST /api/queue/:workOrderId/release` |
| Cost            | `cost.controller.ts`        | `GET /api/cost/summary`                                                                       |
| The six metrics | `metrics.controller.ts`     | `GET /api/metrics/summary` (VISION §10)                                                       |
| Activity feed   | `events.controller.ts`      | `GET /api/events`                                                                             |

Adjacent, related read/write surfaces registered alongside cockpit:
`repositories.controller.ts` and `projects.controller.ts` (`/api/repositories`,
`/api/projects` — repository and project management, §3.10), `quota.controller.ts`
(`/api/quota`), `escalations.controller.ts`, `reconciler.controller.ts`
(the tick log, §3.1), and `apps/api/src/steering/steering.controller.ts`
(`POST /api/steering/proposals`, `POST /api/steering/proposals/apply`) — a
separate module, not literally under `cockpit/`, but tagged `Cockpit` in the
OpenAPI spec because it writes the same two input labels §3.1 names as the
only steering surface, `factory:ready` and `factory:hold`, that queue
hold/release write above.

**Steering turns an operator instruction into a proposed diff of those same
two labels, applied only on a confirmed second call (#425, epic #419).**
`POST /api/steering/proposals` parses the instruction in code where it can
(`steering-instruction.parser.ts`) — explicit issue and epic references, the
ready/hold verbs, "only"/else-clauses — and writes nothing; when the parser
cannot read the instruction confidently, no model is asked either, today,
because the chat has no durable spend ledger to bound a model call against
(`chat-spend-gate.ts`; see
[`docs/operator-configuration.md`](operator-configuration.md#the-chats-model-a-second-consumer-called-but-not-yet-spending-425)).
`POST /api/steering/proposals/apply` is the only call that writes, requires
an interactive session (#346 — no personal access token, no device-flow
token, the same guard `PATCH /api/operator-settings` enforces) precisely
because it is the one call in this API where a typed sentence becomes an
unbounded number of label writes, and re-reads every named issue first so a
label changed since the proposal was made **skips that one operation, never
the batch**. VISION §3.6 — no model output takes effect without passing
through deterministic policy, and here the policy is a human confirming a
concrete list of operations. Opifex stores no scope of its own for this: the
proposal is returned to the caller and handed back on apply, never persisted
server-side. See [`docs/API.md`](API.md) for the full request/response
shapes.

The frontend cockpit consuming these lives at `apps/web/src/pages/`:
`DashboardPage`, `ProjectsPage`, `QueuePage`, `RunsPage`, `RunDetailPage`,
`WorkOrderDetailPage`, `CostPage`, `ApprovalsPage`/`ApprovalDetailPage`,
`TrustPage`/`TrustGrantDetailPage`, `SteeringPage` — built on the same
React/MUI/context foundation as §10.

**`SteeringPage` (`/steering`, #426) is the propose-then-confirm screen over
the two steering endpoints above** — an operator instruction becomes a
`SteeringProposal` rendered by `ProposalReview`, which never writes on its
own; only an explicit Apply press (a second, separate call to `POST
/api/steering/proposals/apply`) does. `LabelDiff` renders every `add`/`remove`
pair identically regardless of direction, and `ProposalReview` partitions the
diff into issues the operator named versus collateral an "only" clause
touched without being asked — the same distinction `blastRadius` and
`operations[].named` carry over the wire (see `docs/API.md`). This is the
UI's own defence of VISION §3.6's rule that no model output takes effect
without passing through deterministic policy: there is no code path in
`useSteering.ts`, `SteeringPage.tsx` or `ProposalReview.tsx` from a proposal
to a write, for any proposal, regardless of size or confidence.

### 3.8 The supervisor, autonomy, and the promotion ladder

`apps/api/src/supervisor/` implements VISION §7's advisory agent — **observe
only**, per the governing test "if the AI supervisor is offline, the factory
keeps running." `invocation/supervisor.task.ts` runs it on a schedule (not
per-event), gated by `SUPERVISOR_ENABLED` and its own metered spend ceiling
(`SUPERVISOR_HARD_SPEND_CEILING_USD`, [ADR-0017](adr/0017-supervisor-spend-ceiling.md)),
deliberately separate from the dispatch spend ceiling. It receives a rendered
snapshot (`snapshot/render-snapshot.ts`) — the "stateless agent, stateful
system" rule from VISION §7 — and its `proposers/` (spec-quality,
run-diagnosis, issue-shaping, decomposition) write to a decision log
(`decision-log/`, exposed at `GET /api/supervisor`), never to an executor.

The **earned-autonomy** machinery around it is real and largely off by
default:

- `apps/api/src/trust/` — scoped, expiring, budget-capped trust grants
  (`GET/POST /api/trust/grants`, `POST /api/trust/grants/:id/renew`), per VISION §8.
- `apps/api/src/approvals/` — the approval gate and its timeout policy
  ([ADR-0014](adr/0014-approval-timeout-precedence.md)), `/api/approvals`.
- `apps/api/src/autonomy/` — the **never-trustable** boundary
  ([ADR-0013](adr/0013-never-trustable-effects.md)): force-push, protected
  branches, credentials, spend above the hard ceiling, and CI/policy/budget
  configuration itself are refused regardless of any grant.
- `apps/api/src/promotion/` — the promotion ladder (VISION §7's four rungs),
  gated by `PROMOTION_LADDER_ENABLED`; demotion on regression is automatic,
  promotion is not.

### 3.9 Operating posture: what is on by default

Every switch below lives in `infra/compose/.env.example`, with the reasoning
recorded next to each one. All default to **off** or **read-only**:

| Flag                        | Default | What it gates                                                                                                                                                |
| --------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `RECONCILER_ENABLED`        | `false` | The tick runs at all (§3.1). Read-only even when `true`: the module imports the GitHub read service, not the write one.                                      |
| `GITHUB_WRITES_ENABLED`     | `false` | Every GitHub write adapter (mirror labels, spec-feedback comments) returns `performed: false` and issues no request.                                         |
| `DISPATCH_ENABLED`          | `false` | Whether `run-executor.service.ts` actually calls a runner's `submit()`. Off: the whole decision still runs and is logged as what it _would_ have dispatched. |
| `CLAUDE_CODE_LOCAL_ENABLED` | `false` | Whether the local runner spawns subprocesses at all.                                                                                                         |
| `SUPERVISOR_ENABLED`        | `false` | Whether the advisory agent runs on its schedule.                                                                                                             |
| `PROMOTION_LADDER_ENABLED`  | `false` | Whether action classes are promoted or demoted; `false` pauses without revoking existing grants.                                                             |

This is why VISION §12's roadmap phases are not a reliable guide to what is
implemented versus what is running: the code for phases through at least 7
exists in this repository, gated behind the flags above. Treat this table,
not the roadmap, as the answer to "is X actually happening in a given
deployment" — and see `docs/RUNBOOK-observation-week.md` for the sequence in
which an operator turns these on.

### 3.10 Repositories and projects

`apps/api/src/repositories/` and `apps/api/src/projects/` — what Opifex
watches, and the grouping it is optionally filed into. Both are gated on the
same `projects:read` / `projects:write` pair, on purpose: a project is
administered by whoever administers the repositories in it, and it carries no
authority of its own — nothing anywhere in the reconciler, dispatch or
supervisor reads `projectId` to decide whether something may happen. VISION
§11's single-operator premise is the reason a project is not a tenancy
boundary or a permission scope; it is a label, and this section states what
follows from that.

**Unassigned is a stored state, not a migration nobody ran.** `Repository.projectId`
is nullable, and every repository registered before `ProjectsController`
existed (#404) still reads `projectId: null` — it is observed, dispatchable
and walked up the enablement ladder exactly like an assigned one, because the
ladder does not read `projectId` at all. `GET /api/repositories?projectId=none`
asks for that bucket. `none` is a member of the `projectId` filter rather than
a separate `unassigned` boolean, because unassigned is an **answer** to "which
project", not a different question (`repository.dto.ts`'s own comment on
`listRepositoriesQuerySchema`) — a second flag would have made the same fact
askable two contradictory ways. `apps/web/src/pages/ProjectsPage.tsx` treats
the bucket as first-class for the identical reason: it is the default
selection, not a corner of the screen.

A project's `slug` follows one rule, in `apps/api/src/projects/slug.ts`:
supplied by the operator when they give one, derived from `name` exactly once
— at creation — when they do not. Renaming a project never re-derives the
slug, because the slug is the stable handle everything else references, and a
rename is a change of label, not of identity. A collision **refuses** with a
409 that names the taken slug, including a derived one the operator never
typed; it is never silently suffixed, because a `-2` would hand back a handle
nobody chose and leave every later reference to the original resolving to
somebody else's project with no signal that a collision happened at all.

**Retire is a distinct operation from delete, and the difference is not
cosmetic.** `DELETE /api/repositories/:id` is refused with `400` while the
repository has any work order, because deleting it would cascade its runs
and their provenance away, and VISION §5's premise is that a hole in that
graph is not detectable after the fact — the same reasoning `WorkOrder.repository`'s
own cascading foreign key would otherwise contradict. Retire
(`POST /api/repositories/:id/retire`, `repositories.service.ts`) is what the
system wants instead for anything with history: the whole ladder —
`observeEnabled`, `mirrorLabelsEnabled`, `specFeedbackEnabled`,
`dispatchEnabled` — off in one atomic, audited act, with every work order,
run and event left exactly where it was. It is idempotent, so a retry after a
dropped connection is not a second decision and writes no second audit row.
While a repository is retired, `PATCH /api/repositories/:id` refuses to turn
any rung back on (`400`, pointing at `POST /api/repositories/:id/unretire`) —
allowing it would let a routine PATCH silently undo a stand-down. Un-retiring
returns the repository to the **bottom** of the ladder — observation on,
every outward write off, the same position a fresh registration lands in —
**never to the rungs it previously held**: an undo that silently switched
dispatch back on would re-enable the factory's most consequential permission
as a side effect of a button labelled "un-retire". The rungs it was standing
on when retired survive nowhere else but the retire audit row's
`meta.ladderBefore` (`audit_events`, action `repository.retired`) — that is
deliberately the only place "what was this allowed to do before?" can be
answered.

**Why "retired" is a stored fact and not a reading of the four flags (#405).**
All four rungs off is reachable without anyone deciding anything — four
independent `PATCH`es, or a registration with `observeEnabled: false` — so an
operator who paused observation for an afternoon and a genuine stand-down
would be indistinguishable under a derived reading. Un-retiring would then
have nothing to undo: the same button that ends a real retirement would also
silently end the afternoon pause. And the audit row would record the _act_
while nothing recorded the resulting _state_, so "is this repository retired
right now?" could only be answered by replaying `audit_events` forward
against every later `PATCH` — VISION §5's own argument about provenance run
backwards, since a fact that exists only as a reconstruction is a fact nobody
will reconstruct. `Repository.retiredAt` / `retiredById` (nullable, `SetNull`
on the user relation) cost two columns and no backfill — `NULL` is already
true of every row that predates this feature — and `RepositoriesService.update`
enforces that a retired repository cannot drift back to a state that
contradicts them.

**Deleting a project does not cascade, and the argument is the inverse of the
repository one.** `Project.id` is referenced by `Repository.projectId` with
`onDelete: SetNull` (`schema.prisma`), not `Cascade`. A project owns no work
order, no run and no event — nothing in the provenance graph VISION §5
protects depends on it — so unlike a repository, `DELETE /api/projects/:id`
is never refused for having contents: its repositories survive, unassigned,
still registered and still on whatever rung of the ladder they were already
on. The response (`ProjectDeletionResponseDto`) reports
`unassignedRepositories` rather than answering `204`, so the non-cascade
guarantee is visible in the API's own answer instead of something a caller
has to go and confirm against the schema. `ProjectsService.remove` does not
null the column itself first, deliberately — doing so would hide a schema
regression behind application code, and the guarantee has to hold for a
`DELETE` issued by hand against the database exactly as it does through the
API; `project-delete-non-cascade.integration.spec.ts` proves it against a
real Postgres for that reason.

**Registering several repositories from the picker is one request per
repository, sequential rather than concurrent, by design (#407).**
`AddRepositoryDialog` (`apps/web/src/components/projects/`) takes a
multi-selection from `GET /api/repositories/available`, and `registerMany`
then issues one `POST /api/repositories` per repository, awaiting each before
the next — there is no batched or transactional endpoint behind it. That is
deliberate rather than an omission, for two reasons.

A batch endpoint would move the problem rather than remove it: a batch of
eight where two are already registered cannot answer one status honestly, so
it would have to duplicate the per-repository 400/409/503 semantics that
already work. The only thing it could add is a transaction, and a transaction
is the outcome this explicitly does not want.

Sequential rather than concurrent, because
`RepositoriesService.register`'s reachability check (`verifyReachable`) is a
real call against GitHub, drawn from the same rate-limit budget that
`github.rateLimitReserve` holds a reserve back from for interactive use
(`GitHubHttpService.canSpend`) — so adding thirty repositories spends that
shared budget one request at a time rather than in a burst that would trip a
secondary limit. The batch runs to the end rather than stopping at the first
refusal, so the answer does not depend on the order the rows happened to be
in. Nothing rolls
back across repositories either: if the third of four is refused
(rate-limited, or the token's access narrowed mid-session), the first two
stay registered. Partial success is the designed outcome, not a failure to
recover from — each registration is independently correct or independently
refused, and composing several into one all-or-nothing act would make a
single unrelated refusal undo work that had already succeeded.

**Registration also provisions the factory label taxonomy, and provisioning
failing does not fail the registration (#415).** `LabelProvisioningService`
(`apps/api/src/github/labels/label-provisioning.service.ts`) creates 15 of
the taxonomy's 40 declared labels on the repository being registered: the
three `factory:*` input labels, the five `factory/*` mirror labels, and the
seven `needs:*` / `tier:*` routing labels — the vocabulary the control loop
itself reads or obeys. The other 25 (`bug`, `phase:*`, component labels) are
organisational conventions of the Opifex repository, nothing in the control
loop reads them, and writing them onto somebody else's tracker on the
strength of "they let Opifex watch this repository" is presumptuous; that
boundary is asserted by `label-taxonomy.spec.ts` rather than left to review.
`label-taxonomy.ts`'s own header explains why the set is declared in
TypeScript rather than read from `.github/labels.yml` at request time:
`apps/api/scripts` went missing from the production image once already
(#382), silently, and a taxonomy that empties itself in a container is worse
than one that fails to compile.

This service is deliberately **not** gated by `github.writesEnabled`. That
flag governs whether the factory acts on issues during a reconciler tick;
creating the label taxonomy is operator setup, the same category as
registering the repository at all, and gating it on the kill switch would
mean VISION §12's observation week could not be set up without first turning
on the writes the switch exists to withhold. It also never routes through
`guardedWrite` — fifteen setup writes in the diff log the observation week is
reviewed from would drown the one thing that log is for. What it does carry
instead: it creates and updates, **never deletes** — a label absent from the
taxonomy is left alone rather than reported as a problem, since an
unrecognised label is far more likely to be a human's than a mistake — and it
refuses any name outside `PROVISIONED_LABELS` before a request is made.

Because ADR-0001 authenticates with a fine-grained personal access token
scoped one repository and one permission at a time, and such a token emits no
`x-oauth-scopes` header, whether it can write labels to a given repository is
unknowable until it is tried — "can read this repo" does not imply `issues:
write` on it. So provisioning reports rather than throws:
`POST /api/repositories`'s response carries a `labelProvisioning` field with
the same report `GET /api/repositories/{id}/labels` answers, and the
repository stays registered either way. `POST /api/repositories/{id}/labels`
is the repair action once the token's permissions are widened.

**The report's seven counts are `number | null`, and `null` means the labels
were never read — never that there are none.** They go `null` together,
exactly when `labels` is empty, and that condition is keyed on whether the
_read_ succeeded, not on `status`: a `refused` report can be a read-phase
refusal (could not list the labels at all — every count `null`) or a
write-phase refusal (listed them fine, then the write was cut off — real
counts, `created: 0`, and still `status: 'refused'`). `apps/web/src/config/
repositoryLabels.ts`'s `wasRead` is a `null` check for exactly that reason;
gating on `status` instead would blank a genuine observation the moment a
write-phase refusal is the one thing worth reporting. The Projects UI
(`RepositoryLadderCard.tsx`) renders the count beside each repository's
ladder as "N of M labels present" with a `checkedAt` stamp, names what is
missing grouped by kind, and offers **Create missing labels** only when
`status` is one a repeated attempt could actually fix (`incomplete`) —
`refused` and `no_credential` are not repaired by pressing the button again,
and offering it there would imply they might be.

---

## 4. Architecture Principles

### 4.1 Separation of Concerns

| Layer              | Responsibility                  | Location                      |
| ------------------ | ------------------------------- | ----------------------------- |
| **Presentation**   | User interaction, rendering, UX | `apps/web/`                   |
| **API Gateway**    | HTTP handling, validation, auth | `apps/api/src/*/controllers/` |
| **Business Logic** | Domain rules, orchestration     | `apps/api/src/*/services/`    |
| **Data Access**    | Database operations, queries    | Prisma via services           |
| **Infrastructure** | Routing, containers, config     | `infra/`                      |

**Rule**: Frontend handles presentation only. All business logic resides in the API.

### 4.2 Same-Origin Hosting

All components served from the same base URL via Nginx reverse proxy:

| Path                | Component            | Purpose                       |
| ------------------- | -------------------- | ----------------------------- |
| `/`                 | Frontend (React)     | User interface                |
| `/api/*`            | Backend (NestJS)     | REST API                      |
| `/api/docs`         | Scalar API reference | Interactive API documentation |
| `/api/openapi.json` | OpenAPI spec         | Machine-readable API schema   |

**Benefits**: No CORS complexity, simplified cookie handling, unified deployment.

### 4.3 Security by Default

- **Authentication Required**: All API endpoints require JWT unless explicitly marked `@Public()`
- **Authorization Enforced**: RBAC guards verify roles/permissions before controller execution
- **Input Validated**: Zod schemas validate all request payloads
- **Secrets Protected**: Environment variables only, never committed to source

### 4.4 API-First Design

- **Contract-Driven**: OpenAPI specification generated from code annotations
- **Versioned**: API paths support future versioning (`/api/v1/`)
- **Consistent**: Standardized response format for success and errors
- **Documented**: Every endpoint documented with OpenAPI decorators; the published
  document is assembled in `apps/api/src/openapi/` and linted by Spectral in CI
  (see [`docs/specs/api-documentation.md`](specs/api-documentation.md))

### 4.5 Observable by Design

- **Traced**: OpenTelemetry auto-instrumentation for all HTTP and DB operations
- **Metered**: Request counts, durations, error rates exposed as metrics
- **Logged**: Structured JSON logging with correlation IDs
- **Health-Checked**: Liveness and readiness endpoints for orchestration

---

## 5. Technology Stack

### 5.1 Core Technologies

| Component              | Technology        | Version   | Purpose               |
| ---------------------- | ----------------- | --------- | --------------------- |
| **Runtime**            | Node.js           | 24+ (LTS) | Server runtime        |
| **Language**           | TypeScript        | 6.x       | Type safety           |
| **Backend Framework**  | NestJS            | 11.x      | API structure         |
| **HTTP Adapter**       | Fastify           | 5.x       | High-performance HTTP |
| **Frontend Framework** | React             | 19.x      | UI rendering          |
| **UI Library**         | Material UI (MUI) | 9.x       | Component library     |
| **Database**           | PostgreSQL        | 16+       | Data persistence      |
| **ORM**                | Prisma            | 7.x       | Database access       |

### 5.2 Authentication & Security

| Component            | Technology         | Purpose                   |
| -------------------- | ------------------ | ------------------------- |
| **OAuth Strategy**   | Passport.js        | OAuth flow handling       |
| **OAuth Provider**   | Google OAuth 2.0   | Primary identity provider |
| **Token Format**     | JWT (HS256)        | Stateless authentication  |
| **Validation**       | Zod                | Runtime schema validation |
| **Security Headers** | Helmet (via Nginx) | HTTP security headers     |

### 5.3 Infrastructure

| Component            | Technology              | Purpose                           |
| -------------------- | ----------------------- | --------------------------------- |
| **Containerization** | Docker                  | Application packaging             |
| **Orchestration**    | Docker Compose          | Local development environment     |
| **Reverse Proxy**    | Nginx                   | Routing, SSL termination, headers |
| **Observability**    | OpenTelemetry + Uptrace | Traces, metrics, logs             |
| **Logging**          | Pino                    | Structured JSON logging           |

### 5.4 Testing

| Component                | Technology                         | Purpose                                    |
| ------------------------ | ---------------------------------- | ------------------------------------------ |
| **Backend Unit Tests**   | Jest + jest-mock-extended          | Service/guard testing with mocked Prisma   |
| **Backend Integration**  | Jest + Supertest                   | HTTP endpoint testing with mocked database |
| **Prisma Mocking**       | jest-mock-extended (DeepMockProxy) | Type-safe database mocking                 |
| **Frontend Tests**       | Vitest + React Testing Library     | Component and context testing              |
| **Frontend API Mocking** | MSW (Mock Service Worker)          | Network request interception               |
| **E2E (Optional)**       | Playwright                         | Full system testing                        |

**Key Testing Characteristics:**

- Backend tests use **mocked PrismaService** by default (no real database required)
- Integration tests verify full HTTP request/response cycle with mocked data layer
- Frontend tests run in jsdom environment with MSW intercepting API calls
- Coverage thresholds: 70% minimum for frontend (enforced in vitest.config.ts)

---

## 6. Component Architecture

### 6.1 Repository Structure

```
opifex/
├── apps/
│   ├── api/                          # Backend API (NestJS + Fastify)
│   │   ├── src/
│   │   │   ├── auth/                 # Authentication module
│   │   │   │   ├── controllers/
│   │   │   │   ├── services/
│   │   │   │   ├── guards/
│   │   │   │   ├── strategies/
│   │   │   │   └── decorators/
│   │   │   ├── users/                # User management module
│   │   │   ├── settings/             # Settings module (user + system)
│   │   │   ├── allowlist/            # Email allowlist module
│   │   │   ├── health/               # Health check module
│   │   │   ├── prisma/               # Prisma service
│   │   │   ├── common/               # Shared utilities
│   │   │   │   ├── constants/
│   │   │   │   ├── filters/
│   │   │   │   └── interceptors/
│   │   │   ├── config/               # Configuration module
│   │   │   │
│   │   │   │   # Control-plane modules (§3) — same app, same process
│   │   │   ├── github/               # GitHub read/write/git-branch adapters
│   │   │   ├── repositories/         # Registered repositories (observe/dispatch flags)
│   │   │   ├── reconciler/           # The control loop (§3.1)
│   │   │   ├── work-orders/          # Issue → work order projection (§3.2)
│   │   │   ├── dispatch/             # Runner routing and the executor (§3.3)
│   │   │   ├── runners/              # The runner seam + claude-code-local (§3.4)
│   │   │   ├── run-events/           # The six normalized event types (§3.5)
│   │   │   ├── liveness/             # Git-derived liveness (§3.5)
│   │   │   ├── watchdog/             # Silence/loop/block detection (§3.5)
│   │   │   ├── dead-time/            # Metric 2 ledger (§3.5)
│   │   │   ├── escalations/          # Escalation records (§3.6)
│   │   │   ├── notifications/        # Web Push + fallback webhook (§3.6)
│   │   │   ├── cockpit/              # Read models: runs, queue, cost, metrics (§3.7)
│   │   │   ├── quota/                # Runner rate-limit meter
│   │   │   ├── supervisor/           # The advisory agent, observe-only (§3.8)
│   │   │   ├── trust/                # Trust grants (§3.8)
│   │   │   ├── approvals/            # The approval gate (§3.8)
│   │   │   ├── autonomy/             # The never-trustable boundary (§3.8)
│   │   │   ├── promotion/            # The promotion ladder (§3.8)
│   │   │   ├── contracts/            # Generated types from schemas/*.schema.json
│   │   │   └── main.ts               # Application entry
│   │   ├── prisma/
│   │   │   ├── schema.prisma         # Database schema
│   │   │   ├── migrations/           # Migration history
│   │   │   └── seed.ts               # Database seeding
│   │   ├── test/                     # Integration tests
│   │   └── Dockerfile
│   │
│   └── web/                          # Frontend (React + MUI)
│       ├── src/
│       │   ├── components/           # Reusable UI components
│       │   ├── pages/                # Page components, including the cockpit (§3.7)
│       │   ├── contexts/             # React context providers
│       │   ├── hooks/                # Custom hooks
│       │   ├── services/             # API client
│       │   ├── theme/                # MUI theme configuration
│       │   ├── types/                # TypeScript types
│       │   └── __tests__/            # Component tests
│       └── Dockerfile
│
├── schemas/                           # Work order / runner capability / run event
│   ├── work-order.schema.json         # JSON Schemas (ADR-0010 versioning), with
│   ├── runner-capability.schema.json  # worked and invalid examples under
│   └── run-event.schema.json          # schemas/examples/
│
├── docs/                             # Documentation
│   ├── ARCHITECTURE.md               # This document
│   ├── SECURITY-ARCHITECTURE.md      # Security details
│   ├── API.md                        # API reference
│   ├── DEVELOPMENT.md                # Development guide
│   ├── TESTING.md                    # Testing guide
│   ├── DEVICE-AUTH.md                # Device auth guide
│   ├── PROVENANCE.md                 # The commit trailer vocabulary
│   ├── RUNBOOK-observation-week.md   # Turning the factory on
│   ├── personal-access-tokens.md     # PAT feature guide
│   ├── ssl-nginx-setup.md            # Dev-VPS deployment runbook
│   ├── System_Specification_Document.md  # Pre-pivot spec; superseded by VISION.MD, kept for history
│   ├── adr/                          # Architecture decision records (see adr/README.md)
│   └── specs/                        # Implementation specifications
│       ├── 01-project-setup.md
│       ├── 02-database-schema.md
│       └── ... (24 specs total)
│
├── infra/                            # Infrastructure configuration
│   ├── compose/
│   │   ├── base.compose.yml          # Core services
│   │   ├── dev.compose.yml           # Development overrides
│   │   ├── prod.compose.yml          # Production overrides
│   │   ├── otel.compose.yml          # Observability stack
│   │   └── .env.example              # Environment template — the canonical env reference
│   ├── nginx/
│   │   └── nginx.conf                # Reverse proxy config
│   └── otel/
│       ├── otel-collector-config.yaml
│       └── uptrace.yml
│
├── .claude/                          # AI agent configuration
│   └── agents/
│       ├── backend-dev.md            # Backend specialist
│       ├── frontend-dev.md           # Frontend specialist
│       ├── database-dev.md           # Database specialist
│       ├── testing-dev.md            # Testing specialist
│       └── docs-dev.md               # Documentation specialist
│
├── CLAUDE.md                         # AI assistant guidance
├── VISION.MD                         # Why the factory is built this way — north star
└── README.md                         # Project overview
```

### 6.2 Backend Module Structure

Each NestJS module follows a consistent pattern:

```
module-name/
├── module-name.module.ts         # Module definition
├── module-name.controller.ts     # HTTP endpoints
├── module-name.service.ts        # Business logic
├── dto/                          # Data Transfer Objects
│   ├── create-item.dto.ts
│   └── update-item.dto.ts
├── interfaces/                   # TypeScript interfaces
├── guards/                       # Module-specific guards
└── module-name.controller.spec.ts  # Unit tests
```

### 6.3 Frontend Component Structure

```
components/
├── ComponentName/
│   ├── ComponentName.tsx         # Component implementation
│   ├── ComponentName.test.tsx    # Component tests
│   └── index.ts                  # Barrel export

pages/
├── PageName/
│   ├── PageName.tsx              # Page component
│   ├── PageName.test.tsx         # Page tests
│   └── index.ts                  # Barrel export
```

### 6.4 Storage Subsystem

The storage system provides file upload and management capabilities with support for large files through resumable multipart uploads.

#### Architecture Overview

The storage system uses a provider abstraction pattern to support multiple cloud storage backends while maintaining a consistent API.

```
┌─────────────────────────────────────────────────────────────┐
│                    Storage Module                            │
├─────────────────────────────────────────────────────────────┤
│  Objects Controller                                          │
│  └── Upload/Download/CRUD endpoints                          │
├─────────────────────────────────────────────────────────────┤
│  Objects Service                                             │
│  └── Business logic, ownership validation                    │
├─────────────────────────────────────────────────────────────┤
│  Storage Provider Interface                                  │
│  ├── S3StorageProvider (implemented)                         │
│  └── AzureStorageProvider (future)                          │
├─────────────────────────────────────────────────────────────┤
│  Object Processing Pipeline                                  │
│  └── Async post-upload processing with pluggable processors  │
└─────────────────────────────────────────────────────────────┘
```

#### Upload Flow

**1. Resumable Upload (Large Files)**:

- Client calls `/api/storage/objects/upload/init` with file metadata
- Server creates DB record, initializes S3 multipart, returns presigned URLs
- Client uploads parts directly to S3 (bypasses application server)
- Client calls `/api/storage/objects/:id/upload/complete` with part ETags
- Server finalizes upload with S3, triggers processing pipeline

**2. Simple Upload (Small Files < 100MB)**:

- Client sends file via multipart/form-data to `/api/storage/objects`
- Server streams directly to S3
- Processing pipeline triggered on completion

#### Processing Pipeline

Post-upload processing is handled asynchronously via NestJS EventEmitter:

```
ObjectUploadedEvent (emitted)
         ↓
ObjectProcessingService (orchestrator)
         ↓
Registered Processors (run in priority order)
         ↓
Results aggregated into object metadata
         ↓
Status updated: ready | failed
```

**Key Features:**

- Pluggable processor architecture
- Priority-based execution order
- Processors run asynchronously (non-blocking)
- Results stored in object metadata JSONB field
- Extensible for future processing needs (virus scanning, image resizing, etc.)

#### Database Schema

**storage_objects**:

- File metadata, status, storage key
- Owner reference (user_id)
- Processing results in JSONB metadata field

**storage_object_chunks**:

- Tracks multipart upload progress
- Part number, ETag, upload status
- Enables resume capability

#### Module Structure

```
apps/api/src/storage/
├── storage.module.ts                # Module definition
├── objects/
│   ├── objects.controller.ts        # HTTP endpoints
│   ├── objects.service.ts           # Business logic
│   ├── dto/                         # Data transfer objects
│   └── interfaces/
├── providers/
│   ├── storage-provider.interface.ts
│   └── s3-storage.provider.ts
└── processing/
    ├── object-processing.service.ts
    └── processors/
        └── base-processor.interface.ts
```

---

## 7. Data Architecture

### 7.1 Entity Relationship Diagram

```
┌────────────────────┐       ┌────────────────────┐
│       users        │       │   user_identities  │
├────────────────────┤       ├────────────────────┤
│ id (PK, UUID)      │──┐    │ id (PK, UUID)      │
│ email (UNIQUE)     │  │    │ user_id (FK)       │──┘
│ display_name       │  └───▶│ provider           │
│ provider_display   │       │ provider_subject   │
│ profile_image_url  │       │ provider_email     │
│ provider_image_url │       │ created_at         │
│ is_active          │       └────────────────────┘
│ created_at         │
│ updated_at         │       ┌────────────────────┐
└────────────────────┘       │    user_settings   │
         │                   ├────────────────────┤
         │                   │ id (PK, UUID)      │
         │                   │ user_id (FK, UNIQUE)│◀─┐
         │                   │ value (JSONB)      │  │
         │                   │ version            │  │
         ▼                   │ updated_at         │  │
┌────────────────────┐       └────────────────────┘  │
│    user_roles      │                               │
├────────────────────┤                               │
│ user_id (FK, PK)   │───────────────────────────────┘
│ role_id (FK, PK)   │──┐
└────────────────────┘  │    ┌────────────────────┐
                        │    │       roles        │
                        │    ├────────────────────┤
                        └───▶│ id (PK, UUID)      │
                             │ name (UNIQUE)      │
                             │ description        │
                             └────────────────────┘
                                       │
                                       ▼
                             ┌────────────────────┐
                             │  role_permissions  │
                             ├────────────────────┤
                             │ role_id (FK, PK)   │
                             │ permission_id (PK) │──┐
                             └────────────────────┘  │
                                                     │
                             ┌────────────────────┐  │
                             │    permissions     │  │
                             ├────────────────────┤  │
                             │ id (PK, UUID)      │◀─┘
                             │ name (UNIQUE)      │
                             │ description        │
                             └────────────────────┘

┌────────────────────┐       ┌────────────────────┐
│  system_settings   │       │   refresh_tokens   │
├────────────────────┤       ├────────────────────┤
│ id (PK, UUID)      │       │ id (PK, UUID)      │
│ key (UNIQUE)       │       │ user_id (FK)       │
│ value (JSONB)      │       │ token_hash (UNIQUE)│
│ version            │       │ expires_at         │
│ updated_by_user_id │       │ created_at         │
│ updated_at         │       │ revoked_at         │
└────────────────────┘       └────────────────────┘

┌────────────────────┐       ┌────────────────────┐
│   allowed_emails   │       │    device_codes    │
├────────────────────┤       ├────────────────────┤
│ id (PK, UUID)      │       │ id (PK, UUID)      │
│ email (UNIQUE)     │       │ device_code_hash   │
│ added_by_id (FK)   │       │ user_code (UNIQUE) │
│ added_at           │       │ user_id (FK)       │
│ claimed_by_id (FK) │       │ client_info (JSONB)│
│ claimed_at         │       │ status             │
│ notes              │       │ expires_at         │
└────────────────────┘       │ last_polled_at     │
                             └────────────────────┘

┌────────────────────┐
│    audit_events    │
├────────────────────┤
│ id (PK, UUID)      │
│ actor_user_id (FK) │
│ action             │
│ target_type        │
│ target_id          │
│ meta (JSONB)       │
│ created_at         │
└────────────────────┘

┌────────────────────┐       ┌────────────────────────┐
│  storage_objects   │       │ storage_object_chunks  │
├────────────────────┤       ├────────────────────────┤
│ id (PK, UUID)      │──┐    │ id (PK, UUID)          │
│ owner_id (FK)      │  │    │ object_id (FK)         │──┘
│ name               │  └───▶│ part_number            │
│ size               │       │ e_tag                  │
│ mime_type          │       │ size                   │
│ storage_key        │       │ status                 │
│ storage_provider   │       │ created_at             │
│ upload_id          │       │ completed_at           │
│ status             │       └────────────────────────┘
│ metadata (JSONB)   │
│ created_at         │
│ updated_at         │
└────────────────────┘
```

### 7.2 JSONB Schema Definitions

#### User Settings Shape

```json
{
  "theme": "light | dark | system",
  "profile": {
    "displayName": "string | null",
    "useProviderImage": true,
    "customImageUrl": "string | null"
  }
}
```

#### System Settings Shape

```json
{
  "ui": {
    "allowUserThemeOverride": true
  },
  "security": {
    "jwtAccessTtlMinutes": 15,
    "refreshTtlDays": 14
  },
  "features": {
    "exampleFlag": false
  }
}
```

### 7.3 Database Design Principles

| Principle                 | Implementation                                           |
| ------------------------- | -------------------------------------------------------- |
| **UUID Primary Keys**     | All tables use UUID v4 for primary keys                  |
| **Timestamptz**           | All timestamps use `timestamptz` for timezone awareness  |
| **JSONB for Flexibility** | Settings stored as JSONB for schema-less extensibility   |
| **Cascade Deletes**       | Foreign keys cascade on user deletion                    |
| **Soft Deletes**          | Users deactivated via `is_active` flag, not hard deleted |
| **Audit Trail**           | `audit_events` table logs all security-relevant actions  |

---

## 8. Security Architecture

### 8.1 Authentication Flow

```
┌─────────┐          ┌─────────┐          ┌─────────┐          ┌─────────┐
│  User   │          │ Frontend│          │   API   │          │ Google  │
└────┬────┘          └────┬────┘          └────┬────┘          └────┬────┘
     │                    │                    │                    │
     │  1. Click Login    │                    │                    │
     │───────────────────▶│                    │                    │
     │                    │                    │                    │
     │                    │ 2. Redirect to     │                    │
     │                    │    /api/auth/google│                    │
     │                    │───────────────────▶│                    │
     │                    │                    │                    │
     │                    │                    │ 3. Redirect to     │
     │◀───────────────────┼────────────────────┼────────────────────│
     │                    │                    │    Google OAuth    │
     │                    │                    │                    │
     │  4. Grant Consent  │                    │                    │
     │────────────────────┼────────────────────┼───────────────────▶│
     │                    │                    │                    │
     │                    │                    │ 5. Callback with   │
     │                    │                    │◀───────────────────│
     │                    │                    │    auth code       │
     │                    │                    │                    │
     │                    │                    │ 6. Exchange code   │
     │                    │                    │    for tokens      │
     │                    │                    │───────────────────▶│
     │                    │                    │                    │
     │                    │                    │◀───────────────────│
     │                    │                    │    User profile    │
     │                    │                    │                    │
     │                    │                    │ 7. Check allowlist │
     │                    │                    │    Provision user  │
     │                    │                    │    Generate JWT    │
     │                    │                    │    Store refresh   │
     │                    │                    │                    │
     │                    │ 8. Redirect with   │                    │
     │                    │◀───────────────────│                    │
     │                    │    access token    │                    │
     │                    │    + refresh cookie│                    │
     │                    │                    │                    │
     │ 9. Authenticated   │                    │                    │
     │◀───────────────────│                    │                    │
     │                    │                    │                    │
```

### 8.2 Token Strategy

| Token Type        | Storage (Client) | Storage (Server)  | Lifetime | Purpose                  |
| ----------------- | ---------------- | ----------------- | -------- | ------------------------ |
| **Access Token**  | Memory only      | None (stateless)  | 15 min   | API authorization        |
| **Refresh Token** | HttpOnly cookie  | SHA256 hash in DB | 14 days  | Obtain new access tokens |

**Security Properties:**

- Access tokens never touch localStorage (XSS protection)
- Refresh tokens in HttpOnly cookies (JavaScript cannot access)
- Refresh token rotation on each use (reuse detection)
- Database allows server-side revocation

### 8.3 RBAC Model

```
                    ┌─────────────────────────────────────────────┐
                    │                 PERMISSIONS                  │
                    ├─────────────────────────────────────────────┤
                    │ system_settings:read  │ system_settings:write│
                    │ user_settings:read    │ user_settings:write  │
                    │ users:read            │ users:write          │
                    │ rbac:manage           │ allowlist:read       │
                    │ allowlist:write       │                      │
                    └────────────┬───────────┴──────────────────────┘
                                 │
        ┌────────────────────────┼────────────────────────┐
        │                        │                        │
        ▼                        ▼                        ▼
┌───────────────┐      ┌───────────────┐      ┌───────────────┐
│     ADMIN     │      │  CONTRIBUTOR  │      │    VIEWER     │
├───────────────┤      ├───────────────┤      ├───────────────┤
│ ALL           │      │ user_settings:│      │ user_settings:│
│ PERMISSIONS   │      │   read/write  │      │   read        │
│               │      │               │      │               │
│ (Full Access) │      │ (Standard     │      │ (Least        │
│               │      │  User)        │      │  Privilege)   │
└───────────────┘      └───────────────┘      └───────────────┘
        │                        │                        │
        └────────────────────────┼────────────────────────┘
                                 │
                                 ▼
                        ┌───────────────┐
                        │     USERS     │
                        │  (Many-to-Many│
                        │   Assignment) │
                        └───────────────┘
```

### 8.4 Access Control Layers

```
Request → Nginx → JwtAuthGuard → RolesGuard → PermissionsGuard → Controller
            │           │             │              │
            │           │             │              └── Check @Permissions()
            │           │             │                  AND logic (all required)
            │           │             │
            │           │             └── Check @Roles() decorator
            │           │                 OR logic (any role matches)
            │           │
            │           └── Validate JWT, load user+roles+permissions
            │               Check user is active
            │
            └── Security headers, rate limiting (optional)
```

### 8.5 Email Allowlist

Before OAuth authentication completes:

1. Check if email matches `INITIAL_ADMIN_EMAIL` (bypass check)
2. Check if email exists in `allowed_emails` table
3. If not found, reject with "Email not authorized"
4. If found, proceed with user provisioning
5. Mark allowlist entry as "claimed" with user ID

**Management:**

- Admins add emails via `/api/allowlist` before users can login
- Claimed entries cannot be removed (protects existing users)
- Use user deactivation (`is_active: false`) to revoke access

---

## 9. API Architecture

### 9.1 Endpoint Categories

| Category            | Base Path                | Auth Required | Description               |
| ------------------- | ------------------------ | ------------- | ------------------------- |
| **Health**          | `/api/health/*`          | No            | Liveness/readiness probes |
| **Auth**            | `/api/auth/*`            | Varies        | OAuth, JWT, sessions      |
| **Users**           | `/api/users/*`           | Yes (Admin)   | User management           |
| **Settings**        | `/api/user-settings/*`   | Yes           | User preferences          |
| **System Settings** | `/api/system-settings/*` | Yes (Admin)   | App configuration         |
| **Allowlist**       | `/api/allowlist/*`       | Yes (Admin)   | Access control            |

### 9.2 Complete Endpoint Reference

#### Authentication Endpoints

| Method | Path                        | Auth   | Purpose                      |
| ------ | --------------------------- | ------ | ---------------------------- |
| `GET`  | `/api/auth/providers`       | Public | List enabled OAuth providers |
| `GET`  | `/api/auth/google`          | Public | Initiate Google OAuth        |
| `GET`  | `/api/auth/google/callback` | Public | OAuth callback handler       |
| `POST` | `/api/auth/refresh`         | Cookie | Refresh access token         |
| `POST` | `/api/auth/logout`          | JWT    | Single session logout        |
| `POST` | `/api/auth/logout-all`      | JWT    | All sessions logout          |
| `GET`  | `/api/auth/me`              | JWT    | Current user info            |
| `POST` | `/api/auth/test/login`      | Public | Test login bypass (dev only) |

#### Device Authorization (RFC 8628)

| Method   | Path                            | Auth   | Purpose                |
| -------- | ------------------------------- | ------ | ---------------------- |
| `POST`   | `/api/auth/device/code`         | Public | Generate device code   |
| `POST`   | `/api/auth/device/token`        | Public | Poll for authorization |
| `GET`    | `/api/auth/device/activate`     | JWT    | Get activation info    |
| `POST`   | `/api/auth/device/authorize`    | JWT    | Approve/deny device    |
| `GET`    | `/api/auth/device/sessions`     | JWT    | List device sessions   |
| `DELETE` | `/api/auth/device/sessions/:id` | JWT    | Revoke device session  |

#### User Management (Admin)

| Method  | Path                   | Permission    | Purpose                |
| ------- | ---------------------- | ------------- | ---------------------- |
| `GET`   | `/api/users`           | `users:read`  | List users (paginated) |
| `GET`   | `/api/users/:id`       | `users:read`  | Get user details       |
| `PATCH` | `/api/users/:id`       | `users:write` | Update user            |
| `PUT`   | `/api/users/:id/roles` | `rbac:manage` | Update user roles      |

#### Settings

| Method  | Path                   | Permission              | Purpose             |
| ------- | ---------------------- | ----------------------- | ------------------- |
| `GET`   | `/api/user-settings`   | `user_settings:read`    | Get user settings   |
| `PUT`   | `/api/user-settings`   | `user_settings:write`   | Replace settings    |
| `PATCH` | `/api/user-settings`   | `user_settings:write`   | Partial update      |
| `GET`   | `/api/system-settings` | `system_settings:read`  | Get system settings |
| `PUT`   | `/api/system-settings` | `system_settings:write` | Replace settings    |
| `PATCH` | `/api/system-settings` | `system_settings:write` | Partial update      |

#### Allowlist (Admin)

| Method   | Path                 | Permission        | Purpose                   |
| -------- | -------------------- | ----------------- | ------------------------- |
| `GET`    | `/api/allowlist`     | `allowlist:read`  | List allowlisted emails   |
| `POST`   | `/api/allowlist`     | `allowlist:write` | Add email                 |
| `DELETE` | `/api/allowlist/:id` | `allowlist:write` | Remove email (if pending) |

#### Health

| Method | Path                | Auth   | Purpose                |
| ------ | ------------------- | ------ | ---------------------- |
| `GET`  | `/api/health`       | Public | Full health check      |
| `GET`  | `/api/health/live`  | Public | Liveness probe         |
| `GET`  | `/api/health/ready` | Public | Readiness probe (+ DB) |

### 9.3 Response Format

#### Success Response

```json
{
  "data": {
    // Response payload
  },
  "meta": {
    "timestamp": "2024-01-01T00:00:00.000Z",
    "total": 100,
    "page": 1,
    "pageSize": 20,
    "totalPages": 5
  }
}
```

#### Error Response

```json
{
  "statusCode": 400,
  "message": "Human readable error message",
  "error": "BadRequest",
  "details": {
    // Additional context
  }
}
```

---

## 10. Frontend Architecture

### 10.1 Page Structure

| Page              | Route             | Auth     | Role  | Purpose                                                                                                                                                                                                |
| ----------------- | ----------------- | -------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Login             | `/login`          | Public   | -     | OAuth provider selection                                                                                                                                                                               |
| Auth Callback     | `/auth/callback`  | Public   | -     | Token handling                                                                                                                                                                                         |
| Home              | `/`               | Required | Any   | Dashboard                                                                                                                                                                                              |
| User Settings     | `/settings`       | Required | Any   | User preferences                                                                                                                                                                                       |
| Control Center    | `/admin/settings` | Required | Admin | Readiness, interface policy, operator settings, credentials, repositories and change history — see [`operator-configuration.md`](operator-configuration.md) and `apps/web/src/config/controlCenter.ts` |
| User Management   | `/admin/users`    | Required | Admin | User/allowlist mgmt                                                                                                                                                                                    |
| Device Activation | `/device`         | Required | Any   | Device auth approval                                                                                                                                                                                   |
| Test Login        | `/testing/login`  | Public   | -     | Test auth bypass (dev only)                                                                                                                                                                            |

**Note:** The `/testing/login` route is excluded from production builds via `import.meta.env.PROD` check.

### 10.2 Context Providers

```tsx
<App>
  <ThemeProvider>
    {' '}
    {/* MUI theme + dark mode */}
    <AuthProvider>
      {' '}
      {/* Authentication state */}
      <SettingsProvider>
        {' '}
        {/* User settings */}
        <RouterProvider>
          {' '}
          {/* React Router */}
          <Layout>
            <Pages />
          </Layout>
        </RouterProvider>
      </SettingsProvider>
    </AuthProvider>
  </ThemeProvider>
</App>
```

### 10.3 Authentication State

```typescript
interface AuthContext {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  accessToken: string | null;
  login: (provider: string) => void;
  logout: () => Promise<void>;
  refreshToken: () => Promise<void>;
}
```

### 10.4 Protected Routes

```tsx
<Route
  path="/admin/*"
  element={
    <ProtectedRoute requiredRole="admin">
      <AdminLayout />
    </ProtectedRoute>
  }
/>
```

---

## 11. Infrastructure Architecture

### 11.1 Docker Services

```yaml
# Core Services (base.compose.yml)
services:
  nginx: # Reverse proxy (port 3535)
  api: # NestJS backend (port 3000)
  web: # React frontend (port 5173)

# PostgreSQL is not bundled in base.compose.yml - it runs as a separate
# instance reached via POSTGRES_HOST/POSTGRES_PORT (see infra/compose/.env.example)

# Observability (otel.compose.yml)
services:
  otel-collector: # OpenTelemetry Collector
  uptrace: # Trace/metric visualization (port 14318)
  clickhouse: # Uptrace storage backend
```

### 11.2 Network Topology

```
┌─────────────────────────────────────────────────────────────┐
│                    Docker Network                           │
│                                                             │
│  ┌─────────┐    ┌─────────┐    ┌─────────┐                  │
│  │  nginx  │───▶│   api   │    │   web   │                  │
│  │  :3535  │    │  :3000  │    │  :5173  │                  │
│  │         │────┼─────────┼───▶│         │                  │
│  └────┬────┘    └────┬────┘    └─────────┘                  │
│       │              │                                      │
│       │              ▼                                      │
│       │         ┌─────────┐                                 │
│       │         │  otel   │   (only with otel.compose.yml)  │
│       │         │collector│                                 │
│       │         └────┬────┘                                 │
│       │              ▼                                      │
│       │         ┌─────────┐    ┌──────────┐                 │
│       │         │ uptrace │───▶│clickhouse│                 │
│       │         │ :14318  │    │          │                 │
│       │         └─────────┘    └──────────┘                 │
└───────┼─────────────────────────────────────────────────────┘
        │                              │
        ▼                              ▼
   External Access              External PostgreSQL
   http://localhost:3535        (POSTGRES_HOST / POSTGRES_PORT)
```

**PostgreSQL is not part of the Compose stack.** The `api` service connects out
to a database you provide via the `POSTGRES_*` variables; only
`infra/compose/test.compose.yml` starts a Postgres container, for tests.

### 11.3 Environment Configuration

Key environment variables (see `infra/compose/.env.example`):

```bash
# Application
NODE_ENV=development
PORT=3000
APP_URL=http://localhost:3535

# Database
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_USER=postgres
# Required only when NODE_ENV=production: the API refuses to start on a
# default or empty value there (#299). Outside production the default below
# applies unchecked. See apps/api/src/config/env.validation.ts.
POSTGRES_PASSWORD=postgres
POSTGRES_DB=appdb

# JWT — required, no default: the API refuses to start without one of at
# least 32 characters (#278). See apps/api/src/config/env.validation.ts.
JWT_SECRET=<min-32-character-secret>
JWT_ACCESS_TTL_MINUTES=15
JWT_REFRESH_TTL_DAYS=14

# OAuth
GOOGLE_CLIENT_ID=<from-google-console>
GOOGLE_CLIENT_SECRET=<from-google-console>
GOOGLE_CALLBACK_URL=http://localhost:3535/api/auth/google/callback

# Admin Bootstrap
INITIAL_ADMIN_EMAIL=admin@example.com

# Observability
OTEL_ENABLED=true
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
```

---

## 12. Observability Architecture

### 12.1 Signal Types

| Signal      | Collection                    | Storage            | Purpose                |
| ----------- | ----------------------------- | ------------------ | ---------------------- |
| **Traces**  | OTEL SDK auto-instrumentation | Uptrace/ClickHouse | Request flow tracking  |
| **Metrics** | OTEL SDK                      | Uptrace/ClickHouse | Performance monitoring |
| **Logs**    | Pino structured logs          | Uptrace/ClickHouse | Debugging, audit       |

### 12.2 Trace Propagation

```
Request → Nginx → API → Database
   │         │       │       │
   └─────────┴───────┴───────┴──▶ trace_id: abc123
                                  spans: [nginx, api, db-query]
```

### 12.3 Log Correlation

```json
{
  "level": "info",
  "time": 1704067200000,
  "msg": "User logged in",
  "requestId": "req-123",
  "traceId": "abc123",
  "spanId": "span456",
  "userId": "user-789"
}
```

### 12.4 Health Checks

| Endpoint            | Purpose              | Checks                  |
| ------------------- | -------------------- | ----------------------- |
| `/api/health/live`  | Kubernetes liveness  | Process running         |
| `/api/health/ready` | Kubernetes readiness | Process + DB connection |

---

## 13. Testing Architecture

### 13.1 Testing Strategy Overview

The project uses a **mocked database approach** for all tests by default. This provides fast, isolated tests without requiring a running PostgreSQL instance.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         TESTING ARCHITECTURE                            │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  BACKEND (apps/api/)                    FRONTEND (apps/web/)            │
│  ┌─────────────────────────────┐       ┌─────────────────────────────┐  │
│  │  Jest + Supertest           │       │  Vitest + RTL               │  │
│  │                             │       │                             │  │
│  │  Unit Tests (*.spec.ts)     │       │  Component Tests            │  │
│  │  • Co-located with source   │       │  (*.test.tsx)               │  │
│  │  • Mock all dependencies    │       │  • In __tests__/ folder     │  │
│  │                             │       │  • MSW for API mocking      │  │
│  │  Integration Tests          │       │                             │  │
│  │  (*.integration.spec.ts)    │       │  Context Tests              │  │
│  │  • In test/ directory       │       │  • AuthContext              │  │
│  │  • Full HTTP cycle          │       │  • ThemeContext             │  │
│  │  • Mocked PrismaService     │       │                             │  │
│  │                             │       │                             │  │
│  │  Mocking:                   │       │  Mocking:                   │  │
│  │  • jest-mock-extended       │       │  • MSW (Mock Service Worker)│  │
│  │  • DeepMockProxy<Prisma>    │       │  • vi.fn() for functions    │  │
│  └─────────────────────────────┘       └─────────────────────────────┘  │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 13.2 Backend Test Structure

```
apps/api/
├── src/
│   ├── auth/
│   │   ├── auth.service.spec.ts          # Unit test (co-located)
│   │   ├── auth.controller.spec.ts
│   │   ├── guards/
│   │   │   ├── jwt-auth.guard.spec.ts
│   │   │   ├── roles.guard.spec.ts
│   │   │   └── permissions.guard.spec.ts
│   │   └── strategies/
│   │       ├── jwt.strategy.spec.ts
│   │       └── google.strategy.spec.ts
│   ├── users/
│   │   └── users.service.spec.ts
│   ├── settings/
│   │   ├── user-settings/
│   │   │   └── user-settings.service.spec.ts
│   │   └── system-settings/
│   │       └── system-settings.service.spec.ts
│   └── common/
│       ├── filters/http-exception.filter.spec.ts
│       └── interceptors/transform.interceptor.spec.ts
│
└── test/
    ├── jest.config.js                    # Jest configuration
    ├── setup.ts                          # Global test setup
    ├── teardown.ts                       # Global cleanup
    ├── helpers/
    │   ├── test-app.helper.ts            # Creates test NestJS app
    │   ├── auth-mock.helper.ts           # Creates mock users with JWTs
    │   └── fixtures.helper.ts            # Test data utilities
    ├── fixtures/
    │   ├── users.fixture.ts              # User test data
    │   ├── roles.fixture.ts              # Role test data
    │   ├── settings.fixture.ts           # Settings test data
    │   ├── test-data.factory.ts          # Factory functions
    │   └── mock-setup.helper.ts          # Base mock configuration
    ├── mocks/
    │   ├── prisma.mock.ts                # Mocked PrismaService
    │   └── google-oauth.mock.ts          # Mocked OAuth strategy
    ├── auth/
    │   ├── auth.integration.spec.ts      # Auth endpoint tests
    │   ├── oauth.integration.spec.ts     # OAuth flow tests
    │   └── allowlist-enforcement.integration.spec.ts
    ├── rbac/
    │   ├── rbac.integration.spec.ts
    │   └── guard-integration.integration.spec.ts
    ├── settings/
    │   ├── user-settings.integration.spec.ts
    │   └── system-settings.integration.spec.ts
    ├── users.integration.spec.ts
    ├── health/
    │   └── health.integration.spec.ts
    └── integration/
        └── device-auth.integration.spec.ts
```

### 13.3 Backend Mocking Strategy

#### Prisma Mocking with jest-mock-extended

All backend tests use a **mocked PrismaService** via `jest-mock-extended`:

```typescript
// test/mocks/prisma.mock.ts
import { DeepMockProxy, mockDeep, mockReset } from 'jest-mock-extended';
import { PrismaClient } from '@prisma/client';

export type MockPrismaClient = DeepMockProxy<PrismaClient>;
export const prismaMock: MockPrismaClient = mockDeep<PrismaClient>();

export function resetPrismaMock(): void {
  mockReset(prismaMock);
}
```

#### Test App Helper

The `createTestApp()` helper creates a fully configured NestJS application with mocked database:

```typescript
// test/helpers/test-app.helper.ts
export async function createTestApp(
  options: { useMockDatabase?: boolean } = {},
): Promise<TestContext> {
  const shouldUseMock = options.useMockDatabase ?? true; // Default: MOCKED

  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(PrismaService)
    .useValue(prismaMock) // Inject mock instead of real Prisma
    .compile();

  // ... app configuration
  return { app, prisma, prismaMock, module, isMocked: true };
}
```

#### Integration Test Pattern

```typescript
// test/auth/auth.integration.spec.ts
describe('Auth Controller (Integration)', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(async () => {
    resetPrismaMock(); // Clear all mock calls
    setupBaseMocks(); // Set up default mock responses
  });

  it('should return current user for authenticated request', async () => {
    const user = await createMockTestUser(context); // Creates user + JWT

    const response = await request(context.app.getHttpServer())
      .get('/api/auth/me')
      .set(authHeader(user.accessToken))
      .expect(200);

    expect(response.body.data).toMatchObject({
      id: user.id,
      email: user.email,
    });
  });
});
```

### 13.4 Frontend Test Structure

```
apps/web/src/
└── __tests__/
    ├── setup.ts                          # Vitest setup (MSW, mocks)
    ├── mocks/
    │   ├── server.ts                     # MSW server instance
    │   ├── handlers.ts                   # API mock handlers
    │   └── data.ts                       # Mock response data
    ├── utils/
    │   ├── test-utils.tsx                # Custom render with providers
    │   ├── mock-providers.tsx            # Test provider wrappers
    │   └── hook-utils.tsx                # Hook testing utilities
    ├── components/
    │   ├── common/
    │   │   ├── LoadingSpinner.test.tsx
    │   │   └── ProtectedRoute.test.tsx
    │   ├── navigation/
    │   │   ├── AppBar.test.tsx
    │   │   ├── Sidebar.test.tsx
    │   │   └── UserMenu.test.tsx
    │   └── admin/
    │       ├── UserList.test.tsx
    │       ├── AllowlistTable.test.tsx
    │       └── AddEmailDialog.test.tsx
    ├── contexts/
    │   ├── AuthContext.test.tsx
    │   └── ThemeContext.test.tsx
    ├── pages/
    │   ├── LoginPage.test.tsx
    │   ├── UserSettingsPage.test.tsx
    │   └── ControlCenterPage.test.tsx
    └── services/
        └── api.test.ts
```

### 13.5 Frontend Mocking Strategy

#### MSW (Mock Service Worker)

API calls are intercepted at the network level using MSW:

```typescript
// __tests__/mocks/handlers.ts
import { http, HttpResponse } from 'msw';

export const handlers = [
  http.get('/api/auth/me', () => {
    return HttpResponse.json({
      data: {
        id: 'user-1',
        email: 'test@example.com',
        roles: [{ name: 'viewer' }],
        permissions: ['user_settings:read'],
      },
    });
  }),

  http.get('/api/auth/providers', () => {
    return HttpResponse.json({
      data: {
        providers: [{ name: 'google', displayName: 'Google' }],
      },
    });
  }),

  http.post('/api/auth/logout', () => {
    return new HttpResponse(null, { status: 204 });
  }),
];
```

#### Test Setup

```typescript
// __tests__/setup.ts
import '@testing-library/jest-dom';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeAll, afterAll, vi } from 'vitest';
import { server } from './mocks/server';

// Browser API mocks
Object.defineProperty(window, 'matchMedia', {/* ... */});
global.ResizeObserver = class ResizeObserverMock {
  /* ... */
};

// MSW lifecycle
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());
```

#### Custom Render with Providers

```typescript
// __tests__/utils/test-utils.tsx
import { render } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { ThemeProvider } from '../../contexts/ThemeContext';
import { AuthProvider } from '../../contexts/AuthContext';

export function renderWithProviders(ui: React.ReactElement, options = {}) {
  return render(ui, {
    wrapper: ({ children }) => (
      <BrowserRouter>
        <ThemeProvider>
          <AuthProvider>
            {children}
          </AuthProvider>
        </ThemeProvider>
      </BrowserRouter>
    ),
    ...options,
  });
}
```

### 13.6 Test Commands

#### Backend

```bash
cd apps/api

npm test                    # Run all tests (unit + integration)
npm run test:unit           # Unit tests only (excludes e2e pattern)
npm run test:watch          # Watch mode
npm run test:cov            # With coverage report
npm run test:debug          # Debug mode with inspector
npm run test:ci             # CI mode (coverage + JUnit reporter)
```

#### Frontend

```bash
cd apps/web

npm test                    # Run tests in watch mode
npm run test:run            # Run once and exit
npm run test:watch          # Interactive watch mode
npm run test:coverage       # With coverage report
npm run test:ui             # Open Vitest UI (browser-based)
npm run test:ci             # CI mode (coverage + JUnit reporter)
```

### 13.7 Test Configuration

#### Backend (Jest)

```javascript
// apps/api/test/jest.config.js
module.exports = {
  testRegex: '.*\\.spec\\.ts$',
  roots: ['<rootDir>/src/', '<rootDir>/test/'],
  setupFilesAfterEnv: ['<rootDir>/test/setup.ts'],
  testTimeout: 30000,
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
};
```

#### Frontend (Vitest)

```typescript
// apps/web/vitest.config.ts
export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/__tests__/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    coverage: {
      thresholds: {
        lines: 70,
        branches: 70,
        functions: 70,
        statements: 70,
      },
    },
    testTimeout: 10000,
  },
});
```

### 13.8 Key Testing Patterns

| Pattern               | Backend                           | Frontend                              |
| --------------------- | --------------------------------- | ------------------------------------- |
| **Database**          | Mocked via jest-mock-extended     | N/A                                   |
| **API Calls**         | Direct HTTP via Supertest         | MSW network interception              |
| **Authentication**    | Mock JWT tokens generated         | MSW handlers return user              |
| **Test Isolation**    | `resetPrismaMock()` in beforeEach | `server.resetHandlers()` in afterEach |
| **Async Handling**    | `async/await` with Jest           | `waitFor()` from RTL                  |
| **User Interactions** | N/A                               | `userEvent` from @testing-library     |

### 13.9 Important Notes

1. **No Real Database Required**: All tests run with mocked Prisma - no PostgreSQL needed
2. **Test File Naming**:
   - Backend unit: `*.spec.ts` (co-located with source)
   - Backend integration: `*.integration.spec.ts` (in test/ directory)
   - Frontend: `*.test.tsx` (in **tests**/ directory)
3. **Coverage Thresholds**: Frontend enforces 70% minimum coverage
4. **MSW Strict Mode**: Unhandled API requests fail tests (`onUnhandledRequest: 'error'`)
5. **Type Safety**: Prisma mocks are fully typed via `DeepMockProxy<PrismaClient>`

---

## 14. Agent-Based Development Model

### 14.1 Specialized Agents

This project uses specialized AI coding agents for different domains:

| Agent          | File                             | Domain        | Responsibilities                                 |
| -------------- | -------------------------------- | ------------- | ------------------------------------------------ |
| `backend-dev`  | `.claude/agents/backend-dev.md`  | API Layer     | NestJS controllers, services, guards, OAuth, JWT |
| `frontend-dev` | `.claude/agents/frontend-dev.md` | UI Layer      | React components, pages, hooks, MUI theming      |
| `database-dev` | `.claude/agents/database-dev.md` | Data Layer    | Prisma schema, migrations, seeds, queries        |
| `testing-dev`  | `.claude/agents/testing-dev.md`  | Quality       | Jest, Supertest, Vitest, RTL, type checking      |
| `docs-dev`     | `.claude/agents/docs-dev.md`     | Documentation | Architecture, API, security docs                 |

### 14.2 Agent Invocation Rules

**MANDATORY**: All development tasks MUST be delegated to the appropriate agent.

| Task Type        | Required Agent | Example                           |
| ---------------- | -------------- | --------------------------------- |
| Add API endpoint | `backend-dev`  | "Implement user search endpoint"  |
| Create component | `frontend-dev` | "Build user avatar component"     |
| Schema change    | `database-dev` | "Add email verification table"    |
| Write tests      | `testing-dev`  | "Add integration tests for auth"  |
| Update docs      | `docs-dev`     | "Document new endpoint in API.md" |

### 14.3 Multi-Agent Workflow

For features spanning multiple domains, invoke agents sequentially:

```
Feature: "Add user notification preferences"

1. database-dev  → Add preferences to user_settings schema
2. backend-dev   → Implement API endpoints
3. frontend-dev  → Build settings UI
4. testing-dev   → Write tests for all layers
5. docs-dev      → Update documentation
```

### 14.4 Agent Context

Each agent has full context of:

- System specification document
- Technology stack requirements
- Code patterns and conventions
- Security requirements
- Testing standards

### 14.5 Orchestration Responsibilities

The orchestrating agent (Claude) handles:

- Reading files to understand context
- Answering questions about the codebase
- Planning and coordinating between agents
- Running simple commands (git, npm)
- Reviewing agent outputs

**What NOT to do directly:**

- Write NestJS code (use `backend-dev`)
- Create React components (use `frontend-dev`)
- Modify Prisma schema (use `database-dev`)
- Write tests (use `testing-dev`)
- Update documentation (use `docs-dev`)

---

## 15. Development Workflows

### 15.1 Local Development Setup

```bash
# 1. Clone repository
git clone <repository-url>
cd opifex

# 2. Configure environment
cp infra/compose/.env.example infra/compose/.env
# Edit .env with your Google OAuth credentials

# 3. Start services
cd infra/compose
docker compose -f base.compose.yml -f dev.compose.yml up

# 4. Seed database (first time only)
docker compose exec api sh
cd /app/apps/api && npx tsx prisma/seed.ts
exit

# 5. Access application
# UI: http://localhost:3535
# API: http://localhost:3535/api
# API reference: http://localhost:3535/api/docs
```

### 15.2 Database Changes

```bash
# 1. Modify schema
# Edit apps/api/prisma/schema.prisma

# 2. Create migration
cd apps/api
npm run prisma:migrate:dev -- --name descriptive_name

# 3. Generate client
npm run prisma:generate

# 4. Update seeds if needed
# Edit apps/api/prisma/seed.ts
```

### 15.3 Adding New Features

1. **Plan**: Identify which agents are needed
2. **Database**: Schema changes via `database-dev`
3. **Backend**: API implementation via `backend-dev`
4. **Frontend**: UI implementation via `frontend-dev`
5. **Testing**: Test coverage via `testing-dev`
6. **Documentation**: Updates via `docs-dev`

### 15.4 Testing

See [Section 13: Testing Architecture](#13-testing-architecture) for comprehensive testing documentation.

```bash
# Backend tests (all use mocked database)
cd apps/api
npm test                    # All tests (unit + integration)
npm run test:watch          # Watch mode
npm run test:cov            # With coverage

# Frontend tests
cd apps/web
npm test                    # Watch mode
npm run test:run            # Run once
npm run test:coverage       # With coverage
npm run test:ui             # Visual Vitest UI

# Type checking
cd apps/api && npm run typecheck
cd apps/web && npm run typecheck
```

---

## 16. Appendices

### 16.1 Quick Reference

#### Service URLs (Development)

| Service                | URL                            |
| ---------------------- | ------------------------------ |
| Application            | http://localhost:3535          |
| API Reference (Scalar) | http://localhost:3535/api/docs |
| Uptrace                | http://localhost:14318         |
| PostgreSQL             | localhost:5432                 |

#### Key Commands

```bash
# Start dev environment
cd infra/compose && docker compose -f base.compose.yml -f dev.compose.yml up

# Start with observability
cd infra/compose && docker compose -f base.compose.yml -f dev.compose.yml -f otel.compose.yml up

# Run migrations
cd apps/api && npm run prisma:migrate:dev -- --name <name>

# Generate Prisma client
cd apps/api && npm run prisma:generate

# Run tests
cd apps/api && npm test
cd apps/web && npm test
```

### 16.2 Related Documents

| Document                                                             | Purpose                                                                                                           |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| [VISION.MD](../VISION.MD)                                            | **Start here.** Why Opifex exists and what it deliberately is not — the north star this document does not restate |
| [docs/adr/](adr/)                                                    | Architecture decision records — the individual decisions behind §3                                                |
| [PROVENANCE.md](PROVENANCE.md)                                       | The commit trailer vocabulary that makes the Decision→Issue→WorkOrder→PR→Commit chain traversable                 |
| [RUNBOOK-observation-week.md](RUNBOOK-observation-week.md)           | How to turn the control plane on, stage by stage, and what to read while it runs                                  |
| [SECURITY-ARCHITECTURE.md](SECURITY-ARCHITECTURE.md)                 | Detailed security documentation (foundation layer: OAuth, JWT, RBAC, allowlist, audit)                            |
| [API.md](API.md)                                                     | API endpoint reference                                                                                            |
| [DEVELOPMENT.md](DEVELOPMENT.md)                                     | Development guide                                                                                                 |
| [TESTING.md](TESTING.md)                                             | Testing framework guide                                                                                           |
| [DEVICE-AUTH.md](DEVICE-AUTH.md)                                     | Device authorization guide                                                                                        |
| [personal-access-tokens.md](personal-access-tokens.md)               | Personal access token feature guide                                                                               |
| [ssl-nginx-setup.md](ssl-nginx-setup.md)                             | Dev-VPS deployment runbook (nginx, SSL, compose)                                                                  |
| [System_Specification_Document.md](System_Specification_Document.md) | Pre-pivot product spec. Superseded by VISION.MD and this document; kept for history, not for current requirements |
| [CLAUDE.md](../CLAUDE.md)                                            | AI assistant guidance                                                                                             |

### 16.3 Specification Index

Implementation specs in `docs/specs/`:

| Phase        | Specs | Description                             |
| ------------ | ----- | --------------------------------------- |
| Foundation   | 01-03 | Project setup, database schema, seeds   |
| API Core     | 04-07 | NestJS setup, OAuth, JWT, RBAC          |
| API Features | 08-12 | Users, settings, health, observability  |
| Frontend     | 13-18 | React setup, pages, components          |
| Testing      | 19-24 | Test frameworks, unit/integration tests |

---

## Document History

| Version | Date         | Author       | Changes                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------- | ------------ | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.0     | January 2026 | AI Assistant | Initial comprehensive architecture document                                                                                                                                                                                                                                                                                                                                                                                   |
| 1.1     | August 2026  | AI Assistant | Corrected §1–2 to describe Opifex as an AI software factory rather than only a web application template; added §3 Control Plane Architecture (reconciler, work orders, dispatch, runner seam, run events/watchdog, escalations, supervisor, cockpit); updated §6.1's repository tree and §16.2's related-documents table to include VISION.MD, `docs/adr/`, `PROVENANCE.md` and the observation-week runbook. See issue #304. |
