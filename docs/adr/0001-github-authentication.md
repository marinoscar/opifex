# 1. Authenticate to GitHub with a fine-grained personal access token

- Status: Accepted
- Date: 2026-08-21
- Issue: #40
- Epic: #15

## Context

Opifex is a control plane for work described in GitHub and must authenticate
to read issues and labels and, later, to write mirror labels and provenance
comments. Two credentials are available.

**A GitHub App** installs per account or organisation, gets its own 5000
requests/hour per installation independent of any human's budget, scopes
permissions per repository, and mints short-lived installation tokens from a
private key. It costs an app registration, a JWT-signing step, an installation
flow, and token refresh.

**A fine-grained personal access token** is a string in an environment
variable. It carries per-repository permissions, expires on a date the operator
chooses, and shares one 5000/hour budget with everything else the operator's
account does through the API.

VISION §11 is unambiguous about the shape of this product: Opifex is
single-operator by design, and multi-user "is not a deferred feature — it is a
different product." It also notes, in the same section, that automated runs
compete with interactive use for the same rate limits.

## Decision

Use a **fine-grained personal access token**, supplied as `GITHUB_TOKEN`, with
repository-scoped permissions.

The credential is read in exactly one place — `github.token` in
`src/config/configuration.ts` — and consumed in exactly one place,
`GitHubHttpService`. No other module sees it.

## Consequences

**What this costs.** The automated budget is the operator's own budget. A
reconciler sweeping every watched repository can leave its own operator unable
to browse GitHub from a shell. That is why `RateLimitService.canSpend()` takes
a reserve and `GITHUB_RATE_LIMIT_RESERVE` defaults to 100: the reconciler stops
scheduling with budget still in hand. This mitigation exists _because_ of this
decision and would be unnecessary under an App.

A PAT also expires on a fixed date and dies silently when it does — every
request starts returning 401. `GitHubAuthError` is a distinct class partly so
that failure is diagnosable at a glance rather than looking like a permissions
bug.

**What this buys.** No app registration, no JWT signing, no installation
callback, no token-refresh path, and no second thing to rotate. For one
operator watching a handful of repositories, the App's machinery is real work
that buys separation Opifex has nobody to separate from.

**How we change our minds.** The client takes a bearer token and does not care
where it came from. Moving to a GitHub App means introducing a credential
provider that mints and refreshes installation tokens and injecting it in
place of the static string — a change to how `GitHubHttpService` obtains
`this.token`, and to nothing else. The signal to do it is quota pressure that
the reserve can no longer absorb, or a second operator, and the second of
those is a different product.

## Alternatives rejected

**A classic (non-fine-grained) PAT.** Its scopes are account-wide: `repo`
grants access to every repository the operator can reach, including ones
Opifex was never meant to touch. The fine-grained variant costs nothing extra
and limits the blast radius of a leaked token to the repositories actually
listed.

**GitHub App now, to avoid migrating later.** The migration is a credential
provider, not a rewrite — it is cheap precisely because the seam is a bearer
token. Paying for it before there is quota pressure is building for the
multi-user product VISION §11 says this is not.
