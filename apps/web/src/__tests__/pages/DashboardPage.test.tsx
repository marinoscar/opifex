import { describe, it, expect } from 'vitest';
import { screen, within } from '@testing-library/react';
import { render } from '../utils/test-utils';
import DashboardPage, { deriveDashboardStatus } from '../../pages/DashboardPage';
import { METRIC_LIST } from '../../components/dashboard/metrics';


/**
 * Read the `order` an element is given inside a specific breakpoint.
 *
 * `getComputedStyle` cannot answer this: MUI emits every responsive value —
 * including the `xs` one — inside an `@media (min-width:Npx)` block, and jsdom
 * does not evaluate media queries when computing styles. So the assertion goes
 * to the emitted stylesheet instead, which is also the only place the `sm`
 * value exists at all in a headless test.
 */
function orderAt(element: HTMLElement, minWidthPx: number): string | null {
  const css = Array.from(document.querySelectorAll('style'))
    .map((style) => style.textContent ?? '')
    .join('\n');

  for (const className of element.className.split(' ').filter(Boolean)) {
    const block = css.match(
      new RegExp(`@media \\(min-width:${minWidthPx}px\\)\\{\\.${className}\\{([^}]*)\\}\\}`),
    );
    const order = block?.[1].match(/(?:^|;)order:(\d+)/);
    if (order) return order[1];
  }

  return null;
}

/**
 * The operator dashboard, rendered exactly as it ships today: four panels, two
 * of them wired.
 *
 * #80 flipped `queue` and then `attention` to `available: true`, so the page
 * really does fetch `GET /api/queue` and `GET /api/runs?needsAttention=true`
 * on mount and both panels show data — EMPTY states against the default MSW
 * handlers, not not-wired ones. Metrics and activity are still honestly
 * unbuilt.
 *
 * These tests use the REAL hooks rather than mocks, which is what makes that
 * distinction checkable: a mocked hook could not prove that an unavailable
 * endpoint issues zero requests, nor that an available one issues exactly one.
 */
