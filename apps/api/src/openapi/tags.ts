// =============================================================================
// OpenAPI tag taxonomy (issue #53)
// =============================================================================
//
// The single declaration of every `@ApiTags(...)` name used in this API, its
// human description, and which sidebar section it belongs to.
//
// The tag NAMES here were already consistent across the ten controllers, so
// unlike the rest of this pass nothing was renamed. What was missing is what
// this file adds: a description for each (an undescribed tag renders as a bare
// heading) and a grouping (an ungrouped tag renders outside every section).
//
// One rule this file exists to enforce: NO undeclared and NO orphaned tags. A
// tag used by a controller but not listed here would render with no description
// and land outside every group; a tag listed here but used by nobody would
// render an empty section. Both are failed assertions in
// `test/openapi/openapi-document.spec.ts` rather than something a reviewer has
// to notice.
//
// Ordering is deliberate: `TAG_GROUPS` is emitted as `x-tagGroups`, and the
// flattened tag order becomes the document's `tags` array, which is what a
// renderer falls back to when it has no group support.
// =============================================================================

export interface OpenApiTag {
  /** Must match the controller's `@ApiTags(...)` argument byte-for-byte. */
  name: string;
  /** One or two sentences. Rendered under the section heading in the sidebar. */
  description: string;
}

export interface OpenApiTagGroup {
  name: string;
  tags: OpenApiTag[];
}

/**
 * Sidebar sections, in render order.
 *
 * A group is a product area rather than a module boundary — `Allowlist` sits
 * with authentication because it gates sign-in, even though it is administered
 * from the same screen as `Users`.
 */
