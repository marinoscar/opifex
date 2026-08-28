# Opifex — Vision

> _opifex_ (Latin): a maker, a craftsman, one who works at a craft.
>
> **Opifex supervises AI coding agents so that a single engineer can run a large software project without being the monitoring system.**

Status: draft v0.1 · Owner: Oscar Marin · Last updated: 2026-08-17

---

## 1. Why this exists

Coding agents are already good enough to do substantial work unattended. The
constraint is no longer capability. It is **supervision cost**.

The origin of this project is a specific, measurable, and boring failure:

- An agent hits a rate limit at 2pm. I find out at 6pm. Four hours dead.
- A session stalls at 10am. I find out at 2pm. Four hours dead.

Two different causes, one identical cost: **the gap between "the agent stopped
producing" and "I know about it."** Today I am the monitoring system, and I poll
manually every few hours. That is the entire problem, and everything in Opifex
follows from taking it seriously.

The second motivation is provenance. Agent-written code accumulates fast and its
_reasoning_ evaporates. A design decision made by an agent three weeks ago, never
recorded, is gone permanently — intent cannot be reconstructed from a diff. Lost hours
can be recovered by working faster. Lost provenance cannot be recovered at all.

That asymmetry sets the priority: **provenance discipline first, supervision second,
throughput last.**

### The metric that names the problem

**Detection latency** — the elapsed time between a run ceasing to make progress and a
human being informed. Currently measured in hours. Target: seconds.

Nearly every design decision in this document can be traced back to reducing that
number, or to making the record of work complete enough to be worth automating in the
first place.

---

## 2. What Opifex is

A **control plane for coding agents.**

Opifex takes units of work described in GitHub, dispatches them to coding agents,
watches those agents continuously, recovers from the failures that are recoverable,
escalates the ones that are not, and writes the complete record of what happened back
into GitHub.

It is three things stacked:

1. **A supervisor** — detects stalls, rate limits, loops, and budget overruns in
   near-real-time; parks and resumes automatically where it can; escalates where it
   cannot.
2. **A factory** — turns designs and requirements into tracked, traceable, executable
   work orders, and turns those into reviewed pull requests.
3. **A cockpit** — a web application giving a single view of every project, run, cost,
   and queue, across repositories, that GitHub alone cannot provide.

### What Opifex is not

Being explicit here prevents scope drift more effectively than any roadmap.

- **Not a coding agent.** It orchestrates them. It never writes application code itself.
- **Not a replacement for GitHub Projects.** Project tracking is a read model, not a
  second place to manage work.
- **Not a multi-tenant SaaS.** Single-operator by design (see §11).
- **Not an autonomous software engineer.** The ambition is _reduced supervision cost_,
  not _zero human judgment_.
- **Not a plugin platform.** No dynamic loading, no runner marketplace, no extension
  registry. Two runners and a switch statement is the correct amount of machinery.

---

## 3. Principles

These are load-bearing. Violating one should require rewriting this document.

### 3.1 Deterministic control plane, non-deterministic workers

Dispatch logic, retry policy, stall thresholds, budget enforcement, and state
transitions are **code**. Judgment about what to build is **model**.

Most systems built on coding agents invert this — they ask a model to orchestrate
itself, which is precisely why their operators end up supervising them. Opifex refuses
that inversion at every layer, including in its own AI supervisor (§7).

### 3.2 Everything the agents do is tracked in GitHub

Designs, feature requests, bugs, requirements, work authorizations, code, pull
requests, reviews, and run outcomes all land in GitHub. Not because GitHub is the only
store, but because a record split across two systems is a record nobody trusts.

The single deliberate exception is high-volume telemetry (§8).

### 3.3 The orchestrator owns execution state

GitHub holds the _record of work_. Opifex holds the _state of execution_ — queue
position, run status, heartbeats, cost, quota timers, retry counters. This state is
authoritative and lives in Postgres, because modelling a work queue in issue labels
produces race conditions and API-rate-limit problems for no benefit.

Labels remain a **bidirectional edge**, not the state machine:

- **Input labels** express human intent and Opifex obeys them: `factory:hold`,
  `factory:ready`, `factory:clear-quarantine`
