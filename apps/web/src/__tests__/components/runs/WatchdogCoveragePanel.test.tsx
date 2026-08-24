/**
 * `WatchdogCoveragePanel` (#104, epic #23).
 *
 * The suite is organised around ONE claim, because #104 is about one failure:
 *
 * > A check that is unavailable must report itself as unavailable, not
 * > silently pass. A tool-loop detector that quietly does nothing on a
 * > non-streaming runner looks identical, in the cockpit, to one that ran and
 * > found no loop.
 *
 * So the central test renders the same panel twice — a full-streaming runner
 * and a near-zero-streaming one, side by side, exactly as the issue's own
 * acceptance criterion asks — and asserts the two are visibly different where
 * loop detection is concerned. Everything else here supports that.
 *
 * Assertions are on accessible output (text, roles, headings) rather than on
 * classes or colours. `data-check` / `data-check-status` are used only to
 * SCOPE a query to one row; nothing is asserted about styling through them,
 * because a chip that reads "Unavailable" is legible to a screen reader and a
 * greyscale display alike, and the colour is only the third channel.
 */

import { describe, it, expect } from 'vitest';
import { screen, within } from '@testing-library/react';
import { render } from '../../utils/test-utils';
import { WatchdogCoveragePanel } from '../../../components/runs/WatchdogCoveragePanel';
import type {
  CheckCoverage,
  RunCheckCoverage,
  WatchdogCheckId,
} from '../../../types/cockpit';

// ---------------------------------------------------------------------------
// Fixtures — two runners, shaped like the API's own output for each
// ---------------------------------------------------------------------------

/**
 * A `full` fidelity runner with structured rate-limit signals: every check
 * active. This is the "green row" the unavailable case has to stand out from.
 */
const fullStreaming: RunCheckCoverage = {
  runnerKey: 'claude-code-local',
  streamingFidelity: 'full',
  rateLimitSignal: 'structured',
  weakest: 'active',
  checks: [
    {
      check: 'silence-detection',
      status: 'active',
      signal: 'runner heartbeats and per-tool progress events',
      reason:
        'claude-code-local declares full streaming fidelity, so silence is measured on heartbeats the runner emits continuously: a stall shows up within 1m 30s.',
      thresholdMs: 90_000,
    },
    {
      check: 'loop-detection',
      status: 'active',
      signal: 'consecutive repeats of one tool-call signature',
      reason:
        'claude-code-local declares full streaming fidelity, which reports a signature per tool call — the signal loop detection needs.',
      thresholdMs: null,
    },
    {
      check: 'rate-limit-parking',
      status: 'active',
      signal: 'a reset time on the run.blocked event',
      reason:
        'claude-code-local declares structured rate-limit signals, so a block arrives with a machine-readable reset time.',
      thresholdMs: null,
    },
    {
      check: 'git-liveness',
      status: 'active',
      signal: 'commits, pull-request transitions and CI verdicts on the branch',
      reason:
        'The git watcher polls factory/312-a3f91c2-a1, giving this run a liveness source independent of claude-code-local.',
      thresholdMs: null,
    },
  ],
};

/**
 * A runner that streams nothing and cannot date a rate limit: two checks
 * degraded, two unavailable. `weakest` is `unavailable`, which dominates.
 */
