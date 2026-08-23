import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../../utils/test-utils';
import { MetricsRow } from '../../../components/dashboard/MetricsRow';
import { METRIC_LIST } from '../../../components/dashboard/metrics';
import type { MetricsSummary } from '../../../types/cockpit';

const summary: MetricsSummary = {
  generatedAt: '2026-08-19T12:00:00.000Z',
  window: { from: '2026-08-12T12:00:00.000Z', to: '2026-08-19T12:00:00.000Z' },
  metrics: {
    detectionLatency: { value: 45, trend: [90, 60, 45] },
    deadTimePerDay: { value: 1.5, trend: [] },
    firstPassAcceptance: { value: 0.82, trend: [] },
    attemptsPerWorkOrder: { value: 1.4, trend: [] },
    costPerMergedPr: { value: 12.4, trend: [] },
    // A metric the control plane could not compute is `null` — a real answer,
    // and one the row must render as `—` rather than as zero.
    quotaBurn: { value: null, trend: [] },
  },
};

describe('MetricsRow', () => {
  it('renders all six metrics as one labelled region', () => {
    render(<MetricsRow summary={null} state="unwired" phase="Phase 3" />);

    // VISION §10's own phrase, so the landmark matches the document.
    expect(
      screen.getByRole('region', { name: 'Success metrics' }),
    ).toBeInTheDocument();
    for (const metric of METRIC_LIST) {
      expect(
        screen.getByRole('heading', { name: metric.label }),
      ).toBeInTheDocument();
    }
  });

  it('shows six dashes and no numbers when unwired', () => {
    render(<MetricsRow summary={null} state="unwired" phase="Phase 3" />);

    expect(screen.getAllByText('—')).toHaveLength(6);
    expect(screen.getAllByText(/Arrives in Phase 3/)).toHaveLength(6);
  });

  it('renders each metric formatted by its own definition once wired', () => {
    render(<MetricsRow summary={summary} state="ready" phase="Phase 3" />);

    expect(screen.getByText('45s')).toBeInTheDocument();
    expect(screen.getByText('1.5 h')).toBeInTheDocument();
    expect(screen.getByText('82%')).toBeInTheDocument();
    expect(screen.getByText('1.4')).toBeInTheDocument();
  });

  it('renders an uncomputed metric as a dash beside computed ones', () => {
    render(<MetricsRow summary={summary} state="ready" phase="Phase 3" />);

    // Exactly one: the five computed values must not be dashed out with it.
    expect(screen.getAllByText('—')).toHaveLength(1);
  });

  it('draws a sparkline only for the metric that has a series', () => {
    render(<MetricsRow summary={summary} state="ready" phase="Phase 3" />);
    expect(screen.getAllByRole('img')).toHaveLength(1);
  });
});
