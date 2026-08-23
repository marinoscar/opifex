# 2. Call GitHub with the platform `fetch`, not an SDK

- Status: Accepted
- Date: 2026-08-21
- Issue: #40
- Epic: #15

## Context

`apps/api` had no HTTP client dependency of any kind. Adding GitHub access
meant either adopting Octokit — the official SDK, with typed endpoints, a
pagination iterator, and retry and throttling plugins — or writing a request
pipeline on Node 24's built-in `fetch`.

The requirements #40 states are unusually specific about behaviour at the
transport layer:

- rate-limit remaining must be **queryable state**, not something discovered by
  receiving a 403;
- conditional requests must be used on every pollable resource, and **a 304
  must cost no quota**;
- transient failures are retried with backoff, and **rate-limit exhaustion is
  surfaced, not retried into**.

## Decision

Use the platform `fetch` and own the pipeline: `GitHubHttpService`, with
`RateLimitService` and `EtagCacheService` beside it.

## Consequences

**Why the SDK's defaults are the problem, not the solution.** Octokit's
throttling plugin, the part that would otherwise do this work, responds to a
rate-limit response by _sleeping until the reset_. That is the one behaviour a
reconciler must not have: VISION §4 makes the tick loop the thing that observes
everything, so a tick blocked on a one-hour reset has stopped observing every
other repository too. The correct response is to surface the exhaustion with
its `resetAt` and let the scheduler route around it — which means disabling
the plugin and reimplementing the accounting anyway.

Similarly, ETag handling would be ours regardless: Octokit surfaces the header
but does not store bodies, and a 304 has no body. Something has to remember
what the response was unchanged _from_.

**What we give up.** Typed endpoint definitions (`octokit.rest.issues.list`)
and its pagination iterator. Types are recovered where they matter by the
normalized DTOs in #41, which every consumer reads instead of GitHub's response
shape — so the raw payload is typed `unknown` in exactly one file and narrowed
once. Pagination is a `Link`-header parser: about fifteen lines, and it has to
handle GitHub's cursor-paginated endpoints (issue timelines among them) which
have no page numbers at all.

**What we take on.** Auth headers, the API-version header, error
classification, backoff and pagination are now ours to maintain, and GitHub
API changes land on us rather than in a dependency upgrade. This is bounded:
the surface is a handful of REST endpoints, and it is fully covered by tests
against a mocked `fetch` — which is also considerably easier to write against
than a mocked SDK.

**Zero new dependencies**, in a workspace that had none for this.

## Alternatives rejected

**Octokit with the throttling plugin disabled.** This is the honest comparison,
and it is close. It keeps typed endpoints and pagination while we supply the
rate-limit and ETag behaviour ourselves — but it also pulls in a dependency
whose main value proposition we have just switched off, and leaves the retry
policy split between the plugin's rules and ours. One place that decides what
is retried is worth more here than typed endpoint names.

**`@octokit/request` alone**, the low-level piece without the plugins. Nearly
what we wrote, minus control over the timeout and error taxonomy, plus a
dependency.