const nonStreaming: RunCheckCoverage = {
  runnerKey: 'batch-runner',
  streamingFidelity: 'none',
  rateLimitSignal: 'none',
  weakest: 'unavailable',
  checks: [
    {
      check: 'silence-detection',
      status: 'degraded',
      signal: 'git commits and pull-request transitions, via the git watcher',
      reason:
        'batch-runner declares no streaming, so silence is measured on git activity rather than on anything the runner reports. The threshold is 1h 30m.',
      thresholdMs: 90 * 60_000,
    },
    {
      check: 'loop-detection',
      status: 'unavailable',
      signal: 'consecutive repeats of one tool-call signature',
      reason:
        'batch-runner declares no streaming at all, which carries no per-tool detail. A run looping on this runner is NOT detected here — this check is not passing, it is absent.',
      thresholdMs: null,
    },
    {
      check: 'rate-limit-parking',
      status: 'unavailable',
      signal: 'none — a rate limit is indistinguishable from any other failure',
      reason:
        'batch-runner declares no rate-limit signal, so a block on this runner ESCALATES to a human instead of parking.',
      thresholdMs: null,
    },
    {
      check: 'git-liveness',
      status: 'degraded',
      signal: 'commits, pull-request transitions and CI verdicts on the branch',
      reason:
        'The git watcher polls factory/312-a3f91c2-a1, and on this run it is the ONLY liveness source.',
      thresholdMs: null,
    },
  ],
};

/** A runner that filed no manifest at all — every declaration is null. */
const noManifest: RunCheckCoverage = {
  runnerKey: 'mystery-runner',
  streamingFidelity: null,
  rateLimitSignal: null,
  weakest: 'unavailable',
  checks: nonStreaming.checks.map((check) => ({ ...check })),
};

/**
 * Scope a query to one check's row. The attribute is a stable hook that
 * depends on neither the wording nor the colour; every assertion made through
 * it is still about text.
 */
function row(container: HTMLElement, check: WatchdogCheckId): HTMLElement {
  const element = container.querySelector<HTMLElement>(
    `[data-check="${check}"]`,
  );
  if (!element) throw new Error(`No row rendered for check "${check}"`);
  return element;
}

// ---------------------------------------------------------------------------
// The claim the issue is about
// ---------------------------------------------------------------------------

