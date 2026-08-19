import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';
import { DashboardHeader } from '../../../components/dashboard/DashboardHeader';

const updatedAt = new Date('2026-08-19T14:32:00.000Z');

describe('DashboardHeader', () => {
  it('titles the page as the cockpit', () => {
    render(
      <DashboardHeader
        status="unwired"
        lastUpdatedAt={null}
        isRefreshing={false}
        onRefresh={vi.fn()}
      />,
    );

    expect(screen.getByRole('heading', { level: 1, name: 'Cockpit' })).toBeInTheDocument();
  });

  describe('the indicator says which of four things is true', () => {
    it('unwired names the roadmap phase', () => {
      render(
        <DashboardHeader
          status="unwired"
          lastUpdatedAt={null}
          isRefreshing={false}
          onRefresh={vi.fn()}
          phase="Phase 3 — Liveness and escalation"
        />,
      );

      expect(
        screen.getByText('Not yet wired — Phase 3 — Liveness and escalation'),
      ).toBeInTheDocument();
    });

    it('unwired degrades gracefully without a phase', () => {
      render(
        <DashboardHeader
          status="unwired"
          lastUpdatedAt={null}
          isRefreshing={false}
          onRefresh={vi.fn()}
        />,
      );

      expect(screen.getByText('Not yet wired')).toBeInTheDocument();
    });

    it('live carries the time it was last true', () => {
      render(
        <DashboardHeader
          status="live"
          lastUpdatedAt={updatedAt}
          isRefreshing={false}
          onRefresh={vi.fn()}
        />,
      );

      expect(screen.getByText(/^Live — updated \d{1,2}[:.]\d{2}/)).toBeInTheDocument();
    });

    it('live without a timestamp says only Live', () => {
      render(
        <DashboardHeader
          status="live"
          lastUpdatedAt={null}
          isRefreshing={false}
          onRefresh={vi.fn()}
        />,
      );

      expect(screen.getByText('Live')).toBeInTheDocument();
    });

    /**
     * An ABSOLUTE time, not "4m ago". A relative age that is itself only
     * recomputed on each poll is a stale string about staleness.
     */
    it('stale carries the wall-clock time the data was last good', () => {
      render(
        <DashboardHeader
          status="stale"
          lastUpdatedAt={updatedAt}
          isRefreshing={false}
          onRefresh={vi.fn()}
        />,
      );

      expect(screen.getByText(/^Stale since \d{1,2}[:.]\d{2}/)).toBeInTheDocument();
      expect(screen.queryByText(/ago/)).not.toBeInTheDocument();
    });

    it('stale without a timestamp still says stale', () => {
      render(
        <DashboardHeader
          status="stale"
          lastUpdatedAt={null}
          isRefreshing={false}
          onRefresh={vi.fn()}
        />,
      );

      expect(screen.getByText('Stale')).toBeInTheDocument();
    });

    it('error says the API is unreachable', () => {
      render(
        <DashboardHeader
          status="error"
          lastUpdatedAt={null}
          isRefreshing={false}
          onRefresh={vi.fn()}
        />,
      );

      expect(screen.getByText('Cannot reach the API')).toBeInTheDocument();
    });
  });

  describe('the refresh control', () => {
    /**
     * HIDDEN, not disabled. A permanently disabled button occupies the
     * affordance for an action that will never become available in this build,
     * and a user who cannot see why it is disabled reads it as breakage.
     * Disabled means "not right now"; absent means "not a thing here".
     */
    it('is absent when there is no endpoint to refresh', () => {
      render(
        <DashboardHeader
          status="unwired"
          lastUpdatedAt={null}
          isRefreshing={false}
          onRefresh={vi.fn()}
        />,
      );

      expect(screen.queryByRole('button', { name: /refresh/i })).not.toBeInTheDocument();
    });

    it('is present and calls back when there is', async () => {
      const onRefresh = vi.fn();
      const user = userEvent.setup();

      render(
        <DashboardHeader
          status="live"
          lastUpdatedAt={updatedAt}
          isRefreshing={false}
          onRefresh={onRefresh}
        />,
      );

      await user.click(screen.getByRole('button', { name: /refresh/i }));
      expect(onRefresh).toHaveBeenCalledTimes(1);
    });

    it('is disabled while a refresh is already in flight', () => {
      // Disabled is right HERE — the action is unavailable "not right now",
      // which is precisely what disabled means.
      render(
        <DashboardHeader
          status="live"
          lastUpdatedAt={updatedAt}
          isRefreshing
          onRefresh={vi.fn()}
        />,
      );

      expect(screen.getByRole('button', { name: /refresh/i })).toBeDisabled();
      expect(screen.getByRole('progressbar')).toBeInTheDocument();
    });
  });
});