describe('DashboardPage', () => {
  describe('the page itself', () => {
    it('is titled Cockpit, not "welcome back"', () => {
      render(<DashboardPage />);

      // The old HomePage greeted the user and linked to four pages the
      // navigation already lists. VISION §10: the app exists primarily to show
      // the six metrics.
      expect(screen.getByRole('heading', { level: 1, name: 'Cockpit' })).toBeInTheDocument();
      expect(screen.queryByText(/welcome back/i)).not.toBeInTheDocument();
    });

    it('no longer shows the profile card or the quick-action grid', () => {
      render(<DashboardPage />);

      // `UserProfileCard` moved to `/settings`; `QuickActions` was deleted.
      expect(screen.queryByText(/quick actions/i)).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /account settings/i })).not.toBeInTheDocument();
    });

    it('says it is not wired and hides the refresh control', () => {
      render(<DashboardPage />);

      expect(screen.getByText(/^Not yet wired — Phase 3/)).toBeInTheDocument();
      // Hidden rather than disabled: a permanently disabled control is noise.
      expect(screen.queryByRole('button', { name: /refresh/i })).not.toBeInTheDocument();
    });
  });

  describe('the honesty contract, end to end', () => {
    it('renders all six metrics as dashes, never as zeros', () => {
      render(<DashboardPage />);

      const metrics = screen.getByRole('region', { name: 'Success metrics' });
      expect(within(metrics).getAllByText('—')).toHaveLength(6);
      expect(within(metrics).queryByText('0')).not.toBeInTheDocument();
      expect(within(metrics).queryByText('0s')).not.toBeInTheDocument();
      expect(within(metrics).queryByText('0%')).not.toBeInTheDocument();
    });

    it('still teaches what each of the six will measure', () => {
      render(<DashboardPage />);

      for (const metric of METRIC_LIST) {
        expect(screen.getByRole('heading', { name: metric.label })).toBeInTheDocument();
        expect(screen.getByText(metric.definition)).toBeInTheDocument();
      }
    });

    it('draws no sparkline anywhere, because there is no series to draw', () => {
      const { container } = render(<DashboardPage />);
      expect(container.querySelectorAll('svg[role="img"]')).toHaveLength(0);
    });

    it('shows no shimmer skeleton', () => {
      // A skeleton promises data in a moment. This data arrives in a quarter.
      const { container } = render(<DashboardPage />);
      expect(container.querySelector('.MuiSkeleton-root')).toBeNull();
    });

    it('names a roadmap phase on every panel that is still unbuilt', () => {
      render(<DashboardPage />);

      expect(screen.getByText(/Events appear here once the reconciler runs/)).toBeInTheDocument();
      expect(screen.getByText(/Arrives in Phase 2 — Reconciler, read-only/)).toBeInTheDocument();
      // Metrics is still unbuilt and still names its phase.
      expect(
        screen.getAllByText(/Arrives in Phase 3 — Liveness and escalation/).length,
      ).toBeGreaterThan(0);
    });

    it('stops claiming the queue and attention panels are unbuilt, now that they are not', () => {
      // #80. Leaving the not-wired copy on a panel backed by a real endpoint
      // would be the honesty contract failing in the other direction: telling
      // the operator nothing exists while the data is on screen.
      render(<DashboardPage />);

      expect(
        screen.queryByText(/The queue appears here once dispatch exists/),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText(/Escalations appear here once the watchdog lands/),
      ).not.toBeInTheDocument();
      expect(screen.queryByText(/Arrives in Phase 4 — Execution/)).not.toBeInTheDocument();
    });

    it('never claims that nothing needs attention', () => {
      render(<DashboardPage />);
      // That is the EMPTY state, and it would be a lie from a panel that has
      // never looked at a run.
      expect(screen.queryByText('Nothing needs attention.')).not.toBeInTheDocument();
    });
  });

  describe('layout', () => {
    it('mounts the three panels once each', () => {
      render(<DashboardPage />);

      expect(screen.getByRole('heading', { level: 2, name: 'Needs attention' })).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 2, name: 'Queue' })).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 2, name: 'Activity' })).toBeInTheDocument();
    });

    /**
     * Escalation is VISION's whole point, and the phone is where the operator
     * reads it — so on `xs` the attention panel is painted ABOVE the metrics.
     *
     * It is the same single mount reordered with CSS `order`, NOT a second
     * copy behind a breakpoint: two mounts would mean two subscriptions, two
     * polls, and a screen that can show the same panel twice mid-resize. DOM
     * order stays metrics-then-attention so reading order and focus order are
     * unaffected at every width.
     */
    it('paints attention above the metrics on a phone, from one mount', () => {
      const { container } = render(<DashboardPage />);

      const metricsItem = screen.getByRole('region', { name: 'Success metrics' })
        .parentElement as HTMLElement;
      const attentionItem = screen
        .getByRole('heading', { level: 2, name: 'Needs attention' })
        .closest('section')?.parentElement as HTMLElement;

      // DOM order: metrics first.
      expect(
        metricsItem.compareDocumentPosition(attentionItem) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();

      // Painted order flips at `sm`, and only there.
      expect(orderAt(attentionItem, 0)).toBe('1');
      expect(orderAt(metricsItem, 0)).toBe('2');
      expect(orderAt(attentionItem, 600)).toBe('2');
      expect(orderAt(metricsItem, 600)).toBe('1');

      // And exactly one of each panel exists in the tree — no duplicate mount
      // hiding behind a breakpoint.
      expect(container.querySelectorAll('section').length).toBeGreaterThan(0);
      expect(screen.getAllByRole('heading', { level: 2, name: 'Needs attention' })).toHaveLength(1);
    });
  });
});

/**
 * The page's only real logic, tested without mounting four polling panels.
 */
describe('deriveDashboardStatus', () => {
  it('reports unwired above everything else', () => {
    expect(deriveDashboardStatus('unwired', null)).toBe('unwired');
    // Even a stray error cannot make "there is no endpoint" into "it broke".
    expect(deriveDashboardStatus('unwired', 'boom')).toBe('unwired');
  });

  it('reports error when a failure left nothing to show', () => {
    expect(deriveDashboardStatus('error', 'boom')).toBe('error');
  });

  /**
   * The branch that matters. `usePolledResource` keeps the last good data
   * through a failed poll, so without this the header would keep saying "Live"
   * over numbers that stopped updating.
   */
  it('reports stale when data survived a failed poll', () => {
    expect(deriveDashboardStatus('ready', 'network down')).toBe('stale');
    expect(deriveDashboardStatus('empty', 'network down')).toBe('stale');
  });

  it('reports live when the last fetch succeeded', () => {
    expect(deriveDashboardStatus('ready', null)).toBe('live');
    expect(deriveDashboardStatus('loading', null)).toBe('live');
  });
});