- **Mirror labels** are written by Opifex for visibility and never read as truth:
  dispatched, blocked, review, quarantine

You steer from GitHub. Machine state lives where machine state belongs.

### 3.4 Work orders are small enough to throw away

Recovery is **abandon and re-run from the pinned base commit**, not session
resumption. This is what keeps the system vendor-neutral: cross-agent session state
never has to exist.

Vendor-specific resumption stays available as an optimization behind a capability
flag. Allowed. Never load-bearing.

### 3.5 Gate on reversibility, not importance

Approval fatigue comes from gating things that are _significant_ rather than things
that are _hard to undo_. A commit to a factory branch is fully reversible — never ask.
A force-push, a merge, a Slack post, or money spent is not.

Sorting actions by reversibility rather than significance reduces interruption volume
by roughly an order of magnitude without reducing safety.

### 3.6 The agent proposes; code disposes

No model output takes effect without passing through deterministic policy. This holds
even when the model is right, because a system whose safety depends on a model being
right has no safety property at all.

### 3.7 Claude Code first, vendor-neutral by construction

Build one runner well. Build the _seam_ correctly from day one. Do not build the
second runner until it is needed.

---

## 4. The shape of the system

```
  ┌────────────────────────────────────────────────────────────┐
  │  RECORD          GitHub                                    │
  │  issues · ADRs · work-order authorizations · branches ·    │
  │  commits + trailers · PRs · reviews · run summaries        │
  └────────────────────────────────────────────────────────────┘
              ▲  writes record            reads intent  │
              │                                         ▼
  ┌────────────────────────────────────────────────────────────┐
  │  CONTROL         Opifex orchestrator (deterministic)       │
  │  reconciler · queue · dispatch · policy · budgets ·        │
  │  watchdog · trust grants · approval gates                  │
  └────────────────────────────────────────────────────────────┘
       │ Work Order            ▲ normalized events    ▲ proposals
       ▼                       │                      │
  ┌──────────────────────┐  ┌───────────────────┐  ┌──────────────┐
  │  RUNNERS             │  │  OBSERVABILITY    │  │  SUPERVISOR  │
  │  claude-code-local   │  │  Postgres + OTel  │  │  AI, advisory│
  │  claude-code-cloud   │  │  Grafana          │  │  off hot path│
  │  (others later)      │  └───────────────────┘  └──────────────┘
  └──────────────────────┘
```

### The control loop

The orchestrator is a **reconciler**, not a job queue, at its GitHub edge. Each tick it
observes GitHub and its own run state, computes what should be true, acts, and records.

This matters for one practical reason: **you can always fix the factory by editing
GitHub.** Put `factory:hold` on an issue and it stops. A pure queue drifts the moment
a human intervenes and never recovers; a reconciler treats manual intervention as a
first-class input.

### Work orders

A **Work Order** is a vendor-neutral, self-contained specification: repository at a
pinned commit, task spec, testable acceptance criteria, path constraints, budget
ceiling, wall-clock timeout, and provenance links back to its issue and decisions.

It is a **projection** of a GitHub issue, never an independent source of truth.
Identity is deterministic —

```
wo_<repo>_<issue>_<base_commit[0:7]>_a<attempt>
factory/<issue>-<base_commit[0:7]>-a<attempt>
```

— which makes re-runs idempotent: a runner checks whether its branch already exists
before doing anything.

The work order is posted to the issue as a fenced JSON comment (the _authorization
record_) and committed to the branch as its first commit (the _execution record_).

Schema: `schemas/work-order.schema.json`.

---

## 5. Provenance model

The goal is that in two years, "why does this module work this way?" is a graph
traversal rather than an archaeology session.

| Artifact                               | Where it lives                                               |
| -------------------------------------- | ------------------------------------------------------------ |
| Design decision                        | `docs/adr/NNNN-*.md` — versioned, diffable, reviewable       |
| Decision discussion & approval         | Issue, closed when the ADR merges                            |
| Feature request / bug                  | Issue, typed by label                                        |
| Requirement / story                    | Issue, linked to an epic                                     |
| Work order authorization               | Issue comment, fenced JSON                                   |
| Code                                   | Commits on `factory/*` branches                              |
| Run narrative                          | PR comment: runner, cost, duration, attempts, why it stopped |
| Review                                 | PR review threads                                            |
| Event stream, heartbeats, token detail | **Postgres only**                                            |

