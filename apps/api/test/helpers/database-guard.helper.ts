/**
 * Shared guard for integration specs that need a REAL Postgres database
 * (`infra/compose/test.compose.yml`, `opifex_test`, host port 5433) instead
 * of the mocked `PrismaService` most suites in this repo use.
 *
 * `describeIfDb(specFileName, name, fn)` runs the suite when
 * `DATABASE_URL`/`POSTGRES_HOST` is set. When it is not:
 *
 *  - **In CI** (GitHub Actions sets `CI=true` on every job unconditionally,
 *    regardless of which workflow step ran) the suite still executes, but as
 *    a single failing test that explains why. A CI job that forgot to
 *    provision a database — or whose Postgres service failed to come up —
 *    must produce a red check, not a quiet skip that looks identical to a
 *    pass in the summary. See #440 / #321.
 *  - **Everywhere else** (a developer's laptop with no local test database)
 *    the suite is skipped exactly as before, with a `console.warn` pointing
 *    at the compose file to bring it up.
 *
 * Deliberately NOT gated by a bespoke opt-out env var (#440 floated
 * `SKIP_DB_TESTS`): GitHub Actions already guarantees `CI=true` on every
 * job, so it is an ambient signal nothing has to remember to set — unlike a
 * flag that would need to be threaded into every future workflow job (and
 * could be forgotten there the same way the missing `services:` block was
 * forgotten here in the first place).
 */

/** True when a real database is reachable via the usual env vars. */
export function databaseReachable(): boolean {
  return Boolean(process.env.DATABASE_URL || process.env.POSTGRES_HOST);
}

/**
 * True on GitHub Actions — and any other CI system that follows the same
 * convention of exporting `CI=true` — false on a developer's machine.
 */
function isCi(): boolean {
  return process.env.CI === 'true' || process.env.CI === '1';
}

/**
 * `describe`, gated on database reachability. `specFileName` is used only
 * in the skip warning / failure message, so it should match the file this
 * is called from (e.g. `'reconciler-actions-executed.integration.spec.ts'`).
 */
export function describeIfDb(
  specFileName: string,
  name: string,
  fn: () => void,
): void {
  if (databaseReachable()) {
    describe(name, fn);
    return;
  }

  if (isCi()) {
    describe(name, () => {
      it('requires a reachable database, but none was provisioned in CI', () => {
        throw new Error(
          `${specFileName}: no DATABASE_URL/POSTGRES_HOST in the environment, but CI=true. ` +
            "The 'Test API' job is expected to provision opifex_test " +
            '(infra/compose/test.compose.yml) before this suite runs — see ' +
            '.github/workflows/ci.yml. Skipping here would silently shrink the suite CI ' +
            'reports on, so this fails loudly instead. See #440 / #321.',
        );
      });
    });
    return;
  }

  console.warn(
    `Skipping ${specFileName}: no DATABASE_URL/POSTGRES_HOST in the environment. Point it at ` +
      'opifex_test (infra/compose/test.compose.yml) to run it.',
  );
  describe.skip(name, fn);
}
