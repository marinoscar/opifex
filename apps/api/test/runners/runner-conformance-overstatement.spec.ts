/**
 * The overstatement trap (#106, tier 3) — proving the suite has teeth.
 *
 * #106's second, more valuable job: "catching a runner whose manifest
 * OVERSTATES its capabilities. A runner claiming full streaming that does
 * not deliver it should fail here, loudly, rather than in production as a
 * watchdog that silently never fires." A suite that cannot demonstrate its
 * own failure mode is a suite nobody should trust — this file is the
 * demonstration.
 *
 * Each config below (`conformance/fake-runner-fixtures.ts`) is a
 * `FakeRunner` whose declared capabilities are honest about everything
 * EXCEPT one, which its scenario deliberately withholds. None of these three
 * configs is in `runner-conformance.spec.ts`'s config array — that suite is
 * the one every real runner has to PASS, and a config engineered to fail
 * would make that claim meaningless.
 *
 * These assertions run through `collectRunnerConformanceFindings`, not
 * `runRunnerConformanceSuite`, precisely because a normal spec cannot assert
 * "Jest would have failed here" — that seam (a plain function returning
 * findings) is what `runner-conformance-suite.ts`'s doc comment calls out as
 * the design this brief asked for explicitly.
 */

import {
  lyingRateLimitStructuredConfig,
  lyingReportsCostConfig,
  lyingStreamingFullConfig,
} from './conformance/fake-runner-fixtures';
import { collectRunnerConformanceFindings } from './conformance/runner-conformance-suite';

describe('the overstatement trap (#106)', () => {
  it('fails the tool-detail check when "full" streaming is claimed but not delivered', async () => {
    const findings = await collectRunnerConformanceFindings(
      lyingStreamingFullConfig(),
    );

    const target = findings.find(
      (finding) => finding.id === 'streaming-full-carries-tool-detail',
    );
    expect(target).toBeDefined();
    expect(target?.passed).toBe(false);
    expect(target?.detail).toMatch(/no event carried a tool name/);

    // Precision, not blanket failure: a manifest lying about ONE capability
    // should only sink the ONE check that capability gates. Everything else
    // — including the other two tier-2 checks this profile still honestly
    // delivers — passes.
    const others = findings.filter((finding) => finding.id !== target?.id);
    const stillFailing = others.filter((finding) => !finding.passed);
    expect(stillFailing).toEqual([]);
  });

  it('fails the cost check when cost reporting is claimed but never delivered', async () => {
    const findings = await collectRunnerConformanceFindings(
      lyingReportsCostConfig(),
    );

    const target = findings.find(
      (finding) => finding.id === 'reports-cost-appears-on-some-event',
    );
    expect(target).toBeDefined();
    expect(target?.passed).toBe(false);
    expect(target?.detail).toMatch(/no event carried a usd cost/);

    const others = findings.filter((finding) => finding.id !== target?.id);
    const stillFailing = others.filter((finding) => !finding.passed);
    expect(stillFailing).toEqual([]);
  });

  it('fails the rate-limit check when a "structured" block carries no reset time', async () => {
    const findings = await collectRunnerConformanceFindings(
      lyingRateLimitStructuredConfig(),
    );

    const target = findings.find(
      (finding) =>
        finding.id === 'rate-limit-structured-blocked-event-has-reset-time',
    );
    expect(target).toBeDefined();
    expect(target?.passed).toBe(false);
    expect(target?.detail).toMatch(/carried no resetAt/);

    const others = findings.filter((finding) => finding.id !== target?.id);
    const stillFailing = others.filter((finding) => !finding.passed);
    expect(stillFailing).toEqual([]);
  });

  it('never silently drops a check — collectRunnerConformanceFindings reports one finding per applicable check', async () => {
    // A collector that swallowed a check would be a suite that looked green
    // for the wrong reason. Every lying profile here declares the full
    // high-capability manifest, so it should run every tier-1 check plus all
    // three tier-2 checks that apply to full/structured/true.
    const findings = await collectRunnerConformanceFindings(
      lyingStreamingFullConfig(),
    );

    expect(findings.length).toBeGreaterThanOrEqual(9 + 3);
    for (const finding of findings) {
      expect(finding.detail.startsWith('threw instead of completing')).toBe(
        false,
      );
    }
  });
});