Decisions are **files, not issues**. An ADR is a durable artifact that should be
reviewed, versioned, and survive GitHub itself. An issue is a conversation. Conflating
them loses both properties.

### Commit trailers

Enforced by CI. A pull request missing them fails its provenance check.

```
Work-Order: wo_opifex_312_a3f91c2_a1
Issue: #312
Decision: ADR-0042
Runner: claude-code-local@2.1.223
Run-Id: 018f2c31-...
Attempt: 1
```

Plus a closing keyword in every PR body. **No PR without one** — a single orphan puts a
hole in the graph, and holes are not detectable after the fact.

### Why the vocabulary matters now

Once trailers and closing keywords are disciplined, the GitHub graph extracts cleanly
into a knowledge graph:

```
Decision --informed--> Issue --generated--> WorkOrder --produced--> PR --contains--> Commit
```

This is a natural PROV-O shape. Designing the trailer vocabulary _before_ there is
history to migrate is the single cheapest high-leverage decision in this project.

### The gap most systems miss

Commits and PRs land in GitHub naturally. **What the agent did and why it stopped does
not** — unless deliberately written there. The run summary PR comment exists precisely
to close that gap. It is the join point between the human-readable record and the
telemetry store.

### Issue creation is gated

The failure mode that destroys agent-driven traceability is volume: every run opens
issues, four hundred accumulate, and traceability inverts into noise.

Agents comment freely. Creating an issue requires passing a dedupe check against open
issues and conforming to a template. Cheap to enforce; saves the entire premise.

---

## 6. Runner strategy

### The seam is the data contract, not an interface

The instinct — `ICodingAgent.execute(task)` with adapters underneath — fails, because
coding agents do not differ superficially. They differ in **invocation model,
execution locus, and observability surface**. An interface wide enough to cover all of
them leaks one vendor's semantics everywhere; narrow enough to be honest, it is
useless.

What they genuinely share is only this: they take **a repository at a commit plus a
task spec** and produce **a branch and some trace of what happened.** That is the whole
common surface, so that is the contract.

```
submit(WorkOrder) -> handle
poll(handle)      -> status + events
cancel(handle)    -> void
capabilities()    -> RunnerCapability
```

This is the CI-runner pattern. GitHub Actions does not abstract over compilers; it
abstracts over jobs.

### Capabilities, not uniformity

Runners **declare** what they can do rather than pretending to be equivalent:
invocation model, execution locus, streaming fidelity, rate-limit signal quality, cost
reporting, resumability, concurrency limits, branch restrictions, stability tier.

The control plane then **degrades gracefully**. Full streaming enables event-age
watchdogs and tool-loop detection. No streaming falls back to wall-clock timeouts and
git-derived liveness. It gets dumber, not broken.

Stated plainly: **equal observability across vendors is not achievable.** A common
floor that some runners exceed is.

Schema: `schemas/runner-capability.schema.json`.

### Planned runners

| Runner              | Locus              | Role                                                       |
| ------------------- | ------------------ | ---------------------------------------------------------- |
| `claude-code-local` | own infrastructure | v1 — full streaming, local filesystem, private services    |
| `claude-code-cloud` | vendor cloud       | v1.1 — free compute, real parallelism, near-zero streaming |
| `claude-code-api`   | own infrastructure | overflow when subscription quota is exhausted              |
| others              | —                  | capabilities verified at build time, not designed for now  |

Routing matches a work order's declared _needs_ against advertised capabilities. Work
orders never name a runner.

### Why the seam earns itself immediately

A second runner is a real answer to quota exhaustion: work routes elsewhere instead of
parking for hours. This is not a someday benefit. It is the strongest argument for the
abstraction existing on day one.

---

## 7. The AI supervisor

The ambition is an AI agent that operates the coding agents. The trap is recursion: a
non-deterministic supervisor that can itself stall, exhaust quota, and behave
unpredictably, supervising components that stall and exhaust quota — leaving a human
to supervise _it_. That is the original problem, one level up.

**Governing test: if the AI supervisor is offline, the factory keeps running.** Dumber
about diagnosis. Still correct about execution.

