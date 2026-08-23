#!/usr/bin/env node
// =============================================================================
// Boot the compiled API and prove it serves traffic (issue #64)
// =============================================================================
//
// WHY THIS EXISTS
// -----------------------------------------------------------------------------
// Issue #60 was a total startup failure — `bootstrap()` threw and the process
// exited 1 — while every API test passed. That is structural, not a missing
// assertion: the integration suite builds the app through
// `Test.createTestingModule(...)`, which never runs `main.ts`. Everything
// between "modules instantiate" and "the server accepts a request" is therefore
// untested by the suite: OpenAPI document generation, Fastify plugin
// registration (`@fastify/cookie`, `@fastify/multipart`), `enableCors`, and
// `setGlobalPrefix('api')`.
//
// This script closes that gap the only way it can be closed — by starting the
// real compiled artifact (`node dist/main.js`) against a real database and
// making real HTTP requests to it.
//
// PREREQUISITES (the CI job performs these as separate steps, so that a
// migration or seed failure is attributed to itself rather than to the boot):
//
//   1. npm run build            --workspace=api
//   2. npm run prisma:migrate   --workspace=api   # migrate deploy
//   3. npm run prisma:seed      --workspace=api   # db seed
//
// The database connection comes from the same POSTGRES_* variables the app
// itself reads (see src/config/configuration.ts and scripts/prisma-env.js);
// this script does not construct DATABASE_URL, it just passes the environment
// through to the child so the child's own contract is what gets exercised.
//
// RUN IT LOCALLY
// -----------------------------------------------------------------------------
//   docker run -d --name smoke-pg -e POSTGRES_PASSWORD=postgres \
//     -e POSTGRES_DB=appdb -p 5432:5432 postgres:16-alpine
//   cd apps/api && npm run build && npm run prisma:migrate && npm run prisma:seed
//   node scripts/smoke-test.mjs
//
// Environment knobs: SMOKE_PORT (default 3001), SMOKE_STARTUP_TIMEOUT_MS
// (default 90000), SMOKE_SHUTDOWN_TIMEOUT_MS (default 15000).
//
// (The incomplete-dist trap this header used to warn about is fixed: the build
// config now sets `incremental: false`, so `deleteOutDir: true` and incremental
// emit no longer disagree. See tsconfig.build.json.)
// =============================================================================

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entrypoint = resolve(apiRoot, 'dist', 'main.js');

const PORT = process.env.SMOKE_PORT ?? '3001';
const BASE_URL = `http://127.0.0.1:${PORT}`;
const STARTUP_TIMEOUT_MS = Number(
  process.env.SMOKE_STARTUP_TIMEOUT_MS ?? 90_000,
);
const SHUTDOWN_TIMEOUT_MS = Number(
  process.env.SMOKE_SHUTDOWN_TIMEOUT_MS ?? 15_000,
);
const POLL_INTERVAL_MS = 500;

/** Everything the child wrote, replayed into the job log if anything fails. */
const childOutput = [];
/** Set as soon as the child exits, so a poll loop can stop waiting on a corpse. */
let childExit = null;

function log(message) {
  process.stdout.write(`[smoke] ${message}\n`);
}

function recordOutput(stream, chunk) {
  childOutput.push({ stream, text: chunk.toString() });
}

/**
 * Replays the child's stdout/stderr.
 *
 * A smoke test that fails without showing why costs more than it saves: the
 * failure it is designed to catch is a startup crash, and the stack trace for
 * that crash exists only in the child's stderr.
 */
