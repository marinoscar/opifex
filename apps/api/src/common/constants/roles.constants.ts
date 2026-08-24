// =============================================================================
// Role Constants
// =============================================================================

export const ROLES = {
  ADMIN: 'admin',
  CONTRIBUTOR: 'contributor',
  VIEWER: 'viewer',
} as const;

export type RoleName = (typeof ROLES)[keyof typeof ROLES];

// =============================================================================
// Permission Constants
// =============================================================================

export const PERMISSIONS = {
  // System settings
  SYSTEM_SETTINGS_READ: 'system_settings:read',
  SYSTEM_SETTINGS_WRITE: 'system_settings:write',

  // User settings
  USER_SETTINGS_READ: 'user_settings:read',
  USER_SETTINGS_WRITE: 'user_settings:write',

  // Users
  USERS_READ: 'users:read',
  USERS_WRITE: 'users:write',

  // RBAC
  RBAC_MANAGE: 'rbac:manage',

  // Allowlist
  ALLOWLIST_READ: 'allowlist:read',
  ALLOWLIST_WRITE: 'allowlist:write',

  // Storage
  STORAGE_READ: 'storage:read',
  STORAGE_WRITE: 'storage:write',
  STORAGE_DELETE_ANY: 'storage:delete_any',

  // ---------------------------------------------------------------------
  // Opifex domain (epic #15)
  // ---------------------------------------------------------------------
  //
  // Deliberately small. VISION §11 is explicit that Opifex is single-operator
  // by design and that multi-user "is not a deferred feature - it is a
  // different product", so this set covers the read/act split an operator
  // actually needs and stops there. A sprawling role matrix here would be
  // building for a product this one is not.
  //
  // These strings are a CONTRACT WITH THE FRONTEND, not an internal detail.
  // `apps/web/src/config/destinations.ts` gates each cockpit destination on
  // the exact string its controller enforces, verified against the controller
  // rather than assumed - which is why the planned destinations currently
  // carry no permission at all. A destination flips from `planned` to `live`
  // in the SAME pull request as the endpoint it gates, never this one: adding
  // a string here does not make an endpoint enforce it.

  // Projects and repositories - which repositories Opifex watches, and the
  // per-repository policy (#43).
  PROJECTS_READ: 'projects:read',
  PROJECTS_WRITE: 'projects:write',

  // Runs. `runs:cancel` is separate from `projects:write` because killing a
  // live run is an operational act with an immediate effect on a repository,
  // while registering one is configuration.
  RUNS_READ: 'runs:read',
  RUNS_CANCEL: 'runs:cancel',
  /**
   * Report run events.
   *
   * Held by RUNNERS, not by people — a runner authenticates with a PAT minted
   * by the operator and posts its own progress. Separate from `runs:cancel`
   * because reporting what happened and deciding to stop a run are different
   * authorities: a compromised runner credential should not be able to kill
   * the other runs in the queue.
   */
  RUNS_WRITE: 'runs:write',

  // Work orders. `workorders:write` covers the queue controls - hold, release,
  // clear quarantine.
  WORKORDERS_READ: 'workorders:read',
  WORKORDERS_WRITE: 'workorders:write',

  // Runners: registering an implementation of the VISION §6 seam and its
  // capability manifest. Admin-only; a runner registration decides what the
  // control plane will hand real repositories to.
  RUNNERS_MANAGE: 'runners:manage',

  // Escalations. Acknowledging is separate from reading because an
  // acknowledgement is a claim that a human has seen it - the one fact the
  // escalation lifecycle exists to record.
  ESCALATIONS_READ: 'escalations:read',
  ESCALATIONS_ACKNOWLEDGE: 'escalations:acknowledge',

  /**
   * The supervisor decision log (VISION §7, #90).
   *
   * `supervisor:review` records whether a proposal WOULD have been approved.
   * That verdict is the entire Phase 6 measurement, and it decides which
   * action classes are eligible for promotion later — so it is a separate
   * authority from reading the log, for the same reason acknowledging an
   * escalation is separate from seeing one. There is deliberately no
   * `supervisor:execute`: the supervisor executes nothing, and a permission
   * naming an authority that does not exist is an invitation to implement it.
   */
  SUPERVISOR_READ: 'supervisor:read',
  SUPERVISOR_REVIEW: 'supervisor:review',
} as const;

export type PermissionName = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

// =============================================================================
// Default Role
// =============================================================================

export const DEFAULT_ROLE = ROLES.VIEWER;
