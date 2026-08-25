/**
 * The note field's reset contract (#185).
 *
 * The dialog is mounted once by the page and reused for every row, so the
 * field is cleared on the closed -> open edge rather than on unmount. That
 * used to be a `useEffect`; it is now adjusted during render, and these tests
 * pin the behaviour that must not change either way — including the half of
 * it an effect got wrong, where the previous note was on screen for a frame.
 */
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';
import { RevokeGrantDialog } from '../../../components/trust/RevokeGrantDialog';

function noteField() {
  return screen.getByLabelText(/why \(optional\)/i);
}

describe('RevokeGrantDialog — note reset', () => {
  const props = {
    open: true,
    scope: 'linting on acme/widgets',
    isRevoking: false,
    onCancel: vi.fn(),
    onConfirm: vi.fn(),
  };

  it('opens with an empty note', () => {
    render(<RevokeGrantDialog {...props} />);
    expect(noteField()).toHaveValue('');
  });

  it('clears a typed note when reopened for a different grant', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<RevokeGrantDialog {...props} />);

    await user.type(noteField(), 'wrong repository');
    expect(noteField()).toHaveValue('wrong repository');

    rerender(<RevokeGrantDialog {...props} open={false} />);
    rerender(<RevokeGrantDialog {...props} open scope="tests on acme/other" />);

    expect(noteField()).toHaveValue('');
  });

  it('leaves the note alone while the dialog stays open', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<RevokeGrantDialog {...props} />);

    await user.type(noteField(), 'still typing');
    // A parent re-render — a poll landing, a prop identity change — must not
    // count as a reopen.
    rerender(<RevokeGrantDialog {...props} isRevoking />);

    expect(noteField()).toHaveValue('still typing');
  });

  it('passes the trimmed note to onConfirm, and undefined when blank', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<RevokeGrantDialog {...props} onConfirm={onConfirm} />);

    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    expect(onConfirm).toHaveBeenCalledWith(undefined);

    await user.type(noteField(), '  compromised  ');
    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    expect(onConfirm).toHaveBeenLastCalledWith('compromised');
  });
});