| Deterministic — hot path, always on    | Advisory agent — async, off path            |
| -------------------------------------- | ------------------------------------------- |
| Dispatch decisions                     | Failure diagnosis and root-cause narration  |
| Stall detection (event-age thresholds) | Issue shaping → acceptance criteria         |
| Rate-limit parking and auto-resume     | Decomposition of oversized work orders      |
| Budget and timeout enforcement         | Daily brief, ranked by what needs attention |
| Retry counters, quarantine             | Spec-quality feedback                       |
| State transitions                      | Anomaly explanation                         |

The left column must be fast, cheap, testable, and never fail — a model makes it
slower, costlier, and less reliable with no upside. The right column is judgment work
where rules genuinely cannot compete.

### Stateless agent, stateful system

The supervisor holds **no state in its context**. Postgres holds state; the supervisor
receives a rendered snapshot at invocation and returns a proposal. Without this you get
context drift and an agent confidently reasoning about a run that ended two days ago.

It runs on a small model, on a schedule — not per-event. It consumes the same quota as
the workers, and a supervisor competing for the quota it is managing is a bad loop.

### Earned autonomy

Trust is granted per **action class**, on evidence, never in bulk:

1. **Observe** — the supervisor writes proposals to a decision log and executes
   nothing. Two to four weeks.
2. **Measure** — per action class, what fraction of proposals would have been approved?
3. **Promote** — auto-execute the classes with a demonstrated record.
4. **Demote** — automatic on regression, not a judgment call.

Expected promotion order: re-dispatch after transient failure → decomposition of
timed-out orders → issue shaping → quarantine decisions (probably never).

This is also how the question "may an agent promote an issue to `factory:ready`?" gets
answered — not as a yes or no, but as rung 3 for that specific action class, granted on
evidence.

---

## 8. Human in the loop

The goal is not fewer decisions. It is **decisions batched and moved off the critical
path**.

### Approvals must be cheap or trust becomes meaningless

Operators grant blanket trust out of friction, not conviction. If approvals arrive as a
2am email read at 9am, everything gets blanket-approved within a week — chosen while
annoyed rather than while thinking.

So: one tap from a phone, with enough context to decide — what, why, blast radius, and
what happens if ignored.

### Trust grants are scoped, expiring, and self-revoking

"Don't ask me anymore" never produces a permanent global grant. Every grant carries
four attributes, attached automatically:

- **Scope** — action class × repository. Never "trust the agent."
- **Expiry** — days or session. Renewal is one tap; silence revokes.
- **Budget ceiling** — the grant dies at a cumulative spend.
- **Auto-revoke** — failure rate or cost-per-PR crossing a threshold suspends the grant
  and explains why.

Every approval offers **Approve / Deny / Always approve this class**. The third option
silently attaches all four. Safe by construction, one tap.

### Timeout policy is per class, because blocking gates generate stalls

An agent parked awaiting an answer while its operator sleeps is exactly the dead time
this project exists to eliminate.

- Reversible → auto-approve on timeout, logged
- Irreversible → park and escalate, never auto-approve
- Spends money → deny on timeout

### Never trustable

Hardcoded, not policy-configurable, regardless of any grant:

- Force-push, or any write to protected branches
- Deleting branches, issues, or pull requests
- Reading or writing credentials
- Spend above the hard ceiling
- **Modifying CI workflows or the policy table**
- **Modifying budget configuration outside an interactive, RBAC-gated admin action**

The workflow-and-policy-table item matters most. An agent that can edit the check
enforcing its own trailers, or grant itself trust, has the appearance of guardrails and
none of the substance. For the same reason, it cannot clear its own quarantine. Nothing
qualifies that one: there is no authorized path, no admin screen, no break-glass.

Budget configuration is stated separately because one path to it is legitimate and every
other path is not. The operator who most needs to lower a ceiling is the one watching
spend run away right now, and requiring an SSH session and a process restart to do it
makes the safety mechanism slowest at the only moment it is urgent. So the ceilings are
editable — by a signed-in human, through an RBAC-gated write that refuses any credential
which cannot prove a person was present, recorded in the audit log. Outside that, nothing
changes: no trust grant raises a ceiling, no promoted action class reaches the write, no
agent-reachable path touches it, and an attempt to do so is refused by name rather than
caught by accident. "A limit an agent can raise is not a limit" still holds exactly as written.
What is admitted is that the operator is not an agent — and the cost of admitting it is
real, because the guarantee is now that the agent cannot reach the write rather than that
the write does not exist. That is a weaker kind of promise, and it is only worth making
while both barriers that hold it up are actually in force.

