import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../../utils/test-utils';
import { AttentionRow } from '../../../components/dashboard/AttentionRow';
import type { RunSummary } from '../../../types/cockpit';

const now = new Date('2026-08-19T12:00:00.000Z');

function makeRun(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    id: 'run-1',
    workOrder: {
      id: 'wo_opifex_312_a3f91c2_a1',
      issueNumber: 312,
      repository: 'opifex/opifex',
      baseCommit: 'a3f91c2',
      attempt: 1,
      branch: 'factory/312-a3f91c2-a1',
      title: 'Add the run queue endpoint',
      issueUrl: 'https://github.com/opifex/opifex/issues/312',
    },
    status: 'stalled',
    startedAt: '2026-08-19T06:00:00.000Z',
    lastEventAt: '2026-08-19T11:48:00.000Z',
    attentionReason: 'No events for 12 minutes. Kill and re-run from the base commit.',
    resumesAt: null,
    runner: 'claude-code-local',
    costUsd: 1.25,
    pullRequestUrl: null,
    ...overrides,
  };
}

describe('AttentionRow', () => {
  it('leads with the status, as icon plus label plus color', () => {
    render(<AttentionRow run={makeRun()} now={now} />);
    // `StatusChip` guarantees all three channels; the row must not bypass it.
    expect(screen.getByText('Stalled')).toBeInTheDocument();
  });

  it('shows the full work-order id in the mono token', () => {
    render(<AttentionRow run={makeRun()} now={now} />);

    const id = screen.getByText('wo_opifex_312_a3f91c2_a1');
    expect(id).toHaveClass('opifex-mono');
  });

  /**
   * The age is measured from `lastEventAt`, not `startedAt`, and that is the
   * whole point of the row: a run going for six hours with events flowing is
   * healthy, one silent for twelve minutes is the failure being escalated.
   */
  it('ages the run from its last event, not from when it started', () => {
    render(<AttentionRow run={makeRun()} now={now} />);

    expect(screen.getByText('last event 12m ago')).toBeInTheDocument();
    // Six hours since `startedAt` — must not be what is shown.
    expect(screen.queryByText(/6h/)).not.toBeInTheDocument();
  });

  it('says so plainly when a run has never reported anything', () => {
    // A dispatched run that was never heard from is exactly the "silent"
    // failure mode; it has no last event by definition.
    render(<AttentionRow run={makeRun({ lastEventAt: null })} now={now} />);
    expect(screen.getByText('no events yet')).toBeInTheDocument();
  });

  it('shows the reason a human is needed', () => {
    render(<AttentionRow run={makeRun()} now={now} />);
    expect(
      screen.getByText('No events for 12 minutes. Kill and re-run from the base commit.'),
    ).toBeInTheDocument();
  });

  /**
   * VISION §9's three-failure-modes rule at the last mile: a reason means a
   * human acts, a reset time means a human must NOT. The row shows one or the
   * other and never both.
   */
  it('shows a reset time instead of a reason for a run that resumes itself', () => {
    render(
      <AttentionRow
        run={makeRun({
          status: 'blocked',
          attentionReason: null,
          resumesAt: '2026-08-19T12:30:00.000Z',
        })}
        now={now}
      />,
    );

    expect(screen.getByText('Resumes in 30m')).toBeInTheDocument();
  });

  it('links the title to the pull request when there is one', () => {
    render(
      <AttentionRow
        run={makeRun({ pullRequestUrl: 'https://github.com/opifex/opifex/pull/9' })}
        now={now}
      />,
    );

    const link = screen.getByRole('link', { name: 'Add the run queue endpoint' });
    expect(link).toHaveAttribute('href', 'https://github.com/opifex/opifex/pull/9');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('renders as a list item so the panel can be a real list', () => {
    render(<AttentionRow run={makeRun()} now={now} />);
    // A screen reader user gets "list, N items" and can skip it — worth two
    // extra elements on the panel most likely to be read under time pressure.
    expect(screen.getByRole('listitem')).toBeInTheDocument();
  });
});
