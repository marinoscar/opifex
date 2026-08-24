/**
 * The cross-runner conformance suite (#106, epic #23 phase 8).
 *
 * This file's whole job is to invoke the reusable suite
 * (`conformance/runner-conformance-suite.ts`) against every runner Opifex
 * currently has. See that module's doc comment for what each check traces to
 * in `apps/api/src/runners/runner.types.ts`, and `conformance/fake-runner-
 * fixtures.ts` / `conformance/claude-code-local-fixture.ts` for how each
 * config drives its runner.
 *
 * ## Adding a third runner
 *
 * Add one more entry to `CONFIGS` below. That is the whole contract #106's
 * last acceptance criterion asks for — "a third runner can be added to it as
 * configuration, not new test code."
 *
 * ## What is and is not configured, honestly
 *
 * - Two `FakeRunner` profiles: a high-capability one (full streaming,
 *   structured rate limits, cost reporting) and a near-zero-streaming one
 *   standing in for what `claude-code-cloud` would have been.
 * - `ClaudeCodeLocalRunner`, the one real runner, driven through its actual
 *   `submit`/`poll`/`cancel`/`capabilities` — real process spawn, real git,
 *   real stream mapping — against a fixture `stream-json` binary rather than
 *   the real (paid, credentialed) CLI.
 * - `claude-code-cloud` (#102/#103) is NOT here. It is blocked on the
 *   vendor: the CLI refuses `--cloud` combined with `--print` —
 *   "Cloud sessions are interactive only" — so no non-interactive surface
 *   exists to bind the seam to. `gh issue view 102 --comments` has the full
 *   finding. This is a vendor gap, not a gap in this suite.
 *
 * ## CI
 *
 * No workflow change was needed. `apps/api/test/jest.config.js` roots
 * `test/` alongside `src/` and matches every `*.spec.ts`, and
 * `.github/workflows/ci.yml`'s `test-api` job already runs the whole thing
 * via `npm run api:test`. This file is picked up the same way every other
 * `*.spec.ts` under `test/` is.
 */

import {
  capableFakeRunnerConfig,
  nearZeroFakeRunnerConfig,
} from './conformance/fake-runner-fixtures';
import { realClaudeCodeLocalRunnerConfig } from './conformance/claude-code-local-fixture';
import {
  collectRunnerConformanceFindings,
  runRunnerConformanceSuite,
  type RunnerConformanceConfig,
} from './conformance/runner-conformance-suite';

const CONFIGS: RunnerConformanceConfig[] = [
  capableFakeRunnerConfig(),
  nearZeroFakeRunnerConfig(),
  realClaudeCodeLocalRunnerConfig(),
];

describe('cross-runner conformance (#106)', () => {
  for (const config of CONFIGS) {
    runRunnerConformanceSuite(config);
  }

  describe('the near-zero-streaming profile is not held to capabilities it never claimed', () => {
    it('runs zero tier-2 checks — not weakened ones', async () => {
      // #106: "streamingFidelity: 'none' -> no event-stream assertion at
      // all. Not a weakened one. Zero." This is what proves it: every
      // finding for the near-zero profile is tier 1.
      const findings = await collectRunnerConformanceFindings(
        nearZeroFakeRunnerConfig(),
      );

      expect(findings.length).toBeGreaterThan(0);
      expect(findings.every((finding) => finding.tier === 1)).toBe(true);
      expect(findings.every((finding) => finding.passed)).toBe(true);
    });
  });
});
