/**
 * The `ConfigService` factory: everything set once and then forgotten.
 *
 * WHAT IS DELIBERATELY ABSENT (#340, epic #332)
 * ---------------------------------------------------------------------------
 * The GitHub, runner, dispatch, reconciler, supervisor, promotion and
 * notification-delivery settings USED to be manufactured here. They are now
 * declared in `settings/operator-settings/operator-settings.registry.ts` and
 * read through `OperatorSettingsService`, and they were REMOVED from here
 * rather than left in place beside it.
 *
 * That removal is the point of #340, not tidiness. While a key resolved
 * through both paths, a consumer nobody noticed still reading
 * `config.get('dispatch.enabled')` would be a setting that appears to work in
 * the Control Center and changes nothing — and ADR-0018 records that the
 * obvious bridge, `ConfigService.set()`, is disqualified: it writes the value
 * into `process.env` under the dotted path, which is both a credential leak
 * into every spawned agent and, for `set(path, undefined)`, the string
 * `'undefined'` where a null ceiling should be.
 *
 * `test/governing/managed-keys-off-config.spec.ts` enumerates the registry and
 * fails the build if a managed path reappears in a `config.get()` anywhere
 * outside that module, or if this file starts manufacturing one again.
 *
 * What stays here is what epic #332 puts out of scope: `POSTGRES_*`, `JWT_*`,
 * `GOOGLE_*`, AWS/S3, `OTEL_*`, ports and URLs, `LOG_LEVEL`, `DEVICE_*`,
 * `STORAGE_*` and the VAPID key pair. They are set once and forgotten, and the
 * database credential structurally cannot live in the database.
 */
export default () => {
  // Construct DATABASE_URL from individual PostgreSQL variables
  const host = process.env.POSTGRES_HOST || 'localhost';
  const port = process.env.POSTGRES_PORT || '5432';
  const user = process.env.POSTGRES_USER || 'postgres';
  // POSTGRES_PASSWORD's default SURVIVES, but only outside production (#299).
  //
  // `config/env.validation.ts` refuses the boot when NODE_ENV=production and
  // this variable is unset or still `postgres`, and that check runs when
  // `app.module.ts` is imported — before this factory is ever invoked. So the
  // literal below is reachable in development and test only, which is the
  // whole point: it keeps `docker compose up` and a fresh checkout working
  // without ever being able to ship.
  //
  // Left in place deliberately rather than deleted. Do not re-file it: read
  // env.validation.ts's "WHY POSTGRES_PASSWORD IS ONLY REQUIRED IN
  // PRODUCTION" note first, which is the argument for this shape.
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

      // NOTIFY_RECEIPT_TIMEOUT_MS and NOTIFY_FALLBACK_WEBHOOK_URL are managed
      // settings and are read through `OperatorSettingsService` (#340). The
      // VAPID key pair stays here: rotating it invalidates every existing
      // device subscription, which is a migration rather than a setting.
    },

    logLevel: process.env.LOG_LEVEL || 'info',
  };
};
