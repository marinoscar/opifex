# 3. Uptrace is the observability backend; Grafana is not deployed

- Status: Accepted
- Date: 2026-08-22
- Issue: #59
- Epic: #17

## Context

VISION's architecture diagram names **Grafana**. This repository ships
**Uptrace**: `infra/compose/otel.compose.yml` runs `uptrace/uptrace:2.0.1`
with ClickHouse and a metadata Postgres behind it, an OTEL Collector in front,
and the UI on `http://localhost:14318`. `apps/api/src/instrumentation.ts` has
exported OTLP traces and metrics into that collector since before this epic.

#59 asks for detection latency — VISION §10's success metric 1 — to be
"queryable per run and aggregatable for the cockpit", and notes the
discrepancy directly: _"Either is fine — but pick one deliberately and say so,
rather than half-configuring both."_

That warning is the real decision being made here. A half-configured second
backend is worse than no second backend: it produces a dashboard that renders,
that somebody eventually trusts, and that is quietly missing whichever signal
was never wired into it. For a system whose entire purpose is noticing that
something has gone quiet, an observability stack with a silent gap in it is a
particularly bad thing to own.

## Decision

**Uptrace is the observability backend.** Grafana is not deployed, and
VISION's diagram is superseded on this point.

Detection latency is exposed on two paths, deliberately:

1. **OpenTelemetry**, for the operator's own investigation — the histograms
   `opifex.detection.latency` and `opifex.detection.detect_latency`, the
   counters `opifex.escalations.raised` and `opifex.escalations.notified`, and
   a span per work order phase inside the work order's trace.
2. **`GET /api/escalations/latency`**, for the cockpit (#20) — the same
   measurement, aggregated from the `escalations` table, with no dependency on
   the OTEL stack running at all.

## Consequences

**Uptrace over Grafana, on the merits and not only on inertia.** Grafana is a
visualization layer; to store traces and metrics it needs Tempo or Jaeger plus
Prometheus or Mimir beside it. That is three or four services to configure,
scrape, retain and upgrade. Uptrace is one binary over ClickHouse that ingests
OTLP traces, metrics and logs together and correlates them in one UI. VISION
§11 designs explicitly for a **single operator** — the deciding factor is not
which tool has the better panels, it is which stack one person can keep
running while their actual attention is on the factory.

**The cockpit does not depend on the OTEL stack.** This is why #59's
measurement is persisted onto the `escalations` row (`progress_stopped_at`,
`detection_source`, `detect_latency_ms`, `notify_latency_ms`) as well as
recorded as a metric. `OTEL_ENABLED=false` is a supported configuration, and
under it the API still answers `GET /api/escalations/latency` correctly.
Putting success metric 1 exclusively in a backend that can be switched off
would mean the number that defines the problem disappears when the operator
economizes.

**Metrics are duplicated by design, and can disagree.** The OTLP histograms
and the SQL aggregate are computed from the same events but by different
paths, and their windows do not align: the exporter pushes every 60 seconds
and the aggregate reads the table live. Small divergence is expected. Large
divergence means one path is broken, which is worth knowing.

**A trace id derived from the work order identity, not a stored one.** Spans
for one work order are emitted by processes that share no call stack: a runner
posting events over HTTP, the git watcher on a reconciler tick, the watchdog
in a third place. There is no live context for OTEL's normal propagation to
carry. `traceIdForWorkOrder()` hashes the identity to 128 bits, so any
component that knows _which_ work order it is talking about can join the trace
with no lookup and no coordination. The cost is that a work order's trace id
changes if its identity ever changes — which is acceptable because the
identity is content-addressed and stable by construction (VISION §3.2).

**If Grafana is ever wanted, it can be added without a migration.** The API
speaks OTLP to a collector, not to Uptrace. Pointing the collector at a second
exporter is a configuration change. That option staying open is what makes it
reasonable to commit to one backend now rather than hedging with two.
