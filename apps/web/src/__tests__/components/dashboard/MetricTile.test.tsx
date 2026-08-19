import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../../utils/test-utils';
import { MetricTile, describeTrend } from '../../../components/dashboard/MetricTile';
import { METRIC_DEFINITIONS } from '../../../components/dashboard/metrics';

const latency = METRIC_DEFINITIONS.detectionLatency;
const acceptance = METRIC_DEFINITIONS.firstPassAcceptance;

/**
 * The honesty contract, asserted point by point.
 *
 * Every one of these is a claim the cockpit makes to an operator who is
 * deciding whether to intervene. The contract is documented in
 * `components/common/NotWiredState.tsx`; this suite is what enforces it.
 */
describe('MetricTile — the honesty contract', () => {
  it('1. shows an em dash for an absent value, never a zero', () => {
    render(
      <MetricTile
        metric={latency}
        value={null}
        trend={null}
        state="unwired"
        phase="Phase 3 — Liveness and escalation"
      />,
    );

    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.queryByText('0')).not.toBeInTheDocument();
    expect(screen.queryByText('0s')).not.toBeInTheDocument();
  });

  it('1b. still renders a genuine zero as a measurement', () => {
    // The mirror image of the rule above: absence must not look like zero, and
    // zero must not look like absence.
    render(<MetricTile metric={latency} value={0} trend={null} state="ready" />);

    expect(screen.getByText('0s')).toBeInTheDocument();
    expect(screen.queryByText('—')).not.toBeInTheDocument();
  });

  it('2. teaches what will be measured even with no data', () => {
    render(
      <MetricTile metric={latency} value={null} trend={null} state="unwired" phase="Phase 3" />,
    );

    expect(screen.getByRole('heading', { name: latency.label })).toBeInTheDocument();
    expect(screen.getByText(latency.definition)).toBeInTheDocument();
    // The "Why" cell and the target, verbatim from VISION §10.
    expect(screen.getByText(/The original complaint, quantified\./)).toBeInTheDocument();
    expect(screen.getByText(/Target: seconds\./)).toBeInTheDocument();
  });

  it('3. names the roadmap phase that will supply it', () => {
    render(
      <MetricTile
        metric={latency}
        value={null}
        trend={null}
        state="unwired"
        phase="Phase 3 — Liveness and escalation"
      />,
    );

    expect(
      screen.getByText(/Arrives in Phase 3 — Liveness and escalation/),
    ).toBeInTheDocument();
  });

  it('4. draws no sparkline when unwired, whatever it is handed', () => {
    render(
      <MetricTile
        metric={latency}
        value={null}
        // Even given a series, an unwired tile draws nothing: a chart beside a
        // dash would claim we have history for a number we have never measured.
        trend={[1, 2, 3]}
        state="unwired"
        phase="Phase 3"
      />,
    );

    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('4b. draws no sparkline from fewer than two samples', () => {
    render(<MetricTile metric={latency} value={12} trend={[12]} state="ready" />);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('4c. draws one once there are two real samples', () => {
    render(<MetricTile metric={latency} value={12} trend={[30, 12]} state="ready" />);
    expect(screen.getByRole('img')).toBeInTheDocument();
  });

  it('5. is visually recessive when unwired and solid when it has a reading', () => {
    const { container: unwired } = render(
      <MetricTile metric={latency} value={null} trend={null} state="unwired" phase="Phase 3" />,
    );
    const { container: ready } = render(
      <MetricTile metric={latency} value={12} trend={null} state="ready" />,
    );

    const unwiredStyle = getComputedStyle(unwired.firstElementChild as Element);
    const readyStyle = getComputedStyle(ready.firstElementChild as Element);

    expect(unwiredStyle.borderStyle).toBe('dashed');
    expect(readyStyle.borderStyle).toBe('solid');
    // A screenful of dashed, transparent tiles reads "not built"; a screenful
    // of solid cards with dashes in them would read "broken".
    // jsdom normalises `transparent` to `rgba(0, 0, 0, 0)`.
    expect(unwiredStyle.backgroundColor).toBe('rgba(0, 0, 0, 0)');
    expect(readyStyle.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
  });

  it('6. is not hidden from screen readers, and wires its explanation up', () => {
    render(
      <MetricTile metric={latency} value={null} trend={null} state="unwired" phase="Phase 3" />,
    );

    const section = screen.getByRole('region', { name: latency.label });
    expect(section).not.toHaveAttribute('aria-hidden');

    const describedBy = section.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toContain(latency.help);
  });

  it('applies the tabular-numeral class to the value', () => {
    // Without it a polled figure reflows its own column on every tick and the
    // stat row twitches, which reads as instability in the system being
    // watched rather than in the typography.
    render(<MetricTile metric={latency} value={45} trend={null} state="ready" />);
    expect(screen.getByText('45s')).toHaveClass('opifex-num');
  });
});

describe('describeTrend', () => {
  /**
   * "Rising" is good for first-pass acceptance and bad for detection latency.
   * The direction alone is ambiguous, so the sentence has to carry the verdict
   * — and that sentence is the sparkline's entire information content for a
   * screen reader user.
   */
  it('calls a rise on a lower-is-better metric worse', () => {
    expect(describeTrend(latency, [10, 20, 30])).toContain('worse');
    expect(describeTrend(latency, [10, 20, 30])).toContain('rising');
  });

  it('calls a rise on a higher-is-better metric better', () => {
    expect(describeTrend(acceptance, [0.4, 0.6, 0.8])).toContain('better');
  });

  it('calls a fall on a lower-is-better metric better', () => {
    expect(describeTrend(latency, [30, 20, 10])).toContain('better');
  });

  it('says unchanged without a verdict when the series is flat', () => {
    const description = describeTrend(latency, [5, 5, 5]);
    expect(description).toContain('unchanged');
    expect(description).not.toContain('better');
    expect(description).not.toContain('worse');
  });

  it('states how many samples the claim is based on', () => {
    expect(describeTrend(latency, [1, 2, 3, 4])).toContain('4 samples');
  });
});
