import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../../utils/test-utils';
import { NotWiredState } from '../../../components/common/NotWiredState';

/**
 * Epic #19. This component IS the honesty contract, so the suite tests the
 * contract rather than the markup.
 *
 * The failure this guards against is subtle and expensive: a cockpit that
 * looks like it is reporting on a system, while the system it is reporting on
 * does not exist yet. Every assertion below is one clause of "say what will be
 * here, say why it is not, and never imply a measurement".
 */
describe('NotWiredState', () => {
  const props = {
    title: 'Queue depth is unknown',
    detail: 'This will show what is waiting and why it has not started.',
    phase: 'Phase 4 — Execution',
  };

  it('says what will be here, and why it is not', () => {
    render(<NotWiredState {...props} />);

    expect(screen.getByText(props.title)).toBeInTheDocument();
    expect(screen.getByText(props.detail)).toBeInTheDocument();
  });

  it('names the roadmap phase that will supply the data', () => {
    // "Coming soon" is not a claim anyone can check. "Phase 4 — Execution" is.
    render(<NotWiredState {...props} />);

    expect(screen.getByText(/Phase 4 — Execution/)).toBeInTheDocument();
  });

  it('wires the explanation to the title with aria-describedby', () => {
    // Clause 6: NOT `aria-hidden`. A screen reader user gets the same "why is
    // this empty" answer a sighted user gets from the caption underneath.
    render(<NotWiredState {...props} />);

    const title = screen.getByText(props.title);
    const describedBy = title.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();

    const described = describedBy!
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent ?? '');
    expect(described.join(' ')).toContain(props.detail);
    expect(described.join(' ')).toContain(props.phase);
  });

  it('leaves the whole state visible to assistive technology', () => {
    const { container } = render(<NotWiredState {...props} />);

    expect(container.querySelector('[aria-hidden="true"][role]')).toBeNull();
    expect(screen.getByText(props.title)).toBeVisible();
  });

  it('hides the decorative glyph, which conveys nothing the text does not', () => {
    const { container } = render(<NotWiredState {...props} />);

    const icon = container.querySelector('svg');
    expect(icon).toHaveAttribute('aria-hidden', 'true');
  });

  it('never renders a number standing in for a measurement', () => {
    // Clause 1, as a regression guard: the day someone adds a "0 items" line
    // here it stops being an unwired state and becomes a false report.
    const { container } = render(<NotWiredState {...props} />);

    expect(container.textContent).not.toMatch(/\b0\b/);
  });
});
