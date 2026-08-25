/**
 * The note field's reset contract (#185) — see RevokeGrantDialog.test.tsx for
 * the reasoning. The demote dialog is reused across classes the same way.
 */
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';
import { DemoteClassDialog } from '../../../components/trust/DemoteClassDialog';

function noteField() {
  return screen.getByLabelText(/why \(optional\)/i);
}

describe('DemoteClassDialog — note reset', () => {
  const props = {
    open: true,
    className: 'Lint fixes',
    manualHoldDays: 14,
    isDemoting: false,
    onCancel: vi.fn(),
    onConfirm: vi.fn(),
  };

  it('opens with an empty note', () => {
    render(<DemoteClassDialog {...props} />);
    expect(noteField()).toHaveValue('');
  });

  it('clears a typed note when reopened for a different class', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<DemoteClassDialog {...props} />);

    await user.type(noteField(), 'regressed twice this week');

    rerender(<DemoteClassDialog {...props} open={false} />);
    rerender(
      <DemoteClassDialog {...props} open className="Dependency bumps" />,
    );

    expect(noteField()).toHaveValue('');
  });

  it('leaves the note alone while the dialog stays open', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<DemoteClassDialog {...props} />);

    await user.type(noteField(), 'still typing');
    rerender(<DemoteClassDialog {...props} manualHoldDays={21} />);

    expect(noteField()).toHaveValue('still typing');
  });
});
