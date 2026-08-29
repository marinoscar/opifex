#!/usr/bin/env node
/**
 * Prisma Environment Helper
 *
 * Constructs DATABASE_URL from individual PostgreSQL environment variables
 * and executes Prisma CLI commands with the proper environment.
 *
 * This is needed because Prisma CLI requires DATABASE_URL to be set,
 * but we use individual variables (POSTGRES_HOST, POSTGRES_PORT, etc.)
 * for flexibility in different environments.
 *
 * Usage:
 *   node scripts/prisma-env.js [prisma command and args]
 *
 * Examples:
 *   node scripts/prisma-env.js migrate deploy
 *   node scripts/prisma-env.js generate
 *   node scripts/prisma-env.js studio
 */

const { spawn } = require('child_process');

// Load .env files - try multiple locations
if (process.env.NODE_ENV !== 'production') {
  try {
    const dotenv = require('dotenv');
    const { resolveComposeEnvPath } = require('./lib/resolve-compose-env');

    // Try local .env first (apps/api/.env)
    dotenv.config();

    // Also load from infra/compose/.env (canonical env location). Resolved
    // via resolveComposeEnvPath so it is found from a git worktree too, not
    // just the main checkout — see lib/resolve-compose-env.js (fixes #322).
    // Never proceed silently: log exactly which file was loaded, or say
    // loudly that none was found.
    const resolved = resolveComposeEnvPath(__dirname);

    if (resolved.path) {
      dotenv.config({ path: resolved.path });
      const how =
        resolved.source === 'relative-to-script'
          ? 'relative to this script'
          : 'via the git common directory (worktree-aware)';
      console.error(
        `[prisma-env] Loaded environment from ${resolved.path} (${how}).`,
      );
    } else if (resolved.gitError) {
      console.error(
        `[prisma-env] WARNING: no infra/compose/.env found at ${resolved.fixedOffsetPath}, ` +
          'and could not check the git common directory as a fallback ' +
          `(${resolved.gitError.message.split('\n')[0]}). git may not be on ` +
          'PATH, or this is not a git checkout (e.g. inside a container). ' +
          'Proceeding with only the ambient environment and apps/api/.env, ' +
          'if any — DATABASE_URL will likely fall back to defaults.',
      );
    } else {
      console.error(
        `[prisma-env] WARNING: no infra/compose/.env found (checked ${resolved.fixedOffsetPath} ` +
          'and the git common directory). Proceeding with only the ambient ' +
          'environment and apps/api/.env, if any — DATABASE_URL will likely ' +
          'fall back to defaults.',
      );
    }
  } catch {
    // dotenv might not be available in production builds, that's OK
  }
}

/**
 * Constructs PostgreSQL connection URL from individual environment variables
 */
function constructDatabaseUrl() {
  const host = process.env.POSTGRES_HOST || 'localhost';
  const port = process.env.POSTGRES_PORT || '5432';
  const user = process.env.POSTGRES_USER || 'postgres';
  // DELIBERATELY EXEMPT from #299's production requirement.
  //
  // The rule that a production deployment may not fall back to `postgres`
  // lives in one place, `src/config/env.validation.ts`, and it gates the API
  // process. This is a CLI wrapper: it serves no traffic, and a wrong password
  // here surfaces immediately as a Prisma authentication error rather than as
  // a running service on a credential nobody chose — which is the failure mode
  // that made #299 hardening rather than a vulnerability in the first place.
  // Restating the rule in CommonJS would create exactly the second place to
  // disagree that env.validation.ts warns against.
  const password = process.env.POSTGRES_PASSWORD || 'postgres';
  const dbName = process.env.POSTGRES_DB || 'appdb';
  const ssl = process.env.POSTGRES_SSL === 'true';

  // Construct URL-safe password (encode special characters)
  const encodedPassword = encodeURIComponent(password);

  // Build SSL parameter
  const sslParam = ssl ? '?sslmode=require' : '';

  return `postgresql://${user}:${encodedPassword}@${host}:${port}/${dbName}${sslParam}`;
}

/**
 * Main execution
 */
function main() {
  // Get Prisma command from arguments (skip node and script name)
  const prismaArgs = process.argv.slice(2);

  if (prismaArgs.length === 0) {
    console.error('Error: No Prisma command specified');
    console.error(
      'Usage: node scripts/prisma-env.js [prisma command and args]',
    );
    console.error('Example: node scripts/prisma-env.js migrate deploy');
    process.exit(1);
  }

  // Construct DATABASE_URL
  const databaseUrl = constructDatabaseUrl();

  // Set up environment for Prisma CLI
  const env = {
    ...process.env,
    DATABASE_URL: databaseUrl,
  };

  // Execute Prisma CLI with constructed environment
  const prismaProcess = spawn('npx', ['prisma', ...prismaArgs], {
    env,
    stdio: 'inherit',
    shell: true,
  });

  prismaProcess.on('exit', (code) => {
    process.exit(code || 0);
  });

  prismaProcess.on('error', (err) => {
    console.error('Failed to execute Prisma command:', err);
    process.exit(1);
  });
}

main();