describe('WatchdogCoveragePanel — unavailable never reads as passing', () => {
  it('renders loop detection differently on a runner that cannot support it', () => {
    const covered = render(<WatchdogCoveragePanel coverage={fullStreaming} />);
    const coveredRow = row(covered.container, 'loop-detection');
    const coveredText = coveredRow.textContent ?? '';
    covered.unmount();

    const uncovered = render(<WatchdogCoveragePanel coverage={nonStreaming} />);
    const uncoveredRow = row(uncovered.container, 'loop-detection');
    const uncoveredText = uncoveredRow.textContent ?? '';

    // The whole point: the two rows do not read the same.
    expect(uncoveredText).not.toEqual(coveredText);
    expect(coveredText).toContain('Active');
    expect(uncoveredText).toContain('Unavailable');
  });

  it('shows no success affordance anywhere in an unavailable row', () => {
    const { container } = render(
      <WatchdogCoveragePanel coverage={nonStreaming} />,
    );
    const loop = within(row(container, 'loop-detection'));

    expect(loop.getByText('Unavailable')).toBeInTheDocument();
    // Not "Active", not "Degraded" — nothing that claims the failure mode is
    // being watched for. `queryByText` with an exact match rather than a
    // substring, so "not detected" in the reason cannot satisfy it.
    expect(loop.queryByText('Active')).not.toBeInTheDocument();
    expect(loop.queryByText('Degraded')).not.toBeInTheDocument();
  });

  it('states, in words, that the guarded failure mode is unguarded', () => {
    render(<WatchdogCoveragePanel coverage={nonStreaming} />);

    // The API's own sentence, rendered verbatim. If the panel ever started
    // summarising these instead of printing them, this is what would break.
    expect(
      screen.getByText(/this check is not passing, it is absent/i),
    ).toBeInTheDocument();
  });

  it('never labels an unavailable check as an error or a failure', () => {
    const { container } = render(
      <WatchdogCoveragePanel coverage={nonStreaming} />,
    );

    // `unavailable` is not a failure: nothing ran and nothing broke. A red
    // "Failed"/"Error" reading would send an operator hunting for a break that
    // does not exist, and would be a badge they can never clear.
    expect(container.textContent).not.toMatch(/\bFailed\b/);
    expect(container.textContent).not.toMatch(/\bError\b/);
    // MUI's error Alert is the shape that reading would take.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// The panel-level rollup
// ---------------------------------------------------------------------------

describe('WatchdogCoveragePanel — summary', () => {
  it('says a check is missing, and names it, without anything being expanded', () => {
    render(<WatchdogCoveragePanel coverage={nonStreaming} />);
    const summary = within(screen.getByRole('status'));

    expect(
      summary.getByText(/a check is missing on this runner/i),
    ).toBeInTheDocument();
    expect(
      summary.getByText(/Loop detection, Rate limit parking/),
    ).toBeInTheDocument();
  });

  it('reports full coverage only when every check is active', () => {
    render(<WatchdogCoveragePanel coverage={fullStreaming} />);
    const summary = within(screen.getByRole('status'));

    expect(summary.getByText('Fully covered')).toBeInTheDocument();
    expect(
      summary.getByText(/All 4 checks are protecting this run as designed/),
    ).toBeInTheDocument();
  });

  it('distinguishes a merely degraded run from one missing a check', () => {
    const degradedOnly: RunCheckCoverage = {
      ...fullStreaming,
      weakest: 'degraded',
      checks: fullStreaming.checks.map((check, index): CheckCoverage =>
        index === 0 ? { ...check, status: 'degraded' } : check,
      ),
    };
    render(<WatchdogCoveragePanel coverage={degradedOnly} />);
    const summary = within(screen.getByRole('status'));

    expect(
      summary.getByText(/Covered, with reduced sensitivity/i),
    ).toBeInTheDocument();
    // Degraded is late detection, not absent detection, and the summary must
    // not claim otherwise.
    expect(summary.queryByText(/cannot run on this runner/)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Rows, declarations and thresholds
// ---------------------------------------------------------------------------

describe('WatchdogCoveragePanel — rows', () => {
  it('renders all four checks, in the order the API sent them', () => {
    render(<WatchdogCoveragePanel coverage={nonStreaming} />);

    expect(
      screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent),
    ).toEqual([
      'Silence detection',
      'Loop detection',
      'Rate limit parking',
      'Git liveness',
    ]);
  });

  it('prints the reason on an ACTIVE check too, not only on the bad ones', () => {
    // The API populates `reason` unconditionally on purpose: a UI that only
    // explains itself when something is wrong teaches operators that a quiet
    // badge means "nothing to explain", which is the skimming habit that makes
    // an unavailable check easy to miss.
    const { container } = render(
      <WatchdogCoveragePanel coverage={fullStreaming} />,
    );
    const loop = within(row(container, 'loop-detection'));

    expect(
      loop.getByText(/which reports a signature per tool call/),
    ).toBeInTheDocument();
    expect(
      loop.getByText(/consecutive repeats of one tool-call signature/),
    ).toBeInTheDocument();
  });

  it('renders a threshold where one applies, and nothing where none does', () => {
    const { container } = render(
      <WatchdogCoveragePanel coverage={nonStreaming} />,
    );

    expect(
      within(row(container, 'silence-detection')).getByText('Threshold 1h 30m'),
    ).toBeInTheDocument();
    expect(
      within(row(container, 'loop-detection')).queryByText(/Threshold/),
    ).toBeNull();
  });

  it('surfaces the declarations that produced the coverage', () => {
    render(<WatchdogCoveragePanel coverage={nonStreaming} />);

    expect(screen.getByText('batch-runner')).toBeInTheDocument();
    expect(screen.getByText('Streaming fidelity')).toBeInTheDocument();
    expect(screen.getByText('Rate-limit signal')).toBeInTheDocument();
    expect(screen.getAllByText('None')).toHaveLength(2);
  });

  it('never renders a missing manifest as a declared "none"', () => {
    render(<WatchdogCoveragePanel coverage={noManifest} />);

    // A runner that filed nothing is a different, more alarming fact than one
    // that declared it streams nothing, and the remedy is different too.
    expect(screen.getAllByText('No manifest filed')).toHaveLength(2);
    expect(screen.queryByText('None')).toBeNull();
  });
});
