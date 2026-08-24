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