### The digest replaces the interruptions

Auto-approved actions still record what _would_ have been asked. Instead of
interruptions, a daily rollup: what ran under trust, what it cost, what it changed,
what looked unusual. This is what makes the promotion ladder honest — grants stay
visible while they earn themselves.

---

## 9. Observability

### Two independent liveness sources

1. **Runner-reported** — structured event streams. Rich, fine-grained, vendor-specific.
2. **Git-derived** — commits landing, PR state transitions, CI runs firing. Universal,
   works for every coding agent that exists or will exist.

**Build the git watcher first, even though the v1 runner does not need it.** Running
both in parallel is the only real test that the runner abstraction holds. Building only
the streaming path guarantees discovering, six months later, that the seam was
fictional.

### Three failure modes, three responses

Collapsing these is the most common supervision bug:

- **Silent** — no events at all → kill, re-run from base commit
- **Looping** — events flowing, tool signature repeating → kill, re-plan
- **Blocked** — structured reason with a reset time → park, auto-resume with jitter

### The normalized event floor

Six event types: `run.started`, `run.heartbeat`, `run.progress`, `run.blocked`,
`run.completed`, `run.failed`. Every runner maps into these. Events carry a `source`
field distinguishing runner-reported from git-derived from control-plane-synthesized —
a synthesized event must never masquerade as a report.

Mapped to OpenTelemetry: one trace per work order, one span per turn or tool call,
cost and tokens as span attributes.

Schema: `schemas/run-event.schema.json`.

### Escalation is an action, not telemetry

A stalled run that nobody is told about is the exact failure this system exists to
eliminate. Notification is a reconciler output, on the same footing as dispatch.

---

## 10. Success criteria

Six metrics. The web application exists primarily to show them.

| #   | Metric                                                     | Why                                                  |
| --- | ---------------------------------------------------------- | ---------------------------------------------------- |
| 1   | **Detection latency** — stop → notified                    | The original complaint, quantified. Target: seconds. |
| 2   | **Dead time per day** — hours parked or stalled            | Direct measure of recovered productivity             |
| 3   | **First-pass acceptance rate** — PRs merged without rework | Spec quality                                         |
| 4   | **Attempts per work order**                                | Decomposition quality                                |
| 5   | **Cost per merged PR**                                     | Economic viability                                   |
| 6   | **Quota burn vs. reset window**                            | Scheduling health                                    |

### Metric 3 decides the roadmap

If first-pass acceptance is low, **adding throughput actively makes life worse** — more
PRs, more review, more rework. Fix specification quality before scaling. If it is high,
scale hard.

Opifex is succeeding when a work order can be authorized in the morning and its pull
request reviewed in the evening, with no intervention in between, and the full chain
from decision to commit is traceable without asking anyone what happened.

### The risk that would kill this

Not orchestration. **Verification.** A factory producing pull requests faster than they
can be reviewed is negative value. Green CI is a hard gate before any PR is surfaced
for human review, and "acceptance criteria are testable" is the definition of a
well-formed issue.

Throughput ceiling is spec quality, not token budget.

---

## 11. Constraints and boundaries

- **Single operator.** Opifex runs under one person's credentials. Agent
  subscription credentials are licensed for individual use; routing another person's
  request through them is out of bounds and would exhaust quota immediately regardless.
  Multi-user is not a deferred feature — it is a different product.
- **Preview dependencies.** Several capabilities this design would like to lean on are
  research-preview and may change. Nothing preview-tier may be load-bearing; every
  preview runner needs a GA fallback that accepts identical work orders.
- **Shared quota.** Automated runs compete with interactive use for the same limits.
  Scheduling and model tiering are first-class concerns, not optimizations.
- **GitHub-shaped work.** Some runners can only operate on GitHub-hosted repositories.
  This is a routing constraint, encoded in capabilities, not a global limitation.