export const TAG_GROUPS: OpenApiTagGroup[] = [
  {
    name: 'Authentication & Access',
    tags: [
      {
        name: 'Authentication',
        description:
          'Google OAuth sign-in, access-token refresh, logout, and the current-user lookup. ' +
          'Start here: every other section assumes a bearer token obtained through one of these routes.',
      },
      {
        name: 'Device Authorization',
        description:
          'RFC 8628 device authorization grant — how a CLI or other browserless client obtains a ' +
          'token by showing the user a code to approve elsewhere, plus management of the resulting ' +
          'device sessions.',
      },
      {
        name: 'Personal Access Tokens',
        description:
          'Long-lived `pat_` bearer credentials for scripts and automation. A PAT carries the full ' +
          'permission set of the user that minted it and is accepted on every authenticated route.',
      },
      {
        name: 'Allowlist',
        description:
          'Pre-authorized email addresses. Access is allowlist-gated: an email absent from this list ' +
          'cannot complete OAuth sign-in at all. Admin only.',
      },
      {
        name: 'Test Authentication',
        description:
          'Token minting for automated tests. The module is registered only when ' +
          '`NODE_ENV !== "production"`, so these routes are absent from a production document entirely.',
      },
    ],
  },
  {
    name: 'Account & Settings',
    tags: [
      {
        name: 'Users',
        description:
          'User administration: listing, inspecting, activating and deactivating accounts, and ' +
          'assigning system roles. Admin only.',
      },
      {
        name: 'User Settings',
        description:
          "The calling user's own preferences, stored as a JSON document. Supports full replacement " +
          '(`PUT`) and JSON Merge Patch (`PATCH`).',
      },
      {
        name: 'System Settings',
        description:
          'Deployment-wide configuration, stored as a JSON document. Readable by any signed-in user; ' +
          'writable only with `system_settings:write`.',
      },
    ],
  },
  {
    name: 'Storage',
    tags: [
      {
        name: 'Storage',
        description:
          'File objects: simple upload, resumable multipart upload, signed download URLs, metadata, ' +
          'and deletion. A caller sees only the objects they uploaded.',
      },
    ],
  },
  {
    name: 'The Factory',
    tags: [
      {
        name: 'Reconciler',
        description:
          'The reconciliation log: what each tick observed, what it computed should be true, and ' +
          'what it would have done. During the observation week nothing is executed, so this is ' +
          'the record used to validate the control loop before it is allowed to act.',
      },
      {
        name: 'Escalations',
        description:
          'What needs a human, with the lifecycle that distinguishes raised from delivered from ' +
          'acknowledged. VISION §9 makes escalation an action rather than telemetry: a stalled ' +
          'run nobody is told about is the exact failure this system exists to eliminate.',
      },
      {
        name: 'Notifications',
        description:
          'The devices an escalation can reach, and the receipts they send back. Web Push gives ' +
          'no delivery guarantee — a push service accepting a message is not a phone showing it ' +
          '— so a device confirms receipt and an unconfirmed notification is recorded as a ' +
          'failure rather than left looking handled.',
      },
      {
        name: 'Run Events',
        description:
          'Where runners report what they are doing, validated against the six normalized event ' +
          'types in schemas/run-event.schema.json. Idempotent on the sender-chosen event id, so a ' +
          'retried delivery is recognised rather than duplicated.',
      },
      {
        name: 'Cockpit',
        description:
          'The read models the operator dashboard is built on (#80). These answer operational ' +
          'questions — what is queued and why it is not running yet — rather than returning ' +
          'rows for the browser to interpret: the verdict about why a work order is waiting is ' +
          "the control plane's, and a UI that recomputed it would be a second implementation of " +
          'dispatch policy, out of date by one poll interval.',
      },
      {
        name: 'Quota',
        description:
          'The agent subscription’s rate-limit windows, and Opifex’s own consumption through ' +
          'them (#231). Separate from Cockpit because it is a fact about the SUBSCRIPTION rather ' +
          'than about a run: a window outlives every run that observed it. No burn fraction is ' +
          'reported and `burnFraction` is permanently null — VISION §10’s metric 6 needs a ' +
          'window capacity, no vendor publishes one, and the consumption that would be its ' +
          'numerator is only Opifex’s share of a subscription VISION §11 shares with the ' +
          'operator’s own interactive use. What is reported is first-hand: the vendor’s reset ' +
          'instant and the vendor’s own ordinal pressure reading.',
      },
      {
        name: 'Supervisor',
        description:
          'The AI supervisor decision log (VISION §7), observe-only. Proposals the supervisor ' +
          'WOULD have executed, the exact snapshot each was derived from, and whether a human ' +
          'would have approved it. There is no endpoint that applies a proposal and there is not ' +
          'meant to be: rung 1 of the promotion ladder is "writes proposals and executes ' +
          'nothing", and an apply endpoint would promote every action class at once, bypassing ' +
          'the measurement the ladder is built on. Proposals the supervisor DECLINED to make are ' +
          'rows too — a class nothing proposes must not look like a class that proposes well.',
      },
      {
        name: 'Approvals',
        description:
          'The one-tap approval surface (VISION §8). Approvals must be CHEAP or trust becomes ' +
          'meaningless: operators grant blanket trust out of friction rather than conviction, ' +
          'and a decision that arrives as a 2am email read at 9am gets blanket-approved within ' +
          'a week — chosen while annoyed rather than while thinking. So each request carries ' +
          'the four things needed to decide from a phone: what, why, blast radius, and what ' +
          'happens if ignored. The last is derived from the RECORDED timeout policy, never ' +
          'recomputed, so the sweeper keeps exactly the promise the notification made. ' +
          'Deciding is authenticated with an ordinary session; the notification deep-links here ' +
          'and carries no authority of its own, because a notification is delivered to a device ' +
          'and not to a person. Never-trustable actions (ADR-0013) never reach this queue, and ' +
          'not because anything filters them out: they are refused before an approval row is ' +
          'ever written, so a rule enforced by the absence of a row survives a refactor where ' +
          'one enforced by a `where` clause would not.',
      },
      {
        name: 'Trust',
        description:
          'Standing permission for one action class in one repository (VISION §8). What makes ' +
          'a grant safe is not that it CAN be scoped and capped but that it always is: every ' +
          'grant carries a scope, an expiry, a budget ceiling and auto-revoke thresholds, ' +
          'attached automatically, and NONE OF THE FOUR IS ACCEPTED FROM THE CALLER. Creating ' +
          'one takes an action class, a repository and an optional note; sending an expiry or ' +
          'a ceiling is a 400 naming the field, not a silently ignored key. That refusal is ' +
          'the mechanism rather than an inconvenience — a caller able to set the expiry could ' +
          'set it to ten years, and the guardrail would still appear on every screen while ' +
          'revoking nothing, which is worse than having no expiry at all. Expiry is the ' +
          'mechanism and not a reminder: an expired grant stops authorizing on the timestamp ' +
          'with no grace period, so doing nothing revokes. Renewal is the other half of that ' +
          'bargain — one tap that ends a grant and issues a successor whose terms are taken ' +
          "fresh from the defaults and narrowed by the old grant's own, never widened, " +
          'because a chain of renewals copying its terms forward would launder a one-time ' +
          'generous decision into a permanent one. A lapsed grant cannot be renewed at all: ' +
          'that is a new decision, with a name on it. There is no PATCH for the same reason ' +
          'renewal is a new row pointing back at the old one — the original keeps saying what ' +
          'it originally said. Revocation is immediate, permanent and separately ' +
          'permissioned, because taking authority back must never be gated on the permission ' +
          'that hands it out. Revoked, expired and suspended grants stay readable forever: ' +
          'what was trusted, what it cost and why it stopped being trusted is the evidence ' +
          'the promotion ladder and the daily digest are made of.',
      },
      {
        name: 'Promotion',
        description:
          'The earned-autonomy ladder (VISION §7): observe, measure, promote, demote. THERE IS ' +
          'NO PROMOTE ENDPOINT, and that is the design rather than an omission — VISION §7 ' +
          'promotes classes with a "demonstrated record" and demotes them "automatically on ' +
          'regression, not a judgment call", so a hand-promotion would be exactly the ' +
          'judgement call the ladder exists to remove, taken at the moment somebody is most ' +
          'impatient with the approval queue and applied to precisely the classes the evidence ' +
          'was not ready for. It would also corrupt the measurement: the frozen evidence ' +
          'behind such a rung would describe a decision that was never made on evidence. ' +
          'Demotion by hand IS offered, because narrowing authority is always safe and an ' +
          'operator sees regressions an approval count cannot. Every response carries whether ' +
          'the ladder is switched on at all (it defaults off), since rungs shown without that ' +
          'flag read as live conclusions when nothing has moved or will. Each class reports ' +
          "what would be needed to promote it as the policy layer's own sentence, never a " +
          'number recomputed from a second copy of the thresholds.',
      },
      {
        name: 'Repositories',
        description:
          'Which repositories Opifex watches, and the policy for each: whether the reconciler ' +
          'observes it, whether work orders may be dispatched against it, and its budget and path ' +
          'ceilings. Observation and dispatch are separate switches on purpose, so dispatch can be ' +
          'enabled one repository at a time.',
      },
    ],
  },
  {
    name: 'Operations',
    tags: [
      {
        name: 'Health',
        description:
          'Liveness and readiness probes for orchestrators and load balancers. Public — a probe that ' +
          'needed a token could not report that authentication is down.',
      },
    ],
  },
];

/** Flattened, in group order. Emitted as the document's `tags` array. */
export const OPENAPI_TAGS: OpenApiTag[] = TAG_GROUPS.flatMap(
  (group) => group.tags,
);

/** Emitted as `x-tagGroups`, the extension Scalar and Redoc read. */
export const OPENAPI_TAG_GROUPS = TAG_GROUPS.map((group) => ({
  name: group.name,
  tags: group.tags.map((tag) => tag.name),
}));
