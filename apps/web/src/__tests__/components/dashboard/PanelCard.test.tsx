import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../../utils/test-utils';
import { PanelCard } from '../../../components/dashboard/PanelCard';

/**
 * `PanelCard` is the SINGLE place a `ResourceState` becomes a panel body. The
 * point of centralising it is not code volume — it is that the
 * unwired/empty distinction cannot be got right in one panel and wrong in
 * another. These assertions are the switch's specification.
 */
function renderPanel(props: Partial<React.ComponentProps<typeof PanelCard>> = {}) {
  return render(
    <PanelCard
      title="Needs attention"
      state="ready"
      emptyContent={<p>EMPTY BODY</p>}
      unwiredContent={<p>UNWIRED BODY</p>}
      {...props}
    >
      <p>READY BODY</p>
    </PanelCard>,
  );
}

describe('PanelCard', () => {
  it('always renders its title as a level-2 heading', () => {
    renderPanel();
    expect(screen.getByRole('heading', { level: 2, name: 'Needs attention' })).toBeInTheDocument();
  });

  it('renders the subtitle and the header action when given them', () => {
    renderPanel({ subtitle: 'What a human has to touch.', action: <button type="button">All runs</button> });

    expect(screen.getByText('What a human has to touch.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'All runs' })).toBeInTheDocument();
  });

  describe('state to body mapping', () => {
    it('unwired renders the unwired content only', () => {
      renderPanel({ state: 'unwired' });
      expect(screen.getByText('UNWIRED BODY')).toBeInTheDocument();
      expect(screen.queryByText('EMPTY BODY')).not.toBeInTheDocument();
      expect(screen.queryByText('READY BODY')).not.toBeInTheDocument();
    });

    it('empty renders the empty content only', () => {
      renderPanel({ state: 'empty' });
      expect(screen.getByText('EMPTY BODY')).toBeInTheDocument();
      expect(screen.queryByText('UNWIRED BODY')).not.toBeInTheDocument();
    });

    it('ready renders the children', () => {
      renderPanel({ state: 'ready' });
      expect(screen.getByText('READY BODY')).toBeInTheDocument();
    });

    it('loading renders a spinner and no body', () => {
      renderPanel({ state: 'loading' });
      expect(screen.getByRole('progressbar')).toBeInTheDocument();
      expect(screen.queryByText('READY BODY')).not.toBeInTheDocument();
    });

    it('error renders the message as an alert', () => {
      renderPanel({ state: 'error', error: 'network down' });
      expect(screen.getByRole('alert')).toHaveTextContent('network down');
    });

    it('error falls back to a generic message rather than an empty alert', () => {
      renderPanel({ state: 'error' });
      expect(screen.getByRole('alert')).toHaveTextContent(/could not load/i);
    });
  });

  describe('stale data', () => {
    /**
     * `usePolledResource` keeps the last good data through a failed poll, so a
     * failed re-poll arrives here as `ready` WITH an error. The rows must
     * survive: an operator mid-triage does not lose the screen they were
     * reading because one request timed out.
     */
    it('keeps showing the rows and warns above them', () => {
      renderPanel({ state: 'ready', error: 'network down' });

      expect(screen.getByText('READY BODY')).toBeInTheDocument();
      const banner = screen.getByRole('status');
      expect(banner).toHaveTextContent(/last known data/i);
      expect(banner).toHaveTextContent('network down');
    });

    it('warns rather than errors, because what is on screen is still true', () => {
      renderPanel({ state: 'ready', error: 'network down' });
      // If a stale banner claimed `role="alert"` the operator would learn to
      // ignore the genuinely red one.
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('shows no banner when there is no error', () => {
      renderPanel({ state: 'ready', error: null });
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });
  });
});
