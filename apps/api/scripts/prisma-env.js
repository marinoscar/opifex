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
    const path = require('path');
    const dotenv = require('dotenv');

    // Try local .env first (apps/api/.env)
    dotenv.config();

    // Also load from infra/compose/.env (canonical env location)
    const composeEnv = path.resolve(__dirname, '..', '..', '..', 'infra', 'compose', '.env');
    dotenv.config({ path: composeEnv });
  } catch (err) {
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
    console.error('Usage: node scripts/prisma-env.js [prisma command and args]');
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