function dumpChildOutput() {
  process.stderr.write(
    `\n${'='.repeat(78)}\nAPI process output (stdout + stderr)\n${'='.repeat(78)}\n`,
  );
  if (childOutput.length === 0) {
    process.stderr.write('(the process produced no output at all)\n');
  }
  for (const { text } of childOutput) {
    process.stderr.write(text);
  }
  process.stderr.write(`${'='.repeat(78)}\n`);
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

/** `fetch`, but a connection-refused is a result rather than a thrown error. */
async function tryFetch(path) {
  try {
    return await fetch(`${BASE_URL}${path}`, {
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return null;
  }
}

class SmokeFailure extends Error {}

function fail(message) {
  throw new SmokeFailure(message);
}

// -----------------------------------------------------------------------------
// Assertions
// -----------------------------------------------------------------------------

/**
 * Assertion 1 + 2: the process starts, stays up, and serves `/api/health/live`.
 *
 * Polling with a bounded timeout rather than a fixed sleep — a fixed sleep is
 * either too short (flaky on a loaded runner) or too long (wasted on every
 * green run). The loop also watches for child exit, so a crash fails in the
 * second it happens instead of burning the full timeout.
 */
async function waitForLiveness() {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  log(
    `waiting for ${BASE_URL}/api/health/live (timeout ${STARTUP_TIMEOUT_MS}ms)`,
  );

  while (Date.now() < deadline) {
    if (childExit) {
      fail(
        `the API exited during startup (code=${childExit.code}, signal=${childExit.signal}) ` +
          'before it ever served a request',
      );
    }

    const response = await tryFetch('/api/health/live');
    if (response) {
      if (response.status !== 200) {
        fail(`GET /api/health/live returned ${response.status}, expected 200`);
      }
      log(
        `GET /api/health/live -> 200 (after ${STARTUP_TIMEOUT_MS - (deadline - Date.now())}ms)`,
      );
      return;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  fail(
    `the API did not serve /api/health/live within ${STARTUP_TIMEOUT_MS}ms. ` +
      'It either never bound the port or is wedged during bootstrap.',
  );
}

/**
 * Assertion 3: `/api/health/ready` is 200.
 *
 * This is the one that proves the running app can reach the database.
 * `/api/health/live` cannot: it returns a literal, and `PrismaService.$connect()`
 * is lazy under the pg adapter, so the app boots and serves `/live` with a 200
 * even when Postgres is stopped — verified, not assumed. Readiness runs
 * `DatabaseHealthIndicator`, which issues a real `SELECT 1`, and 503s when it
 * cannot.
 *
 * Scope, precisely: this proves CONNECTIVITY, not schema. `SELECT 1` succeeds
 * against a database with no tables in it. What proves the migrations applied
 * is the `prisma migrate deploy` and `prisma db seed` steps that run before
 * this script — the seed writes real rows into roles, permissions,
 * system_settings and allowed_emails, so it fails loudly on a schema that does
 * not match. Do not read a green readiness check as a migration check.
 */
async function assertReadiness() {
  const response = await tryFetch('/api/health/ready');
  if (!response) {
    fail('GET /api/health/ready got no response (connection refused)');
  }

  const body = await response.text();
  if (response.status !== 200) {
    fail(
      `GET /api/health/ready returned ${response.status}, expected 200. ` +
        `This normally means the database is unreachable or unmigrated. Body: ${body}`,
    );
  }
  log('GET /api/health/ready -> 200 (the running app can reach the database)');
}

/**
 * Assertion 4: `/api/openapi.json` is 200 AND a parseable document with paths.
 *
 * WHY THE 503 BRANCH BELOW IS NOT REDUNDANT (issue #69)
 * ---------------------------------------------------------------------------
 * `registerDocsRoutesOrDegrade` in main.ts deliberately no longer crashes the
 * process when document generation throws: it logs at `error` and serves 503 on
 * `/api/docs` and `/api/openapi.json`, so a documentation defect cannot take
 * the whole API down. That is the right production behaviour — and it is
 * precisely what makes a naive smoke test vacuous here.
 *
 * Under #69, the exact defect this job exists to catch (#60: DTOs using
 * `z.date()`, which zod v4 cannot render as JSON Schema) leaves the app UP and
 * healthy. `/api/health/live` and `/api/health/ready` both return 200. A job
 * that only asked "did it boot?" would go green on the very regression it was
 * written for.
 *
 * So this assertion must be specifically about the document: 200 with a real
 * OpenAPI body, and an explicit, loud failure on 503. Do not relax this to
 * "any 2xx/5xx is fine as long as the route answers" — that deletes the point
 * of the job.
 */
async function assertOpenApiDocument() {
  const response = await tryFetch('/api/openapi.json');
  if (!response) {
    fail('GET /api/openapi.json got no response (connection refused)');
  }

  const body = await response.text();

  if (response.status === 503) {
    fail(
      'GET /api/openapi.json returned 503 — OpenAPI document generation FAILED at ' +
        'startup and main.ts degraded to the fallback routes (see the API output ' +
        'below for the generation error). The process is up, but the document is ' +
        `broken. This is exactly the #60 class of defect. Body: ${body}`,
    );
  }

  if (response.status !== 200) {
    fail(
      `GET /api/openapi.json returned ${response.status}, expected 200. Body: ${body}`,
    );
  }

  let document;
  try {
    document = JSON.parse(body);
  } catch (error) {
    fail(
      `GET /api/openapi.json returned 200 but the body is not valid JSON: ${error.message}`,
    );
  }

  if (typeof document.openapi !== 'string') {
    fail('the OpenAPI document has no `openapi` version string');
  }

  const paths = document.paths;
  if (!paths || typeof paths !== 'object' || Object.keys(paths).length === 0) {
    fail('the OpenAPI document has an empty or missing `paths` object');
  }

  // The prefix is applied by `setGlobalPrefix('api')` during bootstrap, which is
  // itself untested by the suite — so confirm it actually took effect rather
  // than trusting that a non-empty `paths` implies correct routing.
  const prefixed = Object.keys(paths).filter((path) =>
    path.startsWith('/api/'),
  );
  if (prefixed.length === 0) {
    fail(
      'no path in the OpenAPI document starts with `/api/` — setGlobalPrefix() ' +
        `did not take effect. First paths seen: ${Object.keys(paths).slice(0, 5).join(', ')}`,
    );
  }

  log(
    `GET /api/openapi.json -> 200 (OpenAPI ${document.openapi}, ` +
      `${Object.keys(paths).length} paths, ${prefixed.length} under /api/)`,
  );
}

// -----------------------------------------------------------------------------
// Process lifecycle
// -----------------------------------------------------------------------------

function startApi() {
  if (!existsSync(entrypoint)) {
    process.stderr.write(
      `[smoke] ${entrypoint} does not exist. Run \`npm run build --workspace=api\` first.\n`,
    );
    process.exit(1);
  }

  log(`starting ${entrypoint} on port ${PORT}`);

  const child = spawn(process.execPath, [entrypoint], {
    cwd: apiRoot,
    env: {
      ...process.env,
      PORT,
      // Nothing in this job talks to a collector, and a failing exporter adds
      // noise to the output we dump on failure.
      OTEL_ENABLED: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (chunk) => recordOutput('stdout', chunk));
  child.stderr.on('data', (chunk) => recordOutput('stderr', chunk));

  child.on('exit', (code, signal) => {
    childExit = { code, signal };
  });

  return child;
}

/**
 * Assertion 5: shut down cleanly and fail on a non-zero exit code.
 *
 * SIGTERM is the signal an orchestrator sends, so it is the one worth
 * exercising. A process that ignores it (and has to be SIGKILLed) is a real
 * defect in a containerised service, so that path fails rather than passes.
 */
async function shutdown(child) {
  if (childExit) {
    return;
  }

  log('sending SIGTERM');
  child.kill('SIGTERM');

  const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
  while (!childExit && Date.now() < deadline) {
    await sleep(100);
  }

  if (!childExit) {
    child.kill('SIGKILL');
    fail(
      `the API did not exit within ${SHUTDOWN_TIMEOUT_MS}ms of SIGTERM; had to SIGKILL it`,
    );
  }

  const { code, signal } = childExit;

  // Terminated by the signal we sent, or exited 0 in response to it: both are
  // clean. Anything else is a non-zero exit and fails the job.
  if (signal === 'SIGTERM' || code === 0 || code === null) {
    log(`clean shutdown (code=${code}, signal=${signal})`);
    return;
  }

  fail(
    `the API exited with a non-zero code on shutdown (code=${code}, signal=${signal})`,
  );
}

// -----------------------------------------------------------------------------

async function main() {
  const child = startApi();

  try {
    await waitForLiveness();
    await assertReadiness();
    await assertOpenApiDocument();
    await shutdown(child);
  } catch (error) {
    if (!childExit) {
      child.kill('SIGKILL');
    }
    dumpChildOutput();
    const message =
      error instanceof SmokeFailure
        ? error.message
        : (error.stack ?? String(error));
    process.stderr.write(`\n[smoke] FAILED: ${message}\n`);
    process.exit(1);
  }

  log('all checks passed');
  process.exit(0);
}

await main();