---

## 12. Roadmap

Ordered by _what cannot be backfilled_ first, not by what is most visible.

**Phase 0 — Conventions.** Issue templates, ADR structure, trailer vocabulary, CI
provenance check. Almost no code. Highest half-life: everything downstream inherits it,
and history written without it cannot be repaired.

**Phase 1 — Contracts.** Work order, runner capability, and run event schemas.
Validated, versioned, with worked examples.

**Phase 2 — Reconciler, read-only.** Observe and mirror labels. **No dispatch.** Run
for a week. This is not caution theatre — it surfaces every wrong assumption about
state transitions before anything can write to a repository. **Since ADR-0019
(#439), a fresh install no longer reaches this state by default.** The control
plane ships ready — the reconciler observing, the runner registered, dispatch
enabled, GitHub writes permitted — because each of the flags that used to hold
it back either could never be satisfied (a single-runner fleet can never
produce the GA fallback its preview-runner rule required) or turned out to
hide problems rather than catch them (an observation week that never writes
anything is indistinguishable, from its own log, from one that wrote and
found nothing wrong). What has not changed is the reasoning above: running a
repository read-only before trusting it with writes is still the fastest way
to find a wrong assumption about state transitions, and it is still worth a
week. What changed is who has to ask for it — an operator who wants this week
now turns `github.writesEnabled` off deliberately, rather than getting one by
leaving every switch at its shipped default. The only thing a fresh install
still refuses on its own is spend: `dispatch.hardSpendCeilingUsd` has no
default, and no run starts until an operator names one.

**Phase 3 — Liveness and escalation.** Git watcher, event ingestion, watchdog,
notification path to phone. _This is the phase that solves the original problem._
Everything after it is leverage.

**Phase 4 — Execution.** `claude-code-local` runner, dispatch, budget ceilings,
quarantine, auto-resume from rate limits.

**Phase 5 — Cockpit.** Web application: projects, runs, queue, cost, the six metrics.

**Phase 6 — Supervisor, observe-only.** Advisory agent writing to a decision log.
Measure. Do not promote anything for at least a month.

**Phase 7 — Earned autonomy.** Promotion ladder, trust grants, approval gates, digest.

**Phase 8 — Second runner.** Only when quota pressure or vendor risk justifies it.

Phases 0–3 are the minimum viable Opifex. They are also perhaps 15% of the total
effort, and they capture most of the value.

---

## 13. Open questions

- **Reconciler tick vs. webhooks.** Start with polling. Add webhooks when tick latency
  demonstrably hurts, not before.
- **Where do shaping agents run?** Probably scheduled cloud sessions rather than the
  local pool, to avoid competing with execution work.
- **May agents author ADRs?** Propose-only, human merges. Revisit after three months of
  evidence.
- **How small is a work order, exactly?** The abandon-and-rerun rule implies a ceiling,
  but the number should come from measuring attempts-per-order rather than from theory.
- **Cross-repo work orders.** Currently out of scope. Likely stays that way.

---

## 14. Glossary

| Term                    | Meaning                                                                                             |
| ----------------------- | --------------------------------------------------------------------------------------------------- |
| **Work Order**          | Vendor-neutral, self-contained unit of executable work; a projection of an issue pinned to a commit |
| **Runner**              | Anything that can accept a work order and produce a branch                                          |
| **Capability manifest** | A runner's honest declaration of what it can and cannot do                                          |
| **Reconciler**          | The control loop that derives desired state and acts, rather than consuming a queue                 |
| **Detection latency**   | Elapsed time between a run stopping and a human knowing                                             |
| **Trust grant**         | A scoped, expiring, budget-capped, self-revoking authorization to skip an approval                  |
| **Action class**        | The unit at which autonomy is granted — never "the agent" as a whole                                |
| **Provenance chain**    | Decision → Issue → Work Order → PR → Commit, machine-traversable via trailers                       |

---

## 15. Related documents

- `ARCHITECTURE.md` — layers, state ownership, reconciliation rules, resilience model
- `schemas/work-order.schema.json`
- `schemas/runner-capability.schema.json`
- `schemas/run-event.schema.json`
- `docs/adr/` — architecture decision records
