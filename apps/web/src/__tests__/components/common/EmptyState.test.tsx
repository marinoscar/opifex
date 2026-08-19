import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../../utils/test-utils';
import { EmptyState } from '../../../components/common/EmptyState';
import { NotWiredState } from '../../../components/common/NotWiredState';

describe('EmptyState', () => {
  it('states the finding as a fact', () => {
    render(<EmptyState title="Nothing needs attention." />);
    expect(screen.getByText('Nothing needs attention.')).toBeInTheDocument();
  });

  it('renders the optional detail and action when given them', () => {
    render(
      <EmptyState
        title="Nothing needs attention."
        detail="Every run is progressing."
        action={<button type="button">View all runs</button>}
      />,
    );

    expect(screen.getByText('Every run is progressing.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View all runs' })).toBeInTheDocument();
  });

  it('omits the detail and action when not given them', () => {
    render(<EmptyState title="The queue is empty." />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('keeps its icon out of the accessibility tree', () => {
    // Everything the icon conveys is in the title beside it; an announced
    // "check circle icon" is noise on the panel most likely to be skimmed.
    const { container } = render(<EmptyState title="All clear." />);
    expect(container.querySelector('[aria-hidden="true"]')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });
});

/**
 * The reason these are two components rather than one with a `variant`.
 *
 * On the attention panel, "no escalations because nothing needs attention" and
 * "no escalations because the watchdog does not exist" are OPPOSITE claims. An
 * operator who reads the second as the first has been reassured by a component
 * that has never looked at a run. If a future refactor makes these render
 * alike, this suite is what should stop it.
 */
describe('EmptyState versus NotWiredState', () => {
  it('says different things about the world', () => {
    const { container: empty } = render(<EmptyState title="Nothing needs attention." />);
    const { container: unwired } = render(
      <NotWiredState
        variant="compact"
        title="Escalations appear here once the watchdog lands"
        detail="Nothing is watching runs yet."
        phase="Phase 3 — Liveness and escalation"
      />,
    );

    // Only one of them names a roadmap phase, because only one of them is
    // making a claim about the future rather than about the runs.
    expect(unwired.textContent).toContain('Arrives in Phase 3');
    expect(empty.textContent).not.toContain('Arrives in');
  });

  it('is drawn differently: solid and confident versus dashed and recessive', () => {
    const { container: empty } = render(<EmptyState title="Nothing needs attention." />);
    const { container: unwired } = render(
      <NotWiredState variant="compact" title="Not wired" detail="Not yet." phase="Phase 3" />,
    );

    const emptyStyle = getComputedStyle(empty.firstElementChild as Element);
    const unwiredStyle = getComputedStyle(unwired.firstElementChild as Element);

    expect(unwiredStyle.border).toContain('dashed');
    expect(emptyStyle.border).not.toContain('dashed');
  });
});
