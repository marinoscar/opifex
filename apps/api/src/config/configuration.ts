export default () => {
  // Construct DATABASE_URL from individual PostgreSQL variables
  const host = process.env.POSTGRES_HOST || 'localhost';
  const port = process.env.POSTGRES_PORT || '5432';
  const user = process.env.POSTGRES_USER || 'postgres';
  const password = process.env.POSTGRES_PASSWORD || 'postgres';
  const dbName = process.env.POSTGRES_DB || 'appdb';
  const ssl = process.env.POSTGRES_SSL === 'true';
  const sslParam = ssl ? '?sslmode=require' : '';

  const databaseUrl = `postgresql://${user}:${password}@${host}:${port}/${dbName}${sslParam}`;

  // Set DATABASE_URL for Prisma
  process.env.DATABASE_URL = databaseUrl;

  return {
    // Application
    nodeEnv: process.env.NODE_ENV || 'development',
    port: parseInt(process.env.PORT || '3000', 10),
    appUrl: process.env.APP_URL || 'http://localhost:3535',

    // Database
    database: {
      host,
      port: parseInt(port, 10),
      user,
      password,
      name: dbName,
      ssl,
      url: databaseUrl,
    },

    // JWT
    jwt: {
      secret: process.env.JWT_SECRET,
      accessTtlMinutes: parseInt(
        process.env.JWT_ACCESS_TTL_MINUTES || '15',
        10,
      ),
      refreshTtlDays: parseInt(process.env.JWT_REFRESH_TTL_DAYS || '14', 10),
    },

    // OAuth - Google
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackUrl: process.env.GOOGLE_CALLBACK_URL,
    },

    // Admin bootstrap
    initialAdminEmail: process.env.INITIAL_ADMIN_EMAIL,

    // Device Authorization Flow (RFC 8628)
    deviceAuth: {
      expiryMinutes: parseInt(
        process.env.DEVICE_CODE_EXPIRY_MINUTES || '15',
        10,
      ),
      pollInterval: parseInt(process.env.DEVICE_CODE_POLL_INTERVAL || '5', 10),
      tokenExpiryDays: parseInt(
        process.env.DEVICE_TOKEN_EXPIRY_DAYS || '7',
        10,
      ),
    },

    // Observability
    otel: {
      enabled: process.env.OTEL_ENABLED === 'true',
      endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
      serviceName: process.env.OTEL_SERVICE_NAME || 'opifex-api',
    },

    // Storage Configuration
    storage: {
      provider: process.env.STORAGE_PROVIDER || 's3',
      s3: {
        bucket: process.env.S3_BUCKET || '',
        region: process.env.S3_REGION || 'us-east-1',
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
        endpoint: process.env.S3_ENDPOINT || undefined,
      },
      maxFileSize: parseInt(process.env.MAX_FILE_SIZE || '10737418240', 10), // 10GB default
      allowedMimeTypes: (
        process.env.ALLOWED_MIME_TYPES || 'image/*,application/pdf,video/*'
      ).split(','),
      signedUrlExpiry: parseInt(process.env.SIGNED_URL_EXPIRY || '3600', 10), // 1 hour default
      partSize: parseInt(process.env.STORAGE_PART_SIZE || '10485760', 10), // 10MB default
    },

    // GitHub (epic #15)
    //
    // A fine-grained personal access token, not a GitHub App - see
    // docs/adr/0001-github-authentication.md. No default and no throw when it
    // is absent: the API must boot without GitHub configured so the inherited
    // foundation stays usable, and repository registration is where a missing
    // token becomes a visible, actionable error.
    github: {
      token: process.env.GITHUB_TOKEN,
      apiBaseUrl: process.env.GITHUB_API_BASE_URL || 'https://api.github.com',
      // GitHub requires a User-Agent and rejects requests without one.
      userAgent: process.env.GITHUB_USER_AGENT || 'opifex',
      requestTimeoutMs: parseInt(
        process.env.GITHUB_REQUEST_TIMEOUT_MS || '15000',
        10,
      ),
      // Transient failures only (5xx, timeouts). Rate-limit exhaustion is never
      // retried into.
      maxRetries: parseInt(process.env.GITHUB_MAX_RETRIES || '3', 10),
      // Requests held back from the reconciler so interactive use keeps working
      // - VISION §11 notes automated runs compete with a human for one budget.
      rateLimitReserve: parseInt(
        process.env.GITHUB_RATE_LIMIT_RESERVE || '100',
        10,
      ),
      // Bounds the in-memory conditional-request cache. Roughly: watched
      // repositories x pollable resources x pages.
      etagCacheMaxEntries: parseInt(
        process.env.GITHUB_ETAG_CACHE_MAX || '2000',
        10,
      ),
      // The global write kill switch. DEFAULTS OFF, and the default is the
      // point: VISION §12 requires the reconciler to observe for a week and
      // record what it WOULD have done before it is allowed to do it. Note the
      // comparison is against 'true' rather than !== 'false', so an unset,
      // misspelled or empty value all mean off.
      writesEnabled: process.env.GITHUB_WRITES_ENABLED === 'true',
    },

    // Reconciler (epic #16)
    //
    // DEFAULTS OFF. The tick reads GitHub on a schedule, so a deployment that
    // has not been pointed at any repository yet, and every test that boots
    // AppModule, would otherwise start polling. As with GITHUB_WRITES_ENABLED,
    // the comparison is against 'true' so unset, misspelled and empty all mean
    // off.
    reconciler: {
      enabled: process.env.RECONCILER_ENABLED === 'true',
      // VISION §13: start with polling, add webhooks only when tick latency
      // demonstrably hurts. One minute is frequent enough that a human editing
      // a label sees an effect promptly, and with ETags an unchanged repository
      // costs no rate-limit budget at all.
      intervalMs: parseInt(process.env.RECONCILER_INTERVAL_MS || '60000', 10),
      // How long tick records are kept. Deliberately longer than VISION §12's
      // one-week observation window, so the week is still fully reviewable on
      // the day it ends rather than half-pruned.
      logRetentionDays: parseInt(
        process.env.RECONCILER_LOG_RETENTION_DAYS || '14',
        10,
      ),
    },

    // The AI supervisor (epic #21, #89), observe-only.
    //
    // DEFAULTS OFF, and compared against 'true' so unset, misspelled and empty
    // all mean off — the same rule every other switch here follows. This one
    // matters for a specific reason: the supervisor consumes the same
    // subscription the workers do (VISION §7), so a deployment that has not
    // decided to run one must not start spending on it because a default said
    // yes.
    supervisor: {
      enabled: process.env.SUPERVISOR_ENABLED === 'true',

      // Whether a disabled supervisor still writes a `skipped_disabled` row
      // each hour. Off by default: the decision log must have no gaps while
      // the supervisor is meant to be running, but a deployment that never
      // configured one should not accumulate a skip row an hour forever.
      logSkippedInvocations:
        process.env.SUPERVISOR_LOG_SKIPPED_INVOCATIONS === 'true',

      // Stand down while any run is parked on a rate limit.
      //
      // DEFAULTS ON, and it is the one supervisor switch that does. VISION §7:
      // "a supervisor competing for the quota it is managing is a bad loop."
      // A parked worker is the clearest evidence available that the shared
      // budget is already exhausted, and respecting it costs nothing. Note the
      // comparison is !== 'false', because this default is ON.
      standDownWhenBlocked:
        process.env.SUPERVISOR_STAND_DOWN_WHEN_BLOCKED !== 'false',

      // Stand down when at least this many runs are live. Unset means no
      // ceiling: pressure is not exhaustion, and a gate that fires constantly
      // is a supervisor that never runs.
      liveRunCeiling: process.env.SUPERVISOR_LIVE_RUN_CEILING
        ? parseInt(process.env.SUPERVISOR_LIVE_RUN_CEILING, 10)
        : null,
    },

    // Dispatch (epic #18, #64)
    dispatch: {
      // A ceiling across the whole fleet, on top of each runner's own
      // maxConcurrency. VISION §11 designs for a single operator sharing one
      // GitHub budget and one machine with automated runs — a fleet limit is
      // how that operator caps total spend and load without editing every
      // runner's manifest. Null means no global ceiling.
      maxConcurrent: process.env.DISPATCH_MAX_CONCURRENT
        ? parseInt(process.env.DISPATCH_MAX_CONCURRENT, 10)
        : null,

      // Lets a preview-tier runner be load-bearing when no GA fallback exists.
      // See docs/adr/0007-preview-runner-acknowledgement.md.
      //
      // VISION §11 wants every preview runner backed by a GA one; VISION §3.7
      // forbids building a second runner before it is needed. With one runner
      // the fallback cannot exist, so without this the only runner is
      // permanently ineligible and every work order queues forever.
      //
      // DEFAULTS OFF and compared against 'true', like every other switch here:
      // a safety rule whose bypass defaults on is not a safety rule. Turn it
      // back off once a genuinely GA runner exists.
      allowPreviewRunner: process.env.DISPATCH_ALLOW_PREVIEW_RUNNER === 'true',

      // How many attempts a work order gets before it is quarantined (#66).
      //
      // Without a ceiling, abandon-and-re-run (VISION §3.4) has no stopping
      // condition: a work order that cannot succeed re-dispatches forever,
      // burning the quota that working runs need. Silent abandonment is the
      // only other option, and it is worse — nobody is told.
      //
      // Counted in WORK ORDER attempts, which is also success metric 4
      // ("attempts per work order", VISION §10), so the number here is
      // simultaneously a safety limit and a statement about how small a work
      // order is expected to be. Three is deliberately low: VISION §10 uses a
      // rising attempt count as evidence of bad decomposition, and a generous
      // ceiling hides exactly that signal.
      retryCeiling: process.env.DISPATCH_RETRY_CEILING
        ? parseInt(process.env.DISPATCH_RETRY_CEILING, 10)
        : 3,

      // The switch that lets the factory actually spend money.
      //
      // DEFAULTS OFF, and this is the one where the default matters most:
      // dispatching starts an agent against a real subscription, and VISION §3.5
      // gates on reversibility rather than importance — this action is not
      // reversible. With it off the executor still runs the whole decision and
      // records what it WOULD have dispatched, which is VISION §12's
      // observation-week posture applied to execution rather than to labels.
      enabled: process.env.DISPATCH_ENABLED === 'true',
    },

    // Runners (epic #18, #61)
    runners: {
      // How long past a run's own wall-clock ceiling before the CONTROL PLANE
      // cancels it (#180).
      //
      // A margin rather than zero, so this is a backstop and not a race: firing
      // at the same instant as the runner's own timer would land a cancel while
      // the runner is already killing its process, producing two conflicting
      // reasons for one stop. Two minutes is comfortably longer than
      // RUNNER_KILL_GRACE_MS plus a poll interval, so a runner shutting down
      // cleanly always finishes first.
      deadlineGraceMinutes: parseInt(
        process.env.RUNNER_DEADLINE_GRACE_MINUTES || '2',
        10,
      ),

      // The v1 runner: Claude Code, invoked as a child process on our own
      // hardware. See docs/adr/0008-claude-code-local-invocation.md for why a
      // subprocess rather than the Agent SDK.
      claudeCodeLocal: {
        // DEFAULTS OFF, like every other outward-acting subsystem here. This one
        // spends money and writes branches, so an install that has not been
        // deliberately pointed at a machine with the CLI on it must not start
        // spawning agents. Compared against 'true' so unset, misspelled and
        // empty all mean off.
        enabled: process.env.CLAUDE_CODE_LOCAL_ENABLED === 'true',
        // Resolved on PATH by default. Named explicitly so a deployment can pin
        // a version rather than inheriting whatever the shell finds.
        binary: process.env.CLAUDE_CODE_BINARY || 'claude',
        gitBinary: process.env.GIT_BINARY || 'git',
        // One directory per work-order identity lives under here.
        workspaceRoot:
          process.env.RUNNER_WORKSPACE_ROOT || '/var/tmp/opifex/workspaces',
        // Where the workspace clones from. Overridable for GitHub Enterprise
        // and, more usefully, for tests that point it at a local fixture.
        gitRemoteBaseUrl:
          process.env.GIT_REMOTE_BASE_URL || 'https://github.com',
        // The factory's own commit identity. Attribution proper lives in the
        // trailers (#26), which are structured and cannot be mistaken for a
        // person having written the code.
        committerName: process.env.RUNNER_COMMITTER_NAME || 'Opifex Factory',
        committerEmail:
          process.env.RUNNER_COMMITTER_EMAIL || 'factory@opifex.local',
        // VISION §11: automated runs compete with interactive use for one
        // subscription quota. Two is a ceiling that leaves a human room to work
        // on the same machine; raising it is a deliberate act.
        maxConcurrency: parseInt(
          process.env.CLAUDE_CODE_MAX_CONCURRENCY || '2',
          10,
        ),
        // How long a SIGTERMed run has to flush before SIGKILL.
        killGraceMs: parseInt(process.env.RUNNER_KILL_GRACE_MS || '10000', 10),
        // Defaults to the narrow end. A mode broad enough never to ask is
        // coupled to a sandbox that makes never asking safe, and sandboxing is
        // #113 — so until then a run that needs a permission it does not have
        // goes silent and is caught by the watchdog (#54), which is the failure
        // this system exists to notice. Widening it is a deliberate act.
        permissionMode:
          process.env.CLAUDE_CODE_PERMISSION_MODE || 'acceptEdits',
        // A wall-clock backstop for work orders that name no ceiling of their
        // own. VISION §1's origin story is four hours dead; an unbounded run
        // that wedges is exactly that shape. Unset means genuinely unbounded,
        // which is a deliberate choice rather than an oversight.
        defaultTimeoutMinutes: process.env.RUNNER_DEFAULT_TIMEOUT_MINUTES
          ? parseInt(process.env.RUNNER_DEFAULT_TIMEOUT_MINUTES, 10)
          : 60,
      },
    },

    // Notifications (epic #17, #58)
    //
    // The last link in the chain VISION §1 complains about: everything upstream
    // can work perfectly and detection latency is still measured in hours if
    // nobody is actually told.
    notifications: {
      // Web Push (RFC 8030 + VAPID). No third-party account and no per-vendor
      // credential - the key pair is generated once with `npx web-push
      // generate-vapid-keys` and lives in the environment like every other
      // secret. See docs/adr/0004-notification-transport.md.
      //
      // Absent keys DISABLE the transport rather than making it fail silently:
      // the dispatcher records `failed` with a reason naming the missing
      // configuration, so an unconfigured install is visible in the cockpit
      // instead of looking like a system nothing has ever needed to say.
      vapidPublicKey: process.env.VAPID_PUBLIC_KEY || '',
      vapidPrivateKey: process.env.VAPID_PRIVATE_KEY || '',
      // The `mailto:` a push service contacts if our requests misbehave. Part
      // of the VAPID spec, not optional decoration.
      vapidSubject: process.env.VAPID_SUBJECT || '',

      // How long a dispatched escalation may go without a device receipt
      // before it is treated as undelivered.
      //
      // Web Push gives no delivery guarantee: a 201 means the push service
      // ACCEPTED the message, not that a phone showed it. #58 is explicit that
      // an escalation which silently failed to send is indistinguishable from
      // no escalation, so the service worker posts a receipt back and this is
      // how long we wait for it.
      receiptTimeoutMs: parseInt(
        process.env.NOTIFY_RECEIPT_TIMEOUT_MS || '120000',
        10,
      ),

      // A SECOND, independent path, used only when Web Push could not deliver.
      //
      // #58: "a delivery failure must itself escalate through a different
      // path." A generic POST, so it works with ntfy, a chat webhook, or
      // anything that accepts JSON. Off unless set: it sends escalation text to
      // a third party, which is the operator's decision to make, not a default.
      fallbackWebhookUrl: process.env.NOTIFY_FALLBACK_WEBHOOK_URL || '',
    },

    logLevel: process.env.LOG_LEVEL || 'info',
  };
};
